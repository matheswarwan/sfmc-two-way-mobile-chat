import type {
  Contact,
  Conversation,
  Message,
  DeliveryStatus,
  Channel,
} from '../../server/src/domain/types.js';
import { resolveStatus } from '../../server/src/sfmc/statusCodes.js';
import type { ConversationStore } from '../../server/src/conversations/store.js';

/**
 * ConversationStore on a Durable Object's SQLite storage.
 *
 * The DO storage SQL API is synchronous, unlike D1, so the existing store
 * interface ports across without turning every caller into an async function.
 * A single Durable Object owns all conversation state, which also gives the
 * WebSocket fan-out somewhere consistent to live.
 */
export class DurableObjectConversationStore implements ConversationStore {
  #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    this.#migrate();
  }

  #migrate(): void {
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        channel_address TEXT NOT NULL,
        mobile_number TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        contact_key TEXT,
        first_name TEXT,
        last_name TEXT,
        subscription_status TEXT NOT NULL DEFAULT 'unknown',
        last_message_at TEXT NOT NULL,
        last_message_preview TEXT NOT NULL DEFAULT '',
        unread_count INTEGER NOT NULL DEFAULT 0
      )`);
    this.#sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS conversations_channel_number
         ON conversations (channel, mobile_number)`,
    );
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        direction TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        status_code INTEGER,
        provider_message_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
    this.#sql.exec(
      `CREATE INDEX IF NOT EXISTS messages_conversation ON messages (conversation_id, created_at)`,
    );
    this.#sql.exec(
      `CREATE INDEX IF NOT EXISTS messages_provider ON messages (provider_message_id)`,
    );
    // Inbound delivery is at-least-once, so dedupe keys must be durable.
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS dedupe_keys (
        key TEXT PRIMARY KEY,
        seen_at TEXT NOT NULL
      )`);
  }

  #all<T>(query: string, ...params: unknown[]): T[] {
    return this.#sql.exec(query, ...(params as never[])).toArray() as unknown as T[];
  }

  #one<T>(query: string, ...params: unknown[]): T | undefined {
    return this.#all<T>(query, ...params)[0];
  }

  listConversations(): Conversation[] {
    return this.#all<ConversationRow>(
      'SELECT * FROM conversations ORDER BY last_message_at DESC',
    ).map(toConversation);
  }

  getConversation(id: string): Conversation | undefined {
    const row = this.#one<ConversationRow>('SELECT * FROM conversations WHERE id = ?', id);
    return row ? toConversation(row) : undefined;
  }

  findConversationByNumber(channel: Channel, mobileNumber: string): Conversation | undefined {
    const row = this.#one<ConversationRow>(
      'SELECT * FROM conversations WHERE channel = ? AND mobile_number = ?',
      channel,
      mobileNumber,
    );
    return row ? toConversation(row) : undefined;
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
        this.#sql.exec(
          'UPDATE conversations SET contact_key = ? WHERE id = ?',
          params.contactKey,
          existing.id,
        );
        existing.contact.contactKey = params.contactKey;
      }
      return existing;
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.#sql.exec(
      `INSERT INTO conversations
         (id, channel, channel_address, mobile_number, contact_id, contact_key,
          subscription_status, last_message_at, last_message_preview, unread_count)
       VALUES (?, ?, ?, ?, ?, ?, 'unknown', ?, '', 0)`,
      id,
      params.channel,
      params.channelAddress,
      params.mobileNumber,
      crypto.randomUUID(),
      params.contactKey ?? null,
      now,
    );
    return this.getConversation(id)!;
  }

  listMessages(conversationId: string): Message[] {
    return this.#all<MessageRow>(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
      conversationId,
    ).map(toMessage);
  }

  addMessage(input: Omit<Message, 'id' | 'createdAt' | 'updatedAt'>): Message {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    this.#sql.exec(
      `INSERT INTO messages
         (id, conversation_id, channel, direction, body, status, status_code,
          provider_message_id, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.conversationId,
      input.channel,
      input.direction,
      input.body,
      input.status,
      input.statusCode ?? null,
      input.providerMessageId ?? null,
      input.error ?? null,
      now,
      now,
    );

    this.#sql.exec(
      `UPDATE conversations
          SET last_message_at = ?, last_message_preview = ?, unread_count = unread_count + ?
        WHERE id = ?`,
      now,
      input.body.slice(0, 120),
      input.direction === 'inbound' ? 1 : 0,
      input.conversationId,
    );

    return this.#getMessage(id)!;
  }

  updateStatus(messageId: string, statusCode: number): Message | undefined {
    const message = this.#getMessage(messageId);
    if (!message) return undefined;

    // Highest code wins: SFMC status codes can arrive out of order.
    const resolved = resolveStatus(message.statusCode, statusCode);
    this.#sql.exec(
      'UPDATE messages SET status_code = ?, status = ?, updated_at = ? WHERE id = ?',
      resolved.code,
      resolved.status,
      new Date().toISOString(),
      messageId,
    );
    return this.#getMessage(messageId);
  }

  findMessageByProviderId(providerMessageId: string): Message | undefined {
    const row = this.#one<MessageRow>(
      'SELECT * FROM messages WHERE provider_message_id = ? ORDER BY created_at DESC',
      providerMessageId,
    );
    return row ? toMessage(row) : undefined;
  }

  findLatestOutbound(channel: Channel, mobileNumber: string): Message | undefined {
    const row = this.#one<MessageRow>(
      `SELECT m.* FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.channel = ? AND c.mobile_number = ? AND m.direction = 'outbound'
        ORDER BY m.created_at DESC`,
      channel,
      mobileNumber,
    );
    return row ? toMessage(row) : undefined;
  }

  setStatus(messageId: string, status: DeliveryStatus, error?: string): Message | undefined {
    if (!this.#getMessage(messageId)) return undefined;
    this.#sql.exec(
      'UPDATE messages SET status = ?, error = COALESCE(?, error), updated_at = ? WHERE id = ?',
      status,
      error ?? null,
      new Date().toISOString(),
      messageId,
    );
    return this.#getMessage(messageId);
  }

  setProviderMessageId(messageId: string, providerMessageId: string): Message | undefined {
    if (!this.#getMessage(messageId)) return undefined;
    this.#sql.exec(
      'UPDATE messages SET provider_message_id = ?, updated_at = ? WHERE id = ?',
      providerMessageId,
      new Date().toISOString(),
      messageId,
    );
    return this.#getMessage(messageId);
  }

  markFailed(messageId: string, error: string): Message | undefined {
    return this.setStatus(messageId, 'failed', error);
  }

  markRead(conversationId: string): void {
    this.#sql.exec('UPDATE conversations SET unread_count = 0 WHERE id = ?', conversationId);
  }

  updateContact(conversationId: string, patch: Partial<Contact>): void {
    const columns: Array<[keyof Contact, string]> = [
      ['contactKey', 'contact_key'],
      ['firstName', 'first_name'],
      ['lastName', 'last_name'],
      ['subscriptionStatus', 'subscription_status'],
      ['mobileNumber', 'mobile_number'],
    ];

    for (const [key, column] of columns) {
      if (patch[key] !== undefined) {
        this.#sql.exec(
          `UPDATE conversations SET ${column} = ? WHERE id = ?`,
          patch[key] as string,
          conversationId,
        );
      }
    }
  }

  claimDedupeKey(key: string): boolean {
    // The row count tells us whether this caller is the first to see the key.
    const before = this.#one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM dedupe_keys WHERE key = ?',
      key,
    );
    if ((before?.n ?? 0) > 0) return false;

    this.#sql.exec(
      'INSERT OR IGNORE INTO dedupe_keys (key, seen_at) VALUES (?, ?)',
      key,
      new Date().toISOString(),
    );
    return true;
  }

  #getMessage(id: string): Message | undefined {
    const row = this.#one<MessageRow>('SELECT * FROM messages WHERE id = ?', id);
    return row ? toMessage(row) : undefined;
  }
}

