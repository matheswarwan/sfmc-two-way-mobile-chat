import { describe, it, expect, beforeEach } from 'vitest';
import { DeliveryPoller } from '../src/inbound/deliveryPoller.js';
import { SqliteConversationStore } from '../src/conversations/sqliteStore.js';
import { RealtimeHub, type ServerEvent } from '../src/realtime/hub.js';
import { stubClient } from './helpers.js';

describe('DeliveryPoller', () => {
  let store: SqliteConversationStore;
  let hub: RealtimeHub;
  let events: ServerEvent[];

  beforeEach(() => {
    store = new SqliteConversationStore(':memory:');
    hub = new RealtimeHub();
    events = [];
    hub.subscribe({ send: (p) => events.push(JSON.parse(p) as ServerEvent) });
  });

  function addPending(tokenId: string) {
    const conversation = store.ensureConversation({
      channel: 'sms',
      mobileNumber: '447440422320',
      channelAddress: '447860078941',
    });
    return store.addMessage({
      conversationId: conversation.id,
      channel: 'sms',
      direction: 'outbound',
      body: 'hi',
      status: 'queued',
      statusCode: 1000,
      providerMessageId: tokenId,
    });
  }

  it('promotes a queued message to delivered and tells the UI', async () => {
    const message = addPending('tok-1');
    const poller = new DeliveryPoller({
      client: stubClient({
        getDeliveryStatus: async () => [{ mobileNumber: '447440422320', standardStatusCode: 4000 }],
      }),
      store,
      hub,
      intervalMs: 1000,
    });

    expect(await poller.tick()).toBe(1);
    expect(store.listMessages(message.conversationId)[0]?.status).toBe('delivered');
    expect(events.some((e) => e.type === 'message.updated')).toBe(true);
  });

  it('stops polling a message once it reaches a terminal status', async () => {
    addPending('tok-1');
    let calls = 0;
    const poller = new DeliveryPoller({
      client: stubClient({
        getDeliveryStatus: async () => {
          calls += 1;
          return [{ mobileNumber: '447440422320', standardStatusCode: 4000 }];
        },
      }),
      store,
      hub,
      intervalMs: 1000,
    });

    await poller.tick();
    await poller.tick();
    expect(calls).toBe(1);
  });

  it('keeps polling while the send is still in flight', async () => {
    addPending('tok-1');
    let calls = 0;
    const poller = new DeliveryPoller({
      client: stubClient({
        getDeliveryStatus: async () => {
          calls += 1;
          // 2000 is aggregator-level, not terminal for a long code.
          return [{ mobileNumber: '447440422320', standardStatusCode: 2000 }];
        },
      }),
      store,
      hub,
      intervalMs: 1000,
    });

    await poller.tick();
    await poller.tick();
    expect(calls).toBe(2);
  });

  it('survives an error on one message', async () => {
    addPending('tok-1');
    const poller = new DeliveryPoller({
      client: stubClient({
        getDeliveryStatus: async () => {
          throw new Error('SFMC unavailable');
        },
      }),
      store,
      hub,
      intervalMs: 1000,
    });

    await expect(poller.tick()).resolves.toBe(0);
  });
});
