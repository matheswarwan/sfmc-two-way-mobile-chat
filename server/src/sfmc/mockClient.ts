import type {
  SfmcClient,
  SendSmsResult,
  SubscriptionRecord,
  SubscriptionState,
  SubscriberMatch,
  OptInResult,
  DataExtensionRow,
  DeliveryReport,
} from './client.js';
import { normaliseNumber } from './client.js';

/**
 * In-process stand-in for SFMC.
 *
 * Exists so the app is runnable and testable without a tenant. It records what
 * was sent and lets tests push synthetic inbound rows through the same Data
 * Extension path the real poller reads.
 */
export class MockSfmcClient implements SfmcClient {
  readonly sent: Array<{ mobileNumber: string; text: string; shortCode?: string; at: string }> = [];
  readonly optIns: Array<{ mobileNumber: string; shortCode: string; keyword: string }> = [];
  #inboundRows: DataExtensionRow[] = [];
  #subscriptions = new Map<string, SubscriptionState>();
  #subscribers: SubscriberMatch[] = [];

  async sendSms(mobileNumber: string, text: string, shortCode?: string): Promise<SendSmsResult> {
    const number = normaliseNumber(mobileNumber);
    this.sent.push({
      mobileNumber: number,
      text,
      ...(shortCode ? { shortCode } : {}),
      at: new Date().toISOString(),
    });
    return { tokenId: `mock-token-${this.sent.length}` };
  }

  async optIn(params: {
    mobileNumber: string;
    shortCode: string;
    keyword: string;
    subscriberKey?: string;
  }): Promise<OptInResult> {
    const number = normaliseNumber(params.mobileNumber);
    this.optIns.push({
      mobileNumber: number,
      shortCode: params.shortCode,
      keyword: params.keyword,
    });
    // Opting in is what moves a number to subscribed, so reflect that.
    this.#subscriptions.set(number, 'subscribed');
    return { identifier: `mock-optin-${this.optIns.length}` };
  }

  async getSubscriptionStatus(mobileNumbers: string[]): Promise<SubscriptionRecord[]> {
    return mobileNumbers.map((mobileNumber) => {
      const number = normaliseNumber(mobileNumber);
      return {
        mobileNumber: number,
        // Default to subscribed so the prototype is usable out of the box.
        status: this.#subscriptions.get(number) ?? 'subscribed',
      };
    });
  }

  async searchSubscribers(query: string, limit = 20): Promise<SubscriberMatch[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];

    return this.#subscribers
      .filter(
        (subscriber) =>
          subscriber.mobileNumber.includes(needle) ||
          (subscriber.subscriberKey ?? '').toLowerCase().includes(needle) ||
          (subscriber.emailAddress ?? '').toLowerCase().includes(needle),
      )
      .slice(0, limit);
  }

  async getDeliveryStatus(tokenId: string): Promise<DeliveryReport[]> {
    const sent = this.sent.find((_, index) => `mock-token-${index + 1}` === tokenId);
    return sent ? [{ mobileNumber: sent.mobileNumber, standardStatusCode: 4000 }] : [];
  }

  async readInboundRows(sinceIso: string): Promise<DataExtensionRow[]> {
    return this.#inboundRows.filter((row) => (row.values['ReceivedAt'] ?? '') > sinceIso);
  }

  // --- test and demo helpers ---

  setSubscription(mobileNumber: string, status: SubscriptionState): void {
    this.#subscriptions.set(normaliseNumber(mobileNumber), status);
  }

  addSubscriber(subscriber: SubscriberMatch): void {
    this.#subscribers.push({
      ...subscriber,
      mobileNumber: normaliseNumber(subscriber.mobileNumber),
    });
  }

  /** Simulate the Text Response message writing an inbound row. */
  pushInboundRow(params: {
    mobileNumber: string;
    body: string;
    shortCode: string;
    receivedAt?: string;
    messageId?: string;
  }): DataExtensionRow {
    const row: DataExtensionRow = {
      keys: { MessageId: params.messageId ?? `mock-mo-${this.#inboundRows.length + 1}` },
      values: {
        MobileNumber: normaliseNumber(params.mobileNumber),
        MessageBody: params.body,
        ShortCode: params.shortCode,
        ReceivedAt: params.receivedAt ?? new Date().toISOString(),
      },
    };
    this.#inboundRows.push(row);
    return row;
  }
}