interface ConversationRow {
  id: string;
  channel: string;
  channel_address: string;
  mobile_number: string;
  contact_id: string;
  contact_key: string | null;
  first_name: string | null;
  last_name: string | null;
  subscription_status: string;
  last_message_at: string;
  last_message_preview: string;
  unread_count: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  channel: string;
  direction: string;
  body: string;
  status: string;
  status_code: number | null;
  provider_message_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    channel: row.channel as Channel,
    channelAddress: row.channel_address,
    contact: {
      id: row.contact_id,
      mobileNumber: row.mobile_number,
      subscriptionStatus: row.subscription_status as Contact['subscriptionStatus'],
      ...(row.contact_key ? { contactKey: row.contact_key } : {}),
      ...(row.first_name ? { firstName: row.first_name } : {}),
      ...(row.last_name ? { lastName: row.last_name } : {}),
    },
    lastMessageAt: row.last_message_at,
    lastMessagePreview: row.last_message_preview,
    unreadCount: row.unread_count,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    channel: row.channel as Channel,
    direction: row.direction as Message['direction'],
    body: row.body,
    status: row.status as DeliveryStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.status_code !== null ? { statusCode: row.status_code } : {}),
    ...(row.provider_message_id ? { providerMessageId: row.provider_message_id } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}
