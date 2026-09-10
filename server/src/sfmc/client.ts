import { randomUUID } from 'node:crypto';
import type { Config } from '../config/index.js';
import { resolveCode } from '../config/index.js';
import type { MessagingCode } from '../config/index.js';
import type { TokenProvider } from '../auth/tokenProvider.js';
import { anyOf, parseResults, simpleFilter, soapRetrieve } from './soap.js';

export interface SendSmsResult {
  tokenId: string;
}

/** Carries the HTTP status so callers can distinguish "not found" from "broken". */
export class SfmcApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'SfmcApiError';
    this.status = status;
    this.body = body;
  }
}

export type SubscriptionState = 'subscribed' | 'unsubscribed' | 'in_progress' | 'unknown';

/**
 * One subscription of a mobile number to a code.
 *
 * A number can hold several: subscription is per short code and keyword, not
 * per account, which is why every record names the code it belongs to.
 */
export interface SubscriptionRecord {
  mobileNumber: string;
  subscriberKey?: string;
  shortCode?: string;
  keyword?: string;
  optInDate?: string;
  status: SubscriptionState;
}

/** A subscriber found by search, always carrying a phone number. */
export interface SubscriberMatch {
  mobileNumber: string;
  subscriberKey?: string;
  emailAddress?: string;
  /** Codes this number is already subscribed to, so the UI need not guess. */
  subscriptions: SubscriptionRecord[];
}

export interface OptInResult {
  /** SFMC's handle for the queued mobile-originated message. */
  identifier?: string;
}

/** One recipient's delivery outcome from a MobileConnect send. */
export interface DeliveryReport {
  mobileNumber: string;
  /** SFMC's standard status code: 2000 aggregator, 4000 delivered, 45xx failed. */
  standardStatusCode: number;
  description?: string;
}

export interface DataExtensionRow {
  keys: Record<string, string>;
  values: Record<string, string>;
}

/**
 * The SFMC operations this app needs. Implemented live against REST, and by a
 * mock for local development.
 */
export interface SfmcClient {
  sendSms(mobileNumber: string, text: string, shortCode?: string): Promise<SendSmsResult>;
  /**
   * Subscribe a number to a keyword on a code by replaying the opt-in text the
   * customer would otherwise have sent themselves.
   */
  optIn(params: {
    mobileNumber: string;
    shortCode: string;
    keyword: string;
    subscriberKey?: string;
  }): Promise<OptInResult>;
  getSubscriptionStatus(mobileNumbers: string[]): Promise<SubscriptionRecord[]>;
  /** Free-text lookup over All Subscribers, restricted to those with a phone number. */
  searchSubscribers(query: string, limit?: number): Promise<SubscriberMatch[]>;
  readInboundRows(sinceIso: string): Promise<DataExtensionRow[]>;
  /**
   * Delivery outcome of a MobileConnect send, by the tokenId it returned.
   *
   * ENS covers this for transactional sends, but MobileConnect emits no
   * notifications, so its status has to be pulled.
   */
  getDeliveryStatus(tokenId: string): Promise<DeliveryReport[]>;
}

/** Retry budget for 429s. Salesforce documents Retry-After and expects backoff. */
const MAX_ATTEMPTS = 4;

/** queueMO rejects anything outside this range before it reaches the carrier. */
export const MIN_NUMBER_DIGITS = 8;
export const MAX_NUMBER_DIGITS = 15;

export class RestSfmcClient implements SfmcClient {
  #config: Config;
  #tokens: TokenProvider;
  /** Query form this tenant accepts on the rowset endpoint, learned on first read. */
  #rowsetQuery: string | undefined;

  constructor(config: Config, tokens: TokenProvider) {
    this.#config = config;
    this.#tokens = tokens;
  }

