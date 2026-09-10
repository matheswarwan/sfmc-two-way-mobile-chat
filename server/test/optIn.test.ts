import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { EnsService } from '../src/ens/service.js';
import type { AccessToken, TokenProvider } from '../src/auth/tokenProvider.js';

/** Never used: ENS stays inert without a callback URL. */
class StaticTestTokenProvider implements TokenProvider {
  async getAccessToken(): Promise<AccessToken> {
    return {
      accessToken: 'test',
      restInstanceUrl: 'https://example.invalid',
      soapInstanceUrl: 'https://example.invalid',
      expiresAt: Date.now() + 60_000,
      scope: '',
    };
  }
}
import { loadConfig, resolveCode, type Config } from '../src/config/index.js';
import { MockSfmcClient } from '../src/sfmc/mockClient.js';
import { MockSfmcProvisioner } from '../src/sfmc/mockProvisioner.js';
import { InMemoryConversationStore } from '../src/conversations/store.js';
import { InboundIngest } from '../src/inbound/ingest.js';
import { InboundPoller } from '../src/inbound/poller.js';
import { RealtimeHub } from '../src/realtime/hub.js';

const ENV_KEYS = [
  'SFMC_MODE',
  'SFMC_SHORT_CODE',
  'SFMC_SHORT_CODES',
  'SFMC_COUNTRY_CODE',
  'SFMC_KEYWORD',
  'SFMC_DEFINITION_KEY',
] as const;

const savedEnv = new Map<string, string | undefined>();

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): Config {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  return loadConfig();
}

interface Harness {
  app: FastifyInstance;
  client: MockSfmcClient;
  store: InMemoryConversationStore;
  ingest: InboundIngest;
  poller: InboundPoller;
}

async function harness(config: Config): Promise<Harness> {
  const client = new MockSfmcClient();
  const store = new InMemoryConversationStore();
  const hub = new RealtimeHub();
  const ingest = new InboundIngest(store, hub);
  const poller = new InboundPoller({
    client,
    ingest,
    intervalMs: 60_000,
    shortCode: config.sfmc.shortCode,
  });
  const provisioner = new MockSfmcProvisioner(
    client,
    config.sfmc.codes.map((code) => code.code),
  );

  // ENS never reaches the network in these tests: no callback URL is set.
  const ens = new EnsService(config, new StaticTestTokenProvider());

  const app = await buildServer({ config, client, store, ingest, hub, provisioner, poller, ens });
  await app.ready();
  return { app, client, store, ingest, poller };
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('configured codes', () => {
  it('reads a single code from the original two variables', () => {
    const config = setEnv({ SFMC_SHORT_CODE: '86288', SFMC_COUNTRY_CODE: 'US' });

    expect(config.sfmc.codes).toEqual([
      { code: '86288', countryCode: 'US', definitionKey: 'sfmc-chat-outbound' },
    ]);
    // The single-code fields stay populated so existing callers are unaffected.
    expect(config.sfmc.shortCode).toBe('86288');
  });

  it('reads a list, and gives every code after the first its own definition', () => {
    const config = setEnv({ SFMC_SHORT_CODES: '86288:US,447700900123' });

    expect(config.sfmc.codes).toEqual([
      { code: '86288', countryCode: 'US', definitionKey: 'sfmc-chat-outbound' },
      { code: '447700900123', countryCode: '', definitionKey: 'sfmc-chat-outbound-447700900123' },
    ]);
  });

  it('resolves an absent code to the default and rejects an unknown one', () => {
    const config = setEnv({ SFMC_SHORT_CODES: '86288:US,447700900123' });

    expect(resolveCode(config)?.code).toBe('86288');
    expect(resolveCode(config, '447700900123')?.code).toBe('447700900123');
    expect(resolveCode(config, '99999')).toBeUndefined();
  });
});

describe('POST /api/conversations', () => {
  it('opts the number in to the keyword on the chosen code before opening a thread', async () => {
    const config = setEnv({ SFMC_SHORT_CODES: '86288:US,447700900123', SFMC_KEYWORD: 'CHAT' });
    const { app, client } = await harness(config);

    const response = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { mobileNumber: '44 7700 900999', shortCode: '447700900123' },
    });

    expect(response.statusCode).toBe(201);
    expect(client.optIns).toEqual([
      { mobileNumber: '447700900999', shortCode: '447700900123', keyword: 'CHAT' },
    ]);

    const body = response.json() as {
      conversation: { channelAddress: string; contact: { mobileNumber: string } };
      optIn: { confirmed: boolean };
    };
    expect(body.conversation.channelAddress).toBe('447700900123');
    expect(body.conversation.contact.mobileNumber).toBe('447700900999');
    expect(body.optIn.confirmed).toBe(true);

    await app.close();
  });

  it('refuses a code the account does not own rather than falling back', async () => {
    const config = setEnv({ SFMC_SHORT_CODES: '86288:US' });
    const { app, client } = await harness(config);

    const response = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { mobileNumber: '447700900999', shortCode: '99999' },
    });

    expect(response.statusCode).toBe(400);
    // Nothing was opted in, so no stray subscription was created.
    expect(client.optIns).toHaveLength(0);

    await app.close();
  });

  it('rejects a number SFMC would reject, naming the reason', async () => {
    const config = setEnv({ SFMC_SHORT_CODE: '86288' });
    const { app } = await harness(config);

    const response = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { mobileNumber: '1234' },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toMatch(/country code/i);

    await app.close();
  });

  it('keeps the opt-in keyword out of the thread it just created', async () => {
    const config = setEnv({ SFMC_SHORT_CODE: '86288', SFMC_KEYWORD: 'CHAT' });
    const { app, client, store, poller } = await harness(config);

    await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { mobileNumber: '447700900999' },
    });

    // What a correctly wired Text Response writes when the opt-in MO arrives.
    // Timestamps are explicit because the poller advances a high-water mark.
    client.pushInboundRow({
      mobileNumber: '447700900999',
      body: 'CHAT',
      shortCode: '86288',
      receivedAt: '2999-01-01T10:00:00.000Z',
      messageId: 'mo-optin-echo',
    });
    await poller.tick();

    const conversation = store.findConversationByNumber('sms', '447700900999');
    expect(store.listMessages(conversation!.id)).toHaveLength(0);

    // The suppression is one-shot: a customer who later types the keyword is shown.
    client.pushInboundRow({
      mobileNumber: '447700900999',
      body: 'CHAT',
      shortCode: '86288',
      receivedAt: '2999-01-01T10:05:00.000Z',
      messageId: 'mo-real-chat',
    });
    await poller.tick();
    expect(store.listMessages(conversation!.id)).toHaveLength(1);

    await app.close();
  });

  it('sends on the code the thread belongs to, not the default', async () => {
    const config = setEnv({ SFMC_SHORT_CODES: '86288:US,447700900123' });
    const { app, client } = await harness(config);

    await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { mobileNumber: '447700900999', shortCode: '447700900123' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: { mobileNumber: '447700900999', text: 'hello' },
    });

    expect(client.sent).toEqual([
      expect.objectContaining({ mobileNumber: '447700900999', shortCode: '447700900123' }),
    ]);

    await app.close();
  });
});

