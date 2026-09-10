import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { Config } from './config/index.js';
import { resolveCode } from './config/index.js';
import type { SfmcClient, SubscriptionRecord } from './sfmc/client.js';
import { assertSendableNumber, normaliseNumber, subscriptionFor } from './sfmc/client.js';
import type { ConversationStore } from './conversations/store.js';
import type { InboundIngest } from './inbound/ingest.js';
import type { RealtimeHub } from './realtime/hub.js';
import type { Conversation, InboundMessage } from './domain/types.js';
import type { SfmcProvisioner } from './sfmc/provisioning.js';
import type { InboundPoller } from './inbound/poller.js';
import { SetupStatusService } from './setup/status.js';
import { registerSetupRoutes } from './setup/routes.js';
import type { EnsService } from './ens/service.js';
import { registerEnsRoutes } from './ens/routes.js';

export interface BuildServerDeps {
  config: Config;
  client: SfmcClient;
  store: ConversationStore;
  ingest: InboundIngest;
  hub: RealtimeHub;
  provisioner: SfmcProvisioner;
  poller: InboundPoller;
  ens: EnsService;
}

/**
 * How long to wait for SFMC to process a queued opt-in before giving up on
 * confirming it.
 *
 * queueMO is asynchronous: it returns 202 and the subscription appears a
 * moment later. Waiting a little turns "we asked" into "it worked", which is
 * the difference between an agent typing into a thread that can deliver and
 * one that silently cannot.
 */
const OPT_IN_CONFIRM_TIMEOUT_MS = 12_000;
const OPT_IN_POLL_INTERVAL_MS = 1_500;

