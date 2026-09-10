/**
 * Core domain types.
 *
 * These are deliberately channel-neutral. SMS is the only channel in the MVP,
 * but WhatsApp and LINE attach as additional `Channel` values with their own
 * adapters rather than as a parallel type hierarchy.
 */

export type Channel = 'sms' | 'whatsapp' | 'line';

export type Direction = 'outbound' | 'inbound';

/**
 * Delivery state shown in the UI.
 *
 * SFMC reports progress as a stream of numeric status codes rather than a single
 * final state. See `sfmc/statusCodes.ts` for the mapping and the rule that the
 * highest numeric code wins.
 */
export type DeliveryStatus =
  | 'pending'
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'received';

export interface Contact {
  /** Stable identifier we control. */
  id: string;
  /** SFMC contact key, when known. May be absent for an unknown inbound number. */
  contactKey?: string;
  /** Numeric string including country code, no separators. SFMC rejects anything else. */
  mobileNumber: string;
  firstName?: string;
  lastName?: string;
  /**
   * MobileConnect only delivers to numbers with a `Subscribed` status on the
   * short code, so this gates the composer.
   */
  subscriptionStatus: 'subscribed' | 'unsubscribed' | 'in_progress' | 'unknown';
}

export interface Message {
  id: string;
  conversationId: string;
  channel: Channel;
  direction: Direction;
  body: string;
  status: DeliveryStatus;
  /** Highest SFMC status code seen so far, used to resolve out-of-order updates. */
  statusCode?: number;
  /** Identifier returned by or derived from SFMC, used for dedupe and correlation. */
  providerMessageId?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface Conversation {
  id: string;
  channel: Channel;
  contact: Contact;
  /** The short code, long code or channel address this thread runs on. */
  channelAddress: string;
  lastMessageAt: string;
  lastMessagePreview: string;
  unreadCount: number;
}

/**
 * A normalised inbound message, produced by whichever inbound path fired.
 *
 * Both the AMPscript webhook and the Data Extension poller emit this shape so
 * that ingest is identical regardless of transport.
 */
export interface InboundMessage {
  channel: Channel;
  mobileNumber: string;
  channelAddress: string;
  body: string;
  receivedAt: string;
  contactKey?: string;
  /**
   * Natural key for idempotency. ENS is at-least-once and the poller can
   * overlap its window, so ingest must tolerate repeats.
   */
  dedupeKey: string;
  source: 'ampscript-webhook' | 'de-poller' | 'ens' | 'test';
}
