import { randomUUID } from 'node:crypto';
import type {
  Contact,
  Conversation,
  Message,
  DeliveryStatus,
  Channel,
} from '../domain/types.js';
import { resolveStatus } from '../sfmc/statusCodes.js';

/**
 * Persistence interface.
 *
 * The prototype runs on the in-memory implementation below. It is kept behind
 * this interface so swapping in SQLite or Postgres is a new class rather than a
 * rewrite of the callers.
 */
export interface ConversationStore {
  listConversations(): Conversation[];
  getConversation(id: string): Conversation | undefined;
  findConversationByNumber(channel: Channel, mobileNumber: string): Conversation | undefined;
  ensureConversation(params: {
    channel: Channel;
    mobileNumber: string;
    channelAddress: string;
    contactKey?: string;
  }): Conversation;
  listMessages(conversationId: string): Message[];
  addMessage(message: Omit<Message, 'id' | 'createdAt' | 'updatedAt'>): Message;
  updateStatus(messageId: string, statusCode: number): Message | undefined;
  /** Look up by the id SFMC knows the send by, used to match delivery events. */
  findMessageByProviderId(providerMessageId: string): Message | undefined;
  /** Fallback for events that carry only a phone number. */
  findLatestOutbound(channel: Channel, mobileNumber: string): Message | undefined;
  /** Set a status directly, for events that report state rather than a code. */
  setStatus(messageId: string, status: DeliveryStatus, error?: string): Message | undefined;
  /**
   * Record the id SFMC knows the send by.
   *
   * Must be an explicit write: a store may return detached copies, so mutating
   * a returned Message persists nothing.
   */
  setProviderMessageId(messageId: string, providerMessageId: string): Message | undefined;
  markFailed(messageId: string, error: string): Message | undefined;
  markRead(conversationId: string): void;
  updateContact(conversationId: string, patch: Partial<Contact>): void;
  /** Returns false when the key has been seen before, which means: drop it. */
  claimDedupeKey(key: string): boolean;
}

export class InMemoryConversationStore implements ConversationStore {
  #conversations = new Map<string, Conversation>();
  #messages = new Map<string, Message[]>();
  #seenDedupeKeys = new Set<string>();

  listConversations(): Conversation[] {
    return [...this.#conversations.values()].sort((a, b) =>
      b.lastMessageAt.localeCompare(a.lastMessageAt),
    );
  }

  getConversation(id: string): Conversation | undefined {
    return this.#conversations.get(id);
  }

  findConversationByNumber(channel: Channel, mobileNumber: string): Conversation | undefined {
    for (const conversation of this.#conversations.values()) {
      if (conversation.channel === channel && conversation.contact.mobileNumber === mobileNumber) {
        return conversation;
      }
    }
    return undefined;
  }

  ensureConversation(params: {
    channel: Channel;
    mobileNumber: string;
    channelAddress: string;
    contactKey?: string;
  }): Conversation {
    const existing = this.findConversationByNumber(params.channel, params.mobileNumber);
    if (existing) {
      if (params.contactKey && !existing.contact.contactKey) {
        existing.contact.contactKey = params.contactKey;
      }
      return existing;
    }

    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: randomUUID(),
      channel: params.channel,
      channelAddress: params.channelAddress,
      contact: {
        id: randomUUID(),
        mobileNumber: params.mobileNumber,
        subscriptionStatus: 'unknown',
        ...(params.contactKey ? { contactKey: params.contactKey } : {}),
      },
      lastMessageAt: now,
      lastMessagePreview: '',
      unreadCount: 0,
    };
    this.#conversations.set(conversation.id, conversation);
    this.#messages.set(conversation.id, []);
    return conversation;
  }

  listMessages(conversationId: string): Message[] {
    return [...(this.#messages.get(conversationId) ?? [])];
  }

  addMessage(input: Omit<Message, 'id' | 'createdAt' | 'updatedAt'>): Message {
    const now = new Date().toISOString();
    const message: Message = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };

    const bucket = this.#messages.get(message.conversationId) ?? [];
    bucket.push(message);
    this.#messages.set(message.conversationId, bucket);

    const conversation = this.#conversations.get(message.conversationId);
    if (conversation) {
      conversation.lastMessageAt = now;
      conversation.lastMessagePreview = message.body.slice(0, 120);
      if (message.direction === 'inbound') conversation.unreadCount += 1;
    }
    return message;
  }

  updateStatus(messageId: string, statusCode: number): Message | undefined {
    const message = this.#findMessage(messageId);
    if (!message) return undefined;

    // Highest code wins, because SFMC status codes can arrive out of order.
    const resolved = resolveStatus(message.statusCode, statusCode);
    message.statusCode = resolved.code;
    message.status = resolved.status;
    message.updatedAt = new Date().toISOString();
    return message;
  }

  findMessageByProviderId(providerMessageId: string): Message | undefined {
    for (const bucket of this.#messages.values()) {
      const found = bucket.find((m) => m.providerMessageId === providerMessageId);
      if (found) return found;
    }
    return undefined;
  }

  findLatestOutbound(channel: Channel, mobileNumber: string): Message | undefined {
    const conversation = this.findConversationByNumber(channel, mobileNumber);
    if (!conversation) return undefined;

    // Most recent first: a delivery event without a message key almost always
    // refers to the send that just went out.
    return [...(this.#messages.get(conversation.id) ?? [])]
      .reverse()
      .find((m) => m.direction === 'outbound');
  }

  setStatus(messageId: string, status: DeliveryStatus, error?: string): Message | undefined {
    const message = this.#findMessage(messageId);
    if (!message) return undefined;

    message.status = status;
    if (error) message.error = error;
    message.updatedAt = new Date().toISOString();
    return message;
  }

  markFailed(messageId: string, error: string): Message | undefined {
    const message = this.#findMessage(messageId);
    if (!message) return undefined;
    message.status = 'failed' satisfies DeliveryStatus;
    message.error = error;
    message.updatedAt = new Date().toISOString();
    return message;
  }

  setProviderMessageId(messageId: string, providerMessageId: string): Message | undefined {
    const message = this.#findMessage(messageId);
    if (!message) return undefined;
    message.providerMessageId = providerMessageId;
    message.updatedAt = new Date().toISOString();
    return message;
  }

  markRead(conversationId: string): void {
    const conversation = this.#conversations.get(conversationId);
    if (conversation) conversation.unreadCount = 0;
  }

  updateContact(conversationId: string, patch: Partial<Contact>): void {
    const conversation = this.#conversations.get(conversationId);
    if (!conversation) return;
    Object.assign(conversation.contact, patch);
  }

  claimDedupeKey(key: string): boolean {
    if (this.#seenDedupeKeys.has(key)) return false;
    this.#seenDedupeKeys.add(key);
    return true;
  }

  #findMessage(messageId: string): Message | undefined {
    for (const bucket of this.#messages.values()) {
      const found = bucket.find((m) => m.id === messageId);
      if (found) return found;
    }
    return undefined;
  }
}