describe('GET /api/subscribers/search', () => {
  it('finds a subscriber by part of their email address', async () => {
    const config = setEnv({ SFMC_SHORT_CODE: '86288' });
    const { app, client } = await harness(config);

    client.addSubscriber({
      mobileNumber: '447700900123',
      subscriberKey: 'jo.rivera@example.com',
      emailAddress: 'jo.rivera@example.com',
      subscriptions: [
        { mobileNumber: '447700900123', shortCode: '86288', status: 'subscribed' },
      ],
    });

    const response = await app.inject({ method: 'GET', url: '/api/subscribers/search?q=rivera' });

    expect(response.statusCode).toBe(200);
    const { results } = response.json() as { results: Array<{ mobileNumber: string }> };
    expect(results).toHaveLength(1);
    expect(results[0]?.mobileNumber).toBe('447700900123');

    await app.close();
  });

  it('finds the same subscriber by their number', async () => {
    const config = setEnv({ SFMC_SHORT_CODE: '86288' });
    const { app, client } = await harness(config);

    client.addSubscriber({
      mobileNumber: '447700900123',
      emailAddress: 'jo.rivera@example.com',
      subscriptions: [],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/subscribers/search?q=447700900123',
    });

    const { results } = response.json() as { results: Array<{ emailAddress?: string }> };
    expect(results[0]?.emailAddress).toBe('jo.rivera@example.com');

    await app.close();
  });

  it('will not run a search too short to be meaningful', async () => {
    const config = setEnv({ SFMC_SHORT_CODE: '86288' });
    const { app } = await harness(config);

    const response = await app.inject({ method: 'GET', url: '/api/subscribers/search?q=jo' });
    expect(response.statusCode).toBe(400);

    await app.close();
  });
});
