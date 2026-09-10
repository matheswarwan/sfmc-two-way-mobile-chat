import { describe, it, expect, beforeEach } from 'vitest';
import { MockSfmcClient } from '../src/sfmc/mockClient.js';
import { SfmcApiError } from '../src/sfmc/client.js';
import { stubClient } from './helpers.js';
import { InMemoryConversationStore } from '../src/conversations/store.js';
import { InboundIngest } from '../src/inbound/ingest.js';
import { InboundPoller } from '../src/inbound/poller.js';
import { RealtimeHub } from '../src/realtime/hub.js';

describe('InboundPoller', () => {
  let client: MockSfmcClient;
  let store: InMemoryConversationStore;
  let poller: InboundPoller;

  beforeEach(() => {
    client = new MockSfmcClient();
    store = new InMemoryConversationStore();
    const ingest = new InboundIngest(store, new RealtimeHub());
    poller = new InboundPoller({
      client,
      ingest,
      intervalMs: 1000,
      shortCode: '86288',
      since: '2026-01-01T00:00:00.000Z',
    });
  });

  it('ingests new rows written by the Text Response message', async () => {
    client.pushInboundRow({
      mobileNumber: '13175551212',
      body: 'yes please',
      shortCode: '86288',
      receivedAt: '2026-01-01T10:00:00.000Z',
      messageId: 'mo-1',
    });

    expect(await poller.tick()).toBe(1);
    expect(store.listConversations()).toHaveLength(1);
  });

  it('does not re-ingest rows it has already seen', async () => {
    client.pushInboundRow({
      mobileNumber: '13175551212',
      body: 'first',
      shortCode: '86288',
      receivedAt: '2026-01-01T10:00:00.000Z',
      messageId: 'mo-1',
    });

    expect(await poller.tick()).toBe(1);
    expect(await poller.tick()).toBe(0);

    const conversation = store.listConversations()[0]!;
    expect(store.listMessages(conversation.id)).toHaveLength(1);
  });

  it('advances the high-water mark across ticks', async () => {
    client.pushInboundRow({
      mobileNumber: '13175551212',
      body: 'first',
      shortCode: '86288',
      receivedAt: '2026-01-01T10:00:00.000Z',
      messageId: 'mo-1',
    });
    await poller.tick();

    client.pushInboundRow({
      mobileNumber: '13175551212',
      body: 'second',
      shortCode: '86288',
      receivedAt: '2026-01-01T10:05:00.000Z',
      messageId: 'mo-2',
    });

    expect(await poller.tick()).toBe(1);
    const conversation = store.listConversations()[0]!;
    expect(store.listMessages(conversation.id)).toHaveLength(2);
  });

  it('survives a failing read and keeps polling', async () => {
    const failing = stubClient({
      readInboundRows: async () => {
        throw new Error('SFMC unavailable');
      },
    });
    const store2 = new InMemoryConversationStore();
    const p = new InboundPoller({
      client: failing,
      ingest: new InboundIngest(store2, new RealtimeHub()),
      intervalMs: 1000,
      shortCode: '86288',
    });

    await expect(p.tick()).resolves.toBe(0);
  });

  it('suspends polling when the Data Extension does not exist', async () => {
    // A 404 is a setup problem that will not fix itself. Retrying every few
    // seconds would only flood the log.
    const p = new InboundPoller({
      client: stubClient({
        readInboundRows: async () => {
          throw new SfmcApiError('not found', 404, 'Data Extension not found');
        },
      }),
      ingest: new InboundIngest(new InMemoryConversationStore(), new RealtimeHub()),
      intervalMs: 1000,
      shortCode: '86288',
    });

    await p.tick();
    expect(p.suspended).toBe(true);

    // Once suspended it stops calling SFMC entirely.
    await expect(p.tick()).resolves.toBe(0);
  });

  it('suspends when the token lacks data extension access', async () => {
    const p = new InboundPoller({
      client: stubClient({
        readInboundRows: async () => {
          throw new SfmcApiError('forbidden', 403, 'insufficient scope');
        },
      }),
      ingest: new InboundIngest(new InMemoryConversationStore(), new RealtimeHub()),
      intervalMs: 1000,
      shortCode: '86288',
    });

    await p.tick();
    expect(p.suspended).toBe(true);
  });

  it('keeps retrying a transient failure instead of giving up', async () => {
    let calls = 0;
    const p = new InboundPoller({
      client: stubClient({
        readInboundRows: async () => {
          calls += 1;
          throw new SfmcApiError('server error', 500, 'upstream failure');
        },
      }),
      ingest: new InboundIngest(new InMemoryConversationStore(), new RealtimeHub()),
      intervalMs: 1000,
      shortCode: '86288',
    });

    await p.tick();
    await p.tick();

    expect(p.suspended).toBe(false);
    expect(calls).toBe(2);
  });
});