  /**
   * Send arbitrary text through the Transactional Messaging SMS API.
   *
   * `content.message` is documented as "an override for the message content in
   * the send definition", which is what lets a chat app send text that was
   * never authored in SFMC. Unlike MobileConnect's request-level `messageText`,
   * this rides on the recipient call, so the definition stays a fixed template
   * the app provisions once.
   *
   * The definition is chosen by code, because a definition binds to exactly one
   * shortCode/keyword pair.
   *
   * https://developer.salesforce.com/docs/marketing/marketing-cloud/references/mc_rest_transactional_messaging_sms/sendSMSMessageSingleRecipient.html
   */
  async sendSms(mobileNumber: string, text: string, shortCode?: string): Promise<SendSmsResult> {
    if (!this.#config.messaging.canSend) {
      throw new Error(
        'Cannot send: outbound is not configured. Open /#setup to finish provisioning.',
      );
    }

    // A subscription, keyword and send definition are all scoped to one code,
    // so the thread's code decides which definition carries the message.
    const code = resolveCode(this.#config, shortCode);
    if (!code) {
      throw new Error(
        shortCode
          ? `Cannot send: ${shortCode} is not a configured code.`
          : 'Cannot send: no messaging code is configured.',
      );
    }

    return this.#config.outboundTransport === 'mobileconnect'
      ? this.#sendViaMobileConnect(mobileNumber, text, code)
      : this.#sendViaTransactional(mobileNumber, text, code);
  }

  /**
   * Transactional Messaging path.
   *
   * `content.message` is documented as "an override for the message content in
   * the send definition", which is what lets a chat app send text that was
   * never authored in SFMC.
   *
   * The code a message leaves on is fixed by the definition, not by the send:
   * the documented body carries only `definitionKey`, `recipient` and
   * `content.message`. So targeting a code means choosing its definition, and
   * an account with several codes has one definition per code.
   *
   * https://developer.salesforce.com/docs/marketing/marketing-cloud/references/mc_rest_transactional_messaging_sms/sendSMSMessageSingleRecipient.html
   */
  async #sendViaTransactional(
    mobileNumber: string,
    text: string,
    code: MessagingCode,
  ): Promise<SendSmsResult> {
    const number = normaliseNumber(mobileNumber);
    // Must be unique within the business unit for 72 hours, and it is the
    // handle later delivery events correlate against.
    const messageKey = randomUUID();

    const json = await this.#request<{ requestId: string; errorcode?: number }>(
      'POST',
      `/messaging/v1/sms/messages/${messageKey}`,
      {
        definitionKey: code.definitionKey,
        recipient: {
          to: number,
          // Required alongside `to`; the API rejects a recipient without both.
          contactKey: number,
        },
        content: { message: text },
        subscriptions: { resubscribe: true },
      },
    );

