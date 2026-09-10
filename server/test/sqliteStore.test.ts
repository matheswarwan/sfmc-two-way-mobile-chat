import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteConversationStore } from '../src/conversations/sqliteStore.js';

describe('SqliteConversationStore', () => {
  let store: SqliteConversationStore;

  beforeEach(() => {
    store = new SqliteConversationStore(':memory:');
  });

  it('keeps a conversation and its messages', () => {
    const conversation = store.ensureConversation({
      channel: 'sms',
      mobileNumber: '447440422320',
      channelAddress: '447860078941',
    });
    store.addMessage({
      conversationId: conversation.id,
      channel: 'sms',
      direction: 'outbound',
      body: 'hello',
      status: 'queued',
    });

    expect(store.listConversations()).toHaveLength(1);
    expect(store.listMessages(conversation.id)[0]?.body).toBe('hello');
  });

  it('returns the same conversation for a number rather than duplicating it', () => {
    const a = store.ensureConversation({
      channel: 'sms',
      mobileNumber: '447440422320',
      channelAddress: '447860078941',
    });
    const b = store.ensureConversation({
      channel: 'sms',
      mobileNumber: '447440422320',
      channelAddress: '447860078941',
    });

    expect(b.id).toBe(a.id);
    expect(store.listConversations()).toHaveLength(1);
  });

  it('keeps the highest status code when updates arrive out of order', () => {
    const conversation = store.ensureConversation({
      channel: 'sms',
      mobileNumber: '447440422320',
      channelAddress: '447860078941',
    });
    const message = store.addMessage({
      conversationId: conversation.id,
      channel: 'sms',
      direction: 'outbound',
      body: 'hi',
      status: 'pending',
    });

    store.updateStatus(message.id, 4000);
    const stale = store.updateStatus(message.id, 3001);

    expect(stale?.statusCode).toBe(4000);
    expect(stale?.status).toBe('delivered');
  });

  it('matches a delivery event by provider message id', () => {
    const conversation = store.ensureConversation({
      channel: 'sms',
      mobileNumber: '447440422320',
      channelAddress: '447860078941',
    });
    store.addMessage({
      conversationId: conversation.id,
      channel: 'sms',
      direction: 'outbound',
      body: 'hi',
      status: 'queued',
      providerMessageId: 'key-123',
    });

    expect(store.findMessageByProviderId('key-123')?.body).toBe('hi');
    expect(store.findMessageByProviderId('missing')).toBeUndefined();
    expect(store.findLatestOutbound('sms', '447440422320')?.body).toBe('hi');
  });

  it('claims a dedupe key exactly once, so a redelivery is dropped', () => {
    expect(store.claimDedupeKey('sms:mo-1')).toBe(true);
    expect(store.claimDedupeKey('sms:mo-1')).toBe(false);
  });

  it('counts unread inbound messages and clears them on read', () => {
    const conversation = store.ensureConversation({
      channel: 'sms',
      mobileNumber: '447440422320',
      channelAddress: '447860078941',
    });
    store.addMessage({
      conversationId: conversation.id,
      channel: 'sms',
      direction: 'inbound',
      body: 'reply',
      status: 'received',
    });

    expect(store.getConversation(conversation.id)?.unreadCount).toBe(1);
    store.markRead(conversation.id);
    expect(store.getConversation(conversation.id)?.unreadCount).toBe(0);
  });
});
