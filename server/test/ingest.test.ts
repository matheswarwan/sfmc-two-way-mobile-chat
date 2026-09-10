import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryConversationStore } from '../src/conversations/store.js';
import { InboundIngest } from '../src/inbound/ingest.js';
import { RealtimeHub, type ServerEvent } from '../src/realtime/hub.js';
import type { InboundMessage } from '../src/domain/types.js';

function makeInbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'sms',
    mobileNumber: '13175551212',
    channelAddress: '86288',
    body: 'hello there',
    receivedAt: '2026-01-01T10:00:00.000Z',
    dedupeKey: 'sms:mo-1',
    source: 'de-poller',
    ...overrides,
  };
}

describe('InboundIngest', () => {
  let store: InMemoryConversationStore;
  let hub: RealtimeHub;
  let events: ServerEvent[];
  let ingest: InboundIngest;

  beforeEach(() => {
    store = new InMemoryConversationStore();
    hub = new RealtimeHub();
    events = [];
    hub.subscribe({ send: (payload) => events.push(JSON.parse(payload) as ServerEvent) });
    ingest = new InboundIngest(store, hub);
  });

  it('creates a conversation and broadcasts the message', () => {
    const result = ingest.ingest(makeInbound());

    expect(result.accepted).toBe(true);
    expect(store.listConversations()).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('message.created');
  });

  it('drops a repeat of the same message', () => {
    ingest.ingest(makeInbound());
    const second = ingest.ingest(makeInbound());

    expect(second.accepted).toBe(false);
    expect(second.reason).toBe('duplicate');
    expect(store.listConversations()).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('deduplicates across transports, so webhook and poller cannot double-post', () => {
    // The same underlying MO, seen first by the webhook and then by the poller.
    ingest.ingest(makeInbound({ source: 'ampscript-webhook' }));
    const viaPoller = ingest.ingest(makeInbound({ source: 'de-poller' }));

    expect(viaPoller.accepted).toBe(false);
    const conversation = store.listConversations()[0]!;
    expect(store.listMessages(conversation.id)).toHaveLength(1);
  });

  it('threads separate numbers into separate conversations', () => {
    ingest.ingest(makeInbound({ mobileNumber: '13175551212', dedupeKey: 'sms:a' }));
    ingest.ingest(makeInbound({ mobileNumber: '13175559999', dedupeKey: 'sms:b' }));

    expect(store.listConversations()).toHaveLength(2);
  });

  it('counts inbound messages as unread until read', () => {
    ingest.ingest(makeInbound({ dedupeKey: 'sms:a' }));
    ingest.ingest(makeInbound({ dedupeKey: 'sms:b' }));

    const conversation = store.listConversations()[0]!;
    expect(conversation.unreadCount).toBe(2);

    store.markRead(conversation.id);
    expect(store.getConversation(conversation.id)?.unreadCount).toBe(0);
  });
});
