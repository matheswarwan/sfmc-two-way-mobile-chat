import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Contact,
  Conversation,
  Message,
  DeliveryStatus,
  Channel,
} from '../domain/types.js';
import { resolveStatus } from '../sfmc/statusCodes.js';
import type { ConversationStore } from './store.js';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

/**
 * `node:sqlite` is newer than Vite's list of Node builtins, so a static import
 * makes the test transform try to resolve it as a package and fail. Loading it
 * through createRequire keeps it opaque to static analysis and resolves from
 * Node at runtime, where it exists.
 */
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/**
 * Durable conversation store backed by SQLite.
 *
 * Uses `node:sqlite`, built into Node, so persistence costs no dependency and
 * no native build. Conversations survive a restart, which the in-memory store
 * could not do - a refresh used to lose the entire history.
 */
export class SqliteConversationStore implements ConversationStore {
  #db: DatabaseSyncType;

  constructor(filePath: string) {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
    this.#db = new DatabaseSync(filePath);
    this.#migrate();
  }

  #migrate(): void {
    // WAL keeps the poller's writes from blocking the UI's reads.
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec(`
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
      );

      CREATE UNIQUE INDEX IF NOT EXISTS conversations_channel_number
        ON conversations (channel, mobile_number);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        channel TEXT NOT NULL,
        direction TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        status_code INTEGER,
        provider_message_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS messages_conversation ON messages (conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS messages_provider ON messages (provider_message_id);

      -- Inbound delivery is at-least-once, so dedupe keys must outlive a restart
      -- or a redelivered message would be inserted twice.
      CREATE TABLE IF NOT EXISTS dedupe_keys (
        key TEXT PRIMARY KEY,
        seen_at TEXT NOT NULL
      );
    `);
  }

  listConversations(): Conversation[] {
    const rows = this.#db
      .prepare('SELECT * FROM conversations ORDER BY last_message_at DESC')
      .all() as unknown as ConversationRow[];
    return rows.map(toConversation);
  }

  getConversation(id: string): Conversation | undefined {
    const row = this.#db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as unknown as
      | ConversationRow
      | undefined;
    return row ? toConversation(row) : undefined;
  }

  findConversationByNumber(channel: Channel, mobileNumber: string): Conversation | undefined {
    const row = this.#db
      .prepare('SELECT * FROM conversations WHERE channel = ? AND mobile_number = ?')
      .get(channel, mobileNumber) as unknown as
      | ConversationRow | undefined;
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
        this.#db
          .prepare('UPDATE conversations SET contact_key = ? WHERE id = ?')
          .run(params.contactKey, existing.id);
        existing.contact.contactKey = params.contactKey;
      }
      return existing;
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO conversations
           (id, channel, channel_address, mobile_number, contact_id, contact_key,
            subscription_status, last_message_at, last_message_preview, unread_count)
         VALUES (?, ?, ?, ?, ?, ?, 'unknown', ?, '', 0)`,
      )
      .run(
        id,
        params.channel,
        params.channelAddress,
        params.mobileNumber,
        randomUUID(),
        params.contactKey ?? null,
        now,
      );

    return this.getConversation(id)!;
  }

  listMessages(conversationId: string): Message[] {
    const rows = this.#db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
      .all(conversationId) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  addMessage(input: Omit<Message, 'id' | 'createdAt' | 'updatedAt'>): Message {
    const now = new Date().toISOString();
    const id = randomUUID();

    this.#db
      .prepare(
        `INSERT INTO messages
           (id, conversation_id, channel, direction, body, status, status_code,
            provider_message_id, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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

    this.#db
      .prepare(
        `UPDATE conversations
            SET last_message_at = ?,
                last_message_preview = ?,
                unread_count = unread_count + ?
          WHERE id = ?`,
      )
      .run(now, input.body.slice(0, 120), input.direction === 'inbound' ? 1 : 0, input.conversationId);

    return this.#getMessage(id)!;
  }

  updateStatus(messageId: string, statusCode: number): Message | undefined {
    const message = this.#getMessage(messageId);
    if (!message) return undefined;

    // Highest code wins: SFMC status codes can arrive out of order.
    const resolved = resolveStatus(message.statusCode, statusCode);
    this.#db
      .prepare('UPDATE messages SET status_code = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(resolved.code, resolved.status, new Date().toISOString(), messageId);
    return this.#getMessage(messageId);
  }

  findMessageByProviderId(providerMessageId: string): Message | undefined {
    const row = this.#db
      .prepare('SELECT * FROM messages WHERE provider_message_id = ? ORDER BY created_at DESC')
      .get(providerMessageId) as unknown as MessageRow | undefined;
    return row ? toMessage(row) : undefined;
  }

  findLatestOutbound(channel: Channel, mobileNumber: string): Message | undefined {
    const row = this.#db
      .prepare(
        `SELECT m.* FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
          WHERE c.channel = ? AND c.mobile_number = ? AND m.direction = 'outbound'
          ORDER BY m.created_at DESC`,
      )
      .get(channel, mobileNumber) as unknown as MessageRow | undefined;
    return row ? toMessage(row) : undefined;
  }

  setStatus(messageId: string, status: DeliveryStatus, error?: string): Message | undefined {
    if (!this.#getMessage(messageId)) return undefined;
    this.#db
      .prepare(
        `UPDATE messages SET status = ?, error = COALESCE(?, error), updated_at = ? WHERE id = ?`,
      )
      .run(status, error ?? null, new Date().toISOString(), messageId);
    return this.#getMessage(messageId);
  }

  markFailed(messageId: string, error: string): Message | undefined {
    return this.setStatus(messageId, 'failed', error);
  }

  setProviderMessageId(messageId: string, providerMessageId: string): Message | undefined {
    if (!this.#getMessage(messageId)) return undefined;
    this.#db
      .prepare('UPDATE messages SET provider_message_id = ?, updated_at = ? WHERE id = ?')
      .run(providerMessageId, new Date().toISOString(), messageId);
    return this.#getMessage(messageId);
  }

  markRead(conversationId: string): void {
    this.#db.prepare('UPDATE conversations SET unread_count = 0 WHERE id = ?').run(conversationId);
  }

  updateContact(conversationId: string, patch: Partial<Contact>): void {
    const fields: string[] = [];
    const values: Array<string | null> = [];

    const columns: Array<[keyof Contact, string]> = [
      ['contactKey', 'contact_key'],
      ['firstName', 'first_name'],
      ['lastName', 'last_name'],
      ['subscriptionStatus', 'subscription_status'],
      ['mobileNumber', 'mobile_number'],
    ];

    for (const [key, column] of columns) {
      if (patch[key] !== undefined) {
        fields.push(`${column} = ?`);
        values.push(patch[key] as string);
      }
    }
    if (fields.length === 0) return;

    values.push(conversationId);
    this.#db.prepare(`UPDATE conversations SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  claimDedupeKey(key: string): boolean {
    // INSERT OR IGNORE makes the claim atomic: the row count tells us whether
    // this caller is the first to see the key.
    const result = this.#db
      .prepare('INSERT OR IGNORE INTO dedupe_keys (key, seen_at) VALUES (?, ?)')
      .run(key, new Date().toISOString());
    return result.changes > 0;
  }

  close(): void {
    this.#db.close();
  }

  #getMessage(id: string): Message | undefined {
    const row = this.#db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown as
      | MessageRow
      | undefined;
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