    if (json.errorcode !== undefined && json.errorcode !== 0) {
      throw new Error(`SFMC rejected the send (errorcode ${json.errorcode})`);
    }
    return { tokenId: messageKey };
  }

  /**
   * MobileConnect path, against a hand-built API-triggered Outbound message.
   *
   * `Override: true` with a request-level `messageText` replaces the saved
   * body. Note `messageText` is request-level rather than per-subscriber, so a
   * chat send is inherently one request per message.
   */
  async #sendViaMobileConnect(
    mobileNumber: string,
    text: string,
    code: MessagingCode,
  ): Promise<SendSmsResult> {
    const messageId = code.smsMessageDefinition;
    if (!messageId) {
      throw new Error(
        `Cannot send: no MobileConnect message ID for code ${code.code}. Activate an API-triggered Outbound message on that code and set SFMC_SMS_MESSAGE_DEFINITION.`,
      );
    }

    const json = await this.#request<{ tokenId: string }>(
      'POST',
      `/sms/v1/messageContact/${encodeURIComponent(messageId)}/send`,
      {
        mobileNumbers: [normaliseNumber(mobileNumber)],
        Subscribe: true,
        Resubscribe: true,
        // Required whenever Subscribe or Resubscribe is true, and must belong
        // to the code the message is on.
        keyword: this.#config.sfmc.keyword,
        Override: true,
        messageText: text,
      },
    );
    return { tokenId: json.tokenId };
  }

  async optIn(params: {
    mobileNumber: string;
    shortCode: string;
    keyword: string;
    subscriberKey?: string;
  }): Promise<OptInResult> {
    const number = normaliseNumber(params.mobileNumber);
    assertSendableNumber(number);

    const json = await this.#request<{
      results?: Array<{ identifier?: string; result?: string }>;
    }>('POST', '/sms/v1/queueMO', {
      ...(params.subscriberKey
        ? { subscribers: [{ mobilenumber: number, subscriberkey: params.subscriberKey }] }
        : { mobileNumbers: [number] }),
      shortCode: params.shortCode,
      messageText: params.keyword,
    });

    const identifier = json.results?.[0]?.identifier;
    return identifier ? { identifier } : {};
  }

  /**
   * MobileConnect only delivers to numbers holding a `Subscribed` status on the
   * short code, so the UI checks before letting an agent type.
   *
   * The documented request key is `mobileNumber` holding an array, not
   * `mobileNumbers`, and the response is a `contacts` array of one entry per
   * number-and-code pair rather than a flat status per number.
   *
   * https://developer.salesforce.com/docs/marketing/marketing-cloud/references/mc_rest_sms/contactsSubscriptions.html
   */
  async getSubscriptionStatus(mobileNumbers: string[]): Promise<SubscriptionRecord[]> {
    const numbers = mobileNumbers.map(normaliseNumber).filter(Boolean);
    if (numbers.length === 0) return [];
    return this.#readSubscriptions({ mobileNumber: numbers });
  }

  /**
   * Search All Subscribers, keeping only records that have a phone number.
   *
   * Two documented reads, composed:
   *
   * 1. SOAP `Retrieve` on `Subscriber`. This is the All Subscribers list
   *    itself, and it is the only read that supports a partial match, so it is
   *    what makes "type part of an email" work. REST offers exact-match address
   *    lookup only.
   * 2. `POST /sms/v1/contacts/subscriptions` keyed by the subscriber keys the
   *    first step returned. This is what supplies the mobile number, in one
   *    call for up to 500 keys, along with the code and keyword each number is
   *    already subscribed to.
   *
   * A subscriber with no MobileConnect record simply produces no entry in step
   * two and is dropped, which is exactly the "has a phone number" filter.
   *
   * A query that is already a phone number also goes straight to step two, so a
   * number known to MobileConnect is found even when its subscriber key looks
   * nothing like it.
   */
  async searchSubscribers(query: string, limit = 20): Promise<SubscriberMatch[]> {
    const term = query.trim();
    if (!term) return [];

    const digits = normaliseNumber(term);
    const looksLikeNumber = digits.length >= MIN_NUMBER_DIGITS && digits.length <= MAX_NUMBER_DIGITS;

    const [subscribers, byNumber] = await Promise.all([
      this.#retrieveSubscribers(term, limit),
      looksLikeNumber
        ? this.#readSubscriptions({ mobileNumber: [digits] }).catch(() => [])
        : Promise.resolve<SubscriptionRecord[]>([]),
    ]);

    const keys = subscribers.map((row) => row.subscriberKey).filter((key): key is string => !!key);
    const byKey = keys.length > 0 ? await this.#readSubscriptions({ subscriberKey: keys }) : [];

    return mergeMatches(subscribers, [...byKey, ...byNumber]).slice(0, limit);
  }

  /**
   * Read inbound rows the Text Response message wrote via InsertData().
   *
   * There is no REST resource for data views, so inbound capture goes through a
   * Data Extension we own rather than `_SMSMessageTracking` directly.
   *
   * The rowset endpoint rejects `$filter` on this shape of request
   * ("request parameter $filter could not be resolved", errorcode 10003), and
   * support for `$orderBy` varies by tenant. Rather than guess, the client
   * probes once and remembers what the tenant accepts, then narrows by
   * timestamp client-side. Re-reading rows is harmless because ingest is
   * idempotent.
   */
  async readInboundRows(sinceIso: string): Promise<DataExtensionRow[]> {
    const key = encodeURIComponent(this.#config.sfmc.inboundDataExtensionKey);
    const path = `/data/v1/customobjectdata/key/${key}/rowset`;

    const attempts: string[] =
      this.#rowsetQuery === undefined
        ? [`?$pagesize=250&$orderBy=ReceivedAt%20desc`, `?$pagesize=250`, '']
        : [this.#rowsetQuery];

    let lastError: unknown;
    for (const query of attempts) {
      try {
        const json = await this.#request<{
          items?: Array<{ keys?: Record<string, string>; values?: Record<string, string> }>;
        }>('GET', `${path}${query}`);

        // Remember the first form this tenant accepts.
        this.#rowsetQuery = query;

        return (json.items ?? [])
          .map((item) => ({ keys: item.keys ?? {}, values: item.values ?? {} }))
          .filter((row) => (row.values['ReceivedAt'] ?? '') > sinceIso);
      } catch (error) {
        // Only an unsupported-parameter error is worth retrying with a simpler
        // query; anything else is a real failure and must surface.
        if (error instanceof SfmcApiError && error.status === 400) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    throw lastError ?? new Error('Could not read the inbound Data Extension');
  }

  /**
   * One partial-match sweep of All Subscribers.
   *
   * The same `like` term is applied to both the email address and the
   * subscriber key rather than branching on what the query looks like: accounts
   * differ in whether a mobile contact is keyed by its number, and an OR costs
   * the same single call as either half alone.
   */
  async #retrieveSubscribers(
    term: string,
    limit: number,
  ): Promise<Array<{ subscriberKey?: string; emailAddress?: string }>> {
    const pattern = `%${term}%`;
    const xml = await soapRetrieve(
      this.#tokens,
      'Subscriber',
      ['SubscriberKey', 'EmailAddress'],
      anyOf([
        simpleFilter('EmailAddress', 'like', pattern),
        simpleFilter('SubscriberKey', 'like', pattern),
      ]),
    );

    // A retrieve that the tenant refuses is not fatal to the search: the direct
    // number lookup may still answer it.
    return parseResults(xml, ['SubscriberKey', 'EmailAddress'])
      .slice(0, limit)
      .map((row) => ({
        ...(row['SubscriberKey'] ? { subscriberKey: row['SubscriberKey'] } : {}),
        ...(row['EmailAddress'] ? { emailAddress: row['EmailAddress'] } : {}),
      }));
  }

  async #readSubscriptions(body: {
    mobileNumber?: string[];
    subscriberKey?: string[];
  }): Promise<SubscriptionRecord[]> {
    const total = (body.mobileNumber?.length ?? 0) + (body.subscriberKey?.length ?? 0);
    if (total === 0) return [];
    if (total > 500) {
      throw new Error('SFMC accepts at most 500 values per subscription lookup');
    }

    const json = await this.#request<{
      contacts?: Array<{
        mobileNumber?: string;
        subscriberKey?: string;
        shortCode?: string;
        keyword?: string;
        optInDate?: string;
        status?: string;
      }>;
    }>('POST', '/sms/v1/contacts/subscriptions', body);

    return (json.contacts ?? [])
      .filter((row) => row.mobileNumber)
      .map((row) => ({
        mobileNumber: normaliseNumber(row.mobileNumber ?? ''),
        ...(row.subscriberKey ? { subscriberKey: row.subscriberKey } : {}),
        ...(row.shortCode ? { shortCode: row.shortCode } : {}),
        ...(row.keyword ? { keyword: row.keyword } : {}),
        ...(row.optInDate ? { optInDate: row.optInDate } : {}),
        status: readSubscriptionState(row),
      }));
  }

  async getDeliveryStatus(tokenId: string): Promise<DeliveryReport[]> {
    const messageId = this.#config.sfmc.smsMessageDefinition;
    if (!messageId) return [];

    const json = await this.#request<{
      tracking?: Array<{
        mobileNumber?: string;
        standardStatusCode?: string;
        description?: string;
      }>;
    }>(
      'GET',
      `/sms/v1/messageContact/${encodeURIComponent(messageId)}/deliveries/${encodeURIComponent(tokenId)}`,
    );

    return (json.tracking ?? [])
      .map((row) => ({
        mobileNumber: row.mobileNumber ?? '',
        standardStatusCode: Number(row.standardStatusCode ?? 0),
        ...(row.description ? { description: row.description } : {}),
      }))
      .filter((row) => Number.isFinite(row.standardStatusCode) && row.standardStatusCode > 0);
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const token = await this.#tokens.getAccessToken();
      const response = await fetch(`${token.restInstanceUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      if (response.ok) {
        return (await response.json()) as T;
      }

      // Salesforce throttles with 429 and a Retry-After header. Honour it
      // rather than guessing, and fall back to exponential backoff.
      if (response.status === 429 && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 2 ** attempt * 1000;
        await sleep(delayMs);
        lastError = new Error(`Rate limited by SFMC (attempt ${attempt})`);
        continue;
      }

      const text = await response.text();
      throw new SfmcApiError(
        `SFMC ${method} ${path} failed (${response.status}): ${text}`,
        response.status,
        text,
      );
    }

    throw lastError ?? new Error(`SFMC ${method} ${path} failed after ${MAX_ATTEMPTS} attempts`);
  }
}

/**
 * SFMC rejects formatted numbers: "1-317-555-1212 is not a numeric string".
 * Strip everything that is not a digit.
 */
export function normaliseNumber(input: string): string {
  return input.replace(/\D/g, '');
}

/**
 * Reject a number SFMC would reject, with a message an agent can act on.
 *
 * queueMO documents 8 to 15 digits including the country code. Catching it here
 * turns a 400 with an opaque body into a sentence about the missing country
 * code, which is what the mistake almost always is.
 */
export function assertSendableNumber(number: string): void {
  if (number.length < MIN_NUMBER_DIGITS || number.length > MAX_NUMBER_DIGITS) {
    throw new Error(
      `"${number}" is ${number.length} digits. SFMC requires ${MIN_NUMBER_DIGITS} to ${MAX_NUMBER_DIGITS}, including the country code and with no separators.`,
    );
  }
}

/** Pick the subscription for one number on one code, if there is one. */
export function subscriptionFor(
  records: SubscriptionRecord[],
  mobileNumber: string,
  shortCode: string,
): SubscriptionRecord | undefined {
  const number = normaliseNumber(mobileNumber);
  return records.find(
    (record) => record.mobileNumber === number && (!record.shortCode || record.shortCode === shortCode),
  );
}

/**
 * Derive a status from a subscription row.
 *
 * The documented response carries an `optInDate` rather than a status field, so
 * that is what is read. Some tenants also return an explicit status; it is
 * honoured when present. An absent row means "SFMC told us nothing", which is
 * reported as `unknown` rather than asserted as unsubscribed.
 */
function readSubscriptionState(row: { optInDate?: string; status?: string }): SubscriptionState {
  switch ((row.status ?? '').toLowerCase()) {
    case 'subscribed':
    case 'active':
      return 'subscribed';
    case 'unsubscribed':
    case 'optedout':
      return 'unsubscribed';
    case 'inprogress':
    case 'in progress':
      return 'in_progress';
    default:
      return row.optInDate ? 'subscribed' : 'unknown';
  }
}

/**
 * Join the All Subscribers rows to their MobileConnect subscriptions.
 *
 * Grouped by number rather than by subscriber key, because a number is what a
 * conversation is addressed to and one number can appear under several keys.
 */
function mergeMatches(
  subscribers: Array<{ subscriberKey?: string; emailAddress?: string }>,
  subscriptions: SubscriptionRecord[],
): SubscriberMatch[] {
  const emailByKey = new Map<string, string>();
  for (const row of subscribers) {
    if (row.subscriberKey && row.emailAddress) emailByKey.set(row.subscriberKey, row.emailAddress);
  }

  const byNumber = new Map<string, SubscriberMatch>();
  for (const record of subscriptions) {
    if (!record.mobileNumber) continue;

    const existing = byNumber.get(record.mobileNumber);
    const match: SubscriberMatch = existing ?? {
      mobileNumber: record.mobileNumber,
      subscriptions: [],
    };

    match.subscriptions.push(record);
    if (!match.subscriberKey && record.subscriberKey) match.subscriberKey = record.subscriberKey;

    const email = record.subscriberKey ? emailByKey.get(record.subscriberKey) : undefined;
    if (!match.emailAddress && email) match.emailAddress = email;

    byNumber.set(record.mobileNumber, match);
  }

  return [...byNumber.values()];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
