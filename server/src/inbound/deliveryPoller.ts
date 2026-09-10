import type { SfmcClient } from '../sfmc/client.js';
import type { ConversationStore } from '../conversations/store.js';
import type { RealtimeHub } from '../realtime/hub.js';

/**
 * Pulls delivery outcomes for MobileConnect sends.
 *
 * ENS covers this for transactional sends, but MobileConnect emits no
 * notifications, so without this an outbound message sits at "queued" in the UI
 * forever even though SFMC knows it was delivered.
 *
 * Only messages that are still in flight are polled, and each is given up on
 * after a while so a permanently stuck send does not get polled indefinitely.
 */
export class DeliveryPoller {
  #client: SfmcClient;
  #store: ConversationStore;
  #hub: RealtimeHub;
  #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  /** Sends already resolved or abandoned, so they are not polled again. */
  #settled = new Set<string>();

  /** Stop chasing a send after this long; SFMC will not change it later. */
  static readonly MAX_AGE_MS = 30 * 60 * 1000;

  constructor(params: {
    client: SfmcClient;
    store: ConversationStore;
    hub: RealtimeHub;
    intervalMs: number;
  }) {
    this.#client = params.client;
    this.#store = params.store;
    this.#hub = params.hub;
    this.#intervalMs = params.intervalMs;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Returns how many messages changed status. */
  async tick(): Promise<number> {
    if (this.#running) return 0;
    this.#running = true;

    try {
      const pending = this.#pendingMessages();
      let updated = 0;

      for (const message of pending) {
        const tokenId = message.providerMessageId;
        if (!tokenId) continue;

        try {
          const reports = await this.#client.getDeliveryStatus(tokenId);
          for (const report of reports) {
            const next = this.#store.updateStatus(message.id, report.standardStatusCode);
            if (!next) continue;

            // A terminal code means there is nothing further to learn.
            if (next.status === 'delivered' || next.status === 'failed') {
              this.#settled.add(message.id);
            }
            if (next.status !== message.status) {
              this.#hub.broadcast({ type: 'message.updated', message: next });
              updated += 1;
            }
          }
        } catch (error) {
          // One bad send must not stop the rest from reconciling.
          console.error(`[delivery] ${message.id}: ${describe(error)}`);
        }
      }
      return updated;
    } finally {
      this.#running = false;
    }
  }

  #pendingMessages() {
    const cutoff = Date.now() - DeliveryPoller.MAX_AGE_MS;

    return this.#store
      .listConversations()
      .flatMap((conversation) => this.#store.listMessages(conversation.id))
      .filter(
        (message) =>
          message.direction === 'outbound' &&
          !this.#settled.has(message.id) &&
          (message.status === 'queued' || message.status === 'sent' || message.status === 'pending') &&
          Date.parse(message.createdAt) > cutoff,
      );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