export async function buildServer(deps: BuildServerDeps): Promise<FastifyInstance> {
  const { config, client, store, ingest, hub, provisioner, poller, ens } = deps;
  const app = Fastify({ logger: true });

  await app.register(websocket);

  /**
   * Keep the raw JSON body alongside the parsed one.
   *
   * ENS signs the exact bytes it sends, so verifying against a re-serialised
   * object would never match.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    (request as typeof request & { rawBody?: string }).rawBody = body as string;
    try {
      done(null, body === '' ? undefined : JSON.parse(body as string));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  /**
   * SFMC loads a Marketing Cloud App inside an iframe, so the app must permit
   * framing by exacttarget.com. Fastify sends no framing headers by default;
   * this is explicit so the requirement is visible rather than accidental.
   */
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Content-Security-Policy', "frame-ancestors 'self' https://*.exacttarget.com");
    reply.removeHeader('X-Frame-Options');
  });

  registerEnsRoutes(app, { ens, store, hub });

  registerSetupRoutes(app, {
    config,
    provisioner,
    poller,
    store,
    ens,
    status: new SetupStatusService(config, client, provisioner, ens),
  });

  app.get('/health', async () => ({
    ok: true,
    mode: config.mode,
    realtimeClients: hub.size,
  }));

  /**
   * What the chat screen needs to render its controls: which codes exist and
   * which keyword a contact is opted in to.
   */
  app.get('/api/config', async () => ({
    mode: config.mode,
    keyword: config.sfmc.keyword,
    canSend: config.messaging.canSend,
    codes: config.sfmc.codes.map((code) => ({
      code: code.code,
      countryCode: code.countryCode,
    })),
  }));

  // --- conversations ---

  app.get('/api/conversations', async () => ({
    conversations: store.listConversations(),
  }));

  /**
   * Add a number to the chat.
   *
   * Opting in comes first and is not optional: MobileConnect only delivers to
   * numbers holding a Subscribed status on the code, so a thread created
   * without it looks fine and silently fails on the first send.
   */
  app.post<{ Body: { mobileNumber?: string; shortCode?: string; subscriberKey?: string } }>(
    '/api/conversations',
    async (request, reply) => {
      const mobileNumber = normaliseNumber(request.body?.mobileNumber ?? '');
      if (!mobileNumber) return reply.code(400).send({ error: 'mobileNumber is required' });

      try {
        assertSendableNumber(mobileNumber);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }

      const target = resolveCode(config, request.body?.shortCode);
      if (!target) {
        return reply.code(400).send({
          error: request.body?.shortCode
            ? `"${request.body.shortCode}" is not one of the configured codes.`
            : 'No short or long code is configured. Open the setup screen to finish provisioning.',
        });
      }

      const keyword = config.sfmc.keyword;
      const subscriberKey = request.body?.subscriberKey?.trim();

      // The opt-in text is the keyword, and MobileConnect will route it to the
      // Text Response like any reply. Drop that echo from the thread.
      ingest.suppressEcho(mobileNumber, keyword);

      try {
        await client.optIn({
          mobileNumber,
          shortCode: target.code,
          keyword,
          ...(subscriberKey ? { subscriberKey } : {}),
        });
      } catch (error) {
        return reply.code(502).send({
          error: `Could not opt ${mobileNumber} in to "${keyword}" on ${target.code}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }

      const subscription = await confirmOptIn(client, mobileNumber, target.code);

      const conversation = store.ensureConversation({
        channel: 'sms',
        mobileNumber,
        channelAddress: target.code,
        ...(subscriberKey ? { contactKey: subscriberKey } : {}),
      });
      store.updateContact(conversation.id, {
        subscriptionStatus: subscription?.status ?? 'in_progress',
      });

      hub.broadcast({ type: 'conversation.updated', conversation });

      return reply.code(201).send({
        conversation,
        optIn: {
          keyword,
          shortCode: target.code,
          confirmed: subscription?.status === 'subscribed',
          detail:
            subscription?.status === 'subscribed'
              ? `${mobileNumber} is subscribed to "${keyword}" on ${target.code}.`
              : `The opt-in was queued but SFMC had not confirmed it after ${
                  OPT_IN_CONFIRM_TIMEOUT_MS / 1000
                } seconds. It usually lands shortly; the first send will fail until it does.`,
        },
      });
    },
  );

  app.get<{ Params: { id: string } }>('/api/conversations/:id/messages', async (request, reply) => {
    const conversation = store.getConversation(request.params.id);
    if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });
    return { conversation, messages: store.listMessages(conversation.id) };
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/read', async (request, reply) => {
    if (!store.getConversation(request.params.id)) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }
    store.markRead(request.params.id);
    return { ok: true };
  });

  // --- subscriber lookup ---

  /**
   * Find an existing subscriber to start a conversation with, by email or
   * phone number. Only records that have a phone number can be chatted to, so
   * only those come back.
   */
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/api/subscribers/search',
    async (request, reply) => {
      const query = (request.query.q ?? '').trim();
      if (query.length < 3) {
        return reply.code(400).send({ error: 'Search for at least 3 characters' });
      }

      const limit = Math.min(Number(request.query.limit ?? 20) || 20, 50);

      try {
        return { results: await client.searchSubscribers(query, limit) };
      } catch (error) {
        return reply.code(502).send({
          error: `Subscriber search failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    },
  );

  app.post<{ Body: { mobileNumbers?: string[] } }>(
    '/api/subscriptions/check',
    async (request, reply) => {
      const numbers = request.body?.mobileNumbers ?? [];
      if (!Array.isArray(numbers) || numbers.length === 0) {
        return reply.code(400).send({ error: 'mobileNumbers must be a non-empty array' });
      }
      return { subscriptions: await client.getSubscriptionStatus(numbers) };
    },
  );

  // --- outbound ---

  app.post<{ Body: { mobileNumber?: string; text?: string; shortCode?: string } }>(
    '/api/messages',
    async (request, reply) => {
      const mobileNumber = normaliseNumber(request.body?.mobileNumber ?? '');
      const text = (request.body?.text ?? '').trim();

      if (!mobileNumber) return reply.code(400).send({ error: 'mobileNumber is required' });
      if (!text) return reply.code(400).send({ error: 'text is required' });

      // An existing thread already knows its code; a bare number falls back to
      // the requested one, then to the default.
      const existing = store.findConversationByNumber('sms', mobileNumber);
      const target = resolveCode(config, existing?.channelAddress ?? request.body?.shortCode);
      if (!target) {
        return reply
          .code(400)
          .send({ error: 'No short or long code is configured. Open the setup screen.' });
      }

      const conversation: Conversation =
        existing ??
        store.ensureConversation({
          channel: 'sms',
          mobileNumber,
          channelAddress: target.code,
        });

      // Record optimistically so the agent sees their message immediately, then
      // reconcile once SFMC accepts or rejects it.
      const message = store.addMessage({
        conversationId: conversation.id,
        channel: 'sms',
        direction: 'outbound',
        body: text,
        status: 'pending',
      });
      hub.broadcast({ type: 'message.created', message, conversation });

      try {
        const result = await client.sendSms(mobileNumber, text, target.code);
        store.updateStatus(message.id, 1000);
        // Persist explicitly: mutating the returned Message would be lost, as
        // the store hands back a detached copy of the row.
        const updated = store.setProviderMessageId(message.id, result.tokenId) ?? message;
        hub.broadcast({ type: 'message.updated', message: updated });
        return { message: updated };
      } catch (error) {
        const failed =
          store.markFailed(message.id, error instanceof Error ? error.message : String(error)) ??
          message;
        hub.broadcast({ type: 'message.updated', message: failed });
        return reply.code(502).send({ error: failed.error, message: failed });
      }
    },
  );

  // --- inbound webhook ---

  /**
   * Receives inbound SMS pushed by AMPscript from the Text Response message.
   *
   * Whether HttpPost2() actually fires from a MobileConnect message is not
   * documented by Salesforce either way, so this route is an optimisation that
   * must never be depended on: the Data Extension poller is the floor, and both
   * paths converge on the same idempotent ingest.
   *
   * Responds fast and does no downstream work inline, because a Text Response
   * body renders synchronously in the customer's reply path. A slow endpoint
   * here would delay their SMS.
   */
  app.post<{
    Body: {
      mobileNumber?: string;
      body?: string;
      shortCode?: string;
      messageId?: string;
      receivedAt?: string;
    };
    Headers: { 'x-chat-secret'?: string };
  }>('/inbound/ampscript', async (request, reply) => {
    if (request.headers['x-chat-secret'] !== config.inboundWebhookSecret) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const mobileNumber = normaliseNumber(request.body?.mobileNumber ?? '');
    const body = request.body?.body ?? '';
    if (!mobileNumber) return reply.code(400).send({ error: 'mobileNumber is required' });

    const receivedAt = request.body?.receivedAt ?? new Date().toISOString();
    const messageId = request.body?.messageId ?? `${mobileNumber}:${receivedAt}`;

    const inbound: InboundMessage = {
      channel: 'sms',
      mobileNumber,
      channelAddress: request.body?.shortCode ?? config.sfmc.shortCode,
      body,
      receivedAt,
      dedupeKey: `sms:${messageId}`,
      source: 'ampscript-webhook',
    };

    const result = ingest.ingest(inbound);
    return reply.code(202).send({ accepted: result.accepted, reason: result.reason });
  });

  // --- realtime ---

  app.get('/ws', { websocket: true }, (socket) => {
    const unsubscribe = hub.subscribe({ send: (payload) => socket.send(payload) });
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
    socket.send(JSON.stringify({ type: 'ready' }));
  });

  return app;
}

/**
 * Poll until SFMC reports the number as subscribed, or the budget runs out.
 *
 * A lookup failure is not treated as "not subscribed": the opt-in may well
 * have worked and only the check failed, so an unconfirmed result is reported
 * as unconfirmed rather than as a failure.
 */
async function confirmOptIn(
  client: SfmcClient,
  mobileNumber: string,
  shortCode: string,
): Promise<SubscriptionRecord | undefined> {
  const deadline = Date.now() + OPT_IN_CONFIRM_TIMEOUT_MS;

  for (;;) {
    try {
      const records = await client.getSubscriptionStatus([mobileNumber]);
      const match = subscriptionFor(records, mobileNumber, shortCode);
      if (match?.status === 'subscribed') return match;
    } catch {
      // Keep waiting; the opt-in itself already succeeded.
    }

    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, OPT_IN_POLL_INTERVAL_MS));
  }
}
