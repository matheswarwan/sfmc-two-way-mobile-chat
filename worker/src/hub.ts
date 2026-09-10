import { DurableObject } from 'cloudflare:workers';
import { DurableObjectConversationStore } from './doStore.js';
import { configFromEnv, type Env } from './config.js';
import { RestSfmcClient, normaliseNumber, type SfmcClient } from '../../server/src/sfmc/client.js';
import { ClientCredentialsTokenProvider } from '../../server/src/auth/tokenProvider.js';
import { InboundIngest } from '../../server/src/inbound/ingest.js';
import { InboundPoller } from '../../server/src/inbound/poller.js';
import { RealtimeHub } from '../../server/src/realtime/hub.js';
import { resolveCode } from '../../server/src/config/index.js';
import type { Config } from '../../server/src/config/index.js';
import type { InboundMessage } from '../../server/src/domain/types.js';

/**
 * Owns all conversation state and every open browser connection.
 *
 * A single Durable Object is the right shape here: conversation state must be
 * consistent, and a reply has to reach whichever tab is watching. Its SQLite
 * storage is synchronous, so the store, ingest and poller port over unchanged
 * from the Node server.
 */
export class ConversationHub extends DurableObject<Env> {
  #store: DurableObjectConversationStore;
  #hub = new RealtimeHub();
  #config: Config;
  #client: SfmcClient;
  #ingest: InboundIngest;
  #poller: InboundPoller;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.#store = new DurableObjectConversationStore(ctx.storage.sql);
    this.#config = configFromEnv(env);
    this.#client = new RestSfmcClient(
      this.#config,
      new ClientCredentialsTokenProvider(this.#config),
    );
    this.#ingest = new InboundIngest(this.#store, this.#hub);
    this.#poller = new InboundPoller({
      client: this.#client,
      ingest: this.#ingest,
      // Workers cannot hold a timer, so the cron trigger drives tick() instead.
      intervalMs: 60_000,
      shortCode: this.#config.sfmc.shortCode,
    });

    // Re-attach sockets that survived hibernation.
    for (const socket of ctx.getWebSockets()) this.#attach(socket);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') return this.#openSocket();

    switch (`${request.method} ${url.pathname}`) {
      case 'GET /api/conversations':
        return json({ conversations: this.#store.listConversations() });

      case 'POST /api/messages':
        return this.#send(await request.json());

      case 'POST /inbound/ampscript':
        return this.#inbound(request, await request.text());

      case 'POST /internal/poll': {
        // Driven by the cron trigger, since a Worker cannot hold a timer.
        const accepted = await this.#poller.tick();
        return json({ accepted });
      }

      default:
        break;
    }

    const messages = /^\/api\/conversations\/([^/]+)\/messages$/.exec(url.pathname);
    if (messages && request.method === 'GET') {
      const conversation = this.#store.getConversation(messages[1]!);
      if (!conversation) return json({ error: 'Not found' }, 404);
      return json({ conversation, messages: this.#store.listMessages(conversation.id) });
    }

    const read = /^\/api\/conversations\/([^/]+)\/read$/.exec(url.pathname);
    if (read && request.method === 'POST') {
      this.#store.markRead(read[1]!);
      return json({ ok: true });
    }

    return json({ error: 'Not found' }, 404);
  }

  /** Called from the cron trigger: pull new inbound rows. */
  async poll(): Promise<number> {
    return this.#poller.tick();
  }

  #openSocket(): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // Hibernation lets the object sleep while sockets stay open, so an idle
    // conversation costs nothing.
    this.ctx.acceptWebSocket(server);
    this.#attach(server);
    server.send(JSON.stringify({ type: 'ready' }));

    return new Response(null, { status: 101, webSocket: client });
  }

  #attach(socket: WebSocket): void {
    this.#hub.subscribe({
      send: (payload) => {
        try {
          socket.send(payload);
        } catch {
          // A dead socket must not break the ingest that triggered the send.
        }
      },
    });
  }

  async #send(body: unknown): Promise<Response> {
    const input = (body ?? {}) as { mobileNumber?: string; text?: string; shortCode?: string };
    const mobileNumber = normaliseNumber(input.mobileNumber ?? '');
    const text = (input.text ?? '').trim();

    if (!mobileNumber) return json({ error: 'mobileNumber is required' }, 400);
    if (!text) return json({ error: 'text is required' }, 400);

    const target = resolveCode(this.#config, input.shortCode);
    if (!target) return json({ error: 'No messaging code is configured.' }, 400);

    const conversation = this.#store.ensureConversation({
      channel: 'sms',
      mobileNumber,
      channelAddress: target.code,
    });

    // Record optimistically so the agent sees their message at once, then
    // reconcile with whatever SFMC says.
    const message = this.#store.addMessage({
      conversationId: conversation.id,
      channel: 'sms',
      direction: 'outbound',
      body: text,
      status: 'pending',
    });
    this.#hub.broadcast({ type: 'message.created', message, conversation });

    try {
      const result = await this.#client.sendSms(mobileNumber, text, target.code);
      this.#store.updateStatus(message.id, 1000);
      const updated = this.#store.setProviderMessageId(message.id, result.tokenId) ?? message;
      this.#hub.broadcast({ type: 'message.updated', message: updated });
      return json({ message: updated });
    } catch (error) {
      const failed =
        this.#store.markFailed(message.id, error instanceof Error ? error.message : String(error)) ??
        message;
      this.#hub.broadcast({ type: 'message.updated', message: failed });
      return json({ error: failed.error, message: failed }, 502);
    }
  }

  #inbound(request: Request, raw: string): Response {
    if (request.headers.get('x-chat-secret') !== this.#config.inboundWebhookSecret) {
      return json({ error: 'unauthorized' }, 401);
    }

    const body = JSON.parse(raw) as {
      mobileNumber?: string;
      body?: string;
      shortCode?: string;
      messageId?: string;
      receivedAt?: string;
    };

    const mobileNumber = normaliseNumber(body.mobileNumber ?? '');
    if (!mobileNumber) return json({ error: 'mobileNumber is required' }, 400);

    const receivedAt = body.receivedAt ?? new Date().toISOString();
    const inbound: InboundMessage = {
      channel: 'sms',
      mobileNumber,
      channelAddress: body.shortCode ?? this.#config.sfmc.shortCode,
      body: body.body ?? '',
      receivedAt,
      dedupeKey: `sms:${body.messageId ?? `${mobileNumber}:${receivedAt}`}`,
      source: 'ampscript-webhook',
    };

    const result = this.#ingest.ingest(inbound);
    return json({ accepted: result.accepted, reason: result.reason }, 202);
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
