import type { InboundMessage } from '../domain/types.js';
import type { ConversationStore } from '../conversations/store.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { normaliseNumber } from '../sfmc/client.js';

export interface IngestResult {
  accepted: boolean;
  reason?: 'duplicate' | 'suppressed';
  messageId?: string;
}

/** How long a suppression stays armed before it expires on its own. */
const SUPPRESSION_TTL_MS = 120_000;

/**
 * The single entry point for every inbound message, whatever transport carried
 * it.
 *
 * Two paths feed this: the AMPscript webhook (if HttpPost2 turns out to fire
 * from a Text Response) and the Data Extension poller. Both can deliver the
 * same message, and the poller's window can overlap itself, so ingest is
 * idempotent on a natural key rather than trusting the transport.
 */
export class InboundIngest {
  #store: ConversationStore;
  #hub: RealtimeHub;
  /** Armed echoes, keyed by number and body, valued by expiry. */
  #suppressed = new Map<string, number>();

  constructor(store: ConversationStore, hub: RealtimeHub) {
    this.#store = store;
    this.#hub = hub;
  }

  /**
   * Arm a one-shot filter for a message this app is about to cause.
   *
   * Opting a number in means queueing a mobile-originated message on its
   * behalf, and the Text Response writes that to the Data Extension like any
   * other reply. Without this the agent would see the customer apparently
   * texting "CHAT" before the conversation had begun.
   *
   * The row still lands in the Data Extension, which stays the complete audit
   * log; only the conversation view skips it. One-shot and time-boxed, so a
   * customer who later genuinely types the keyword is not swallowed.
   */
  suppressEcho(mobileNumber: string, body: string, ttlMs = SUPPRESSION_TTL_MS): void {
    this.#suppressed.set(echoKey(mobileNumber, body), Date.now() + ttlMs);
  }

  ingest(inbound: InboundMessage): IngestResult {
    if (!this.#store.claimDedupeKey(inbound.dedupeKey)) {
      return { accepted: false, reason: 'duplicate' };
    }

    // Claim the key first, then drop: the row must stay claimed so a later
    // poll over the same window does not resurface it.
    if (this.#claimSuppression(inbound.mobileNumber, inbound.body)) {
      return { accepted: false, reason: 'suppressed' };
    }

    const conversation = this.#store.ensureConversation({
      channel: inbound.channel,
      mobileNumber: inbound.mobileNumber,
      channelAddress: inbound.channelAddress,
      ...(inbound.contactKey ? { contactKey: inbound.contactKey } : {}),
    });

    const message = this.#store.addMessage({
      conversationId: conversation.id,
      channel: inbound.channel,
      direction: 'inbound',
      body: inbound.body,
      status: 'received',
      providerMessageId: inbound.dedupeKey,
    });

    this.#hub.broadcast({ type: 'message.created', message, conversation });
    return { accepted: true, messageId: message.id };
  }

  #claimSuppression(mobileNumber: string, body: string): boolean {
    const key = echoKey(mobileNumber, body);
    const expiresAt = this.#suppressed.get(key);
    if (expiresAt === undefined) return false;

    this.#suppressed.delete(key);
    return Date.now() < expiresAt;
  }
}

/**
 * MobileConnect echoes the keyword back with its own casing and spacing, so
 * both are normalised out before matching.
 */
function echoKey(mobileNumber: string, body: string): string {
  return `${normaliseNumber(mobileNumber)}|${body.trim().toUpperCase()}`;
}
