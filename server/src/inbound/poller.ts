import { SfmcApiError, type SfmcClient } from '../sfmc/client.js';
import type { InboundIngest } from './ingest.js';
import type { InboundMessage } from '../domain/types.js';

/**
 * Reads inbound rows the MobileConnect Text Response wrote via InsertData().
 *
 * This is the guaranteed floor for inbound SMS. Salesforce publishes no webhook
 * for mobile-originated SMS, and names InsertData() as one of only two
 * non-mobile AMPscript functions usable in a MobileConnect message. The capture
 * itself is synchronous; only this read is on an interval.
 */
export class InboundPoller {
  #client: SfmcClient;
  #ingest: InboundIngest;
  #intervalMs: number;
  #shortCode: string;
  #timer: NodeJS.Timeout | undefined;
  /** High-water mark. Overlapped slightly so a boundary row is never skipped. */
  #since: string;
  #running = false;
  #consecutiveFailures = 0;
  #suspended = false;

  constructor(params: {
    client: SfmcClient;
    ingest: InboundIngest;
    intervalMs: number;
    shortCode: string;
    since?: string;
  }) {
    this.#client = params.client;
    this.#ingest = params.ingest;
    this.#intervalMs = params.intervalMs;
    this.#shortCode = params.shortCode;
    this.#since = params.since ?? new Date(Date.now() - 60_000).toISOString();
  }

  #handleFailure(error: unknown): void {
    this.#consecutiveFailures += 1;
    const { fatal, message } = describeFailure(error);

    if (fatal) {
      this.#suspended = true;
      this.stop();
      console.error(`[poller] Inbound polling suspended: ${message}`);
      console.error('[poller] Fix the above and restart the server to resume.');
      return;
    }

    // Log the first few, then go quiet so a long outage does not flood the log.
    if (this.#consecutiveFailures <= 3) {
      console.error(`[poller] read failed (${this.#consecutiveFailures}): ${message}`);
    } else if (this.#consecutiveFailures === 4) {
      console.error('[poller] read still failing; suppressing further messages until it recovers.');
    }
  }

  /** True when polling gave up because of a setup problem. */
  get suspended(): boolean {
    return this.#suspended;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.#intervalMs);
    // Do not keep the process alive purely to poll.
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Exposed for tests and for an on-demand reconciliation sweep. */
  async tick(): Promise<number> {
    // Never let ticks overlap; a slow SFMC response would otherwise stack them.
    if (this.#running || this.#suspended) return 0;
    this.#running = true;

    try {
      const rows = await this.#client.readInboundRows(this.#since);
      this.#consecutiveFailures = 0;
      let accepted = 0;

      for (const row of rows) {
        const inbound = toInboundMessage(row, this.#shortCode);
        if (!inbound) continue;

        if (this.#ingest.ingest(inbound).accepted) accepted += 1;
        if (inbound.receivedAt > this.#since) this.#since = inbound.receivedAt;
      }
      return accepted;
    } catch (error) {
      this.#handleFailure(error);
      return 0;
    } finally {
      this.#running = false;
    }
  }
}

/**
 * Distinguish "not configured yet" from "temporarily broken".
 *
 * A missing Data Extension is a setup problem that will not fix itself, so
 * polling suspends with one actionable message rather than logging the same
 * error every few seconds. Transient errors keep retrying.
 */
function describeFailure(error: unknown): { fatal: boolean; message: string } {
  if (error instanceof SfmcApiError) {
    if (error.status === 404) {
      return {
        fatal: true,
        message:
          'the inbound Data Extension was not found. Create it per sfmc-assets/inbound-data-extension.md (SETUP.md step 4), check SFMC_INBOUND_DE_KEY matches its external key, and confirm SFMC_ACCOUNT_ID points at the business unit that owns it.',
      };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        fatal: true,
        message:
          'access was denied. The Installed Package likely lacks the data_extensions_read scope, or the token is scoped to the wrong business unit.',
      };
    }
    return { fatal: false, message: error.message };
  }
  return { fatal: false, message: error instanceof Error ? error.message : String(error) };
}

function toInboundMessage(
  row: { keys: Record<string, string>; values: Record<string, string> },
  shortCode: string,
): InboundMessage | undefined {
  const mobileNumber = row.values['MobileNumber'];
  const body = row.values['MessageBody'];
  const receivedAt = row.values['ReceivedAt'];
  if (!mobileNumber || body === undefined || !receivedAt) return undefined;

  const messageId = row.keys['MessageId'] ?? `${mobileNumber}:${receivedAt}`;

  return {
    channel: 'sms',
    mobileNumber,
    channelAddress: row.values['ShortCode'] ?? shortCode,
    body,
    receivedAt,
    dedupeKey: `sms:${messageId}`,
    source: 'de-poller',
  };
}
