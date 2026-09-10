import type { Config, MessagingCode } from '../config/index.js';
import { resolveCode } from '../config/index.js';
import type { TokenProvider } from '../auth/tokenProvider.js';
import { SfmcApiError } from './client.js';
import { escapeXml, extractSoapError, isSoapOk, soapMutate, soapRetrieve } from './soap.js';

/**
 * Setup-time operations, kept separate from the runtime messaging client.
 *
 * Only three of the artefacts this app needs can be created by API. The rest
 * (Installed Package, MobileConnect Text Response, conversation window, short
 * code) have no documented create operation and stay manual - see
 * sfmc-assets/SETUP.md.
 *
 * Every code-scoped operation takes an optional `shortCode`. Omitted, it acts
 * on the default code. An account with several codes needs one keyword and one
 * send definition per code, because both bind to exactly one code.
 */
export interface SfmcProvisioner {
  createInboundDataExtension(): Promise<ProvisionResult>;
  createKeyword(shortCode?: string): Promise<ProvisionResult>;
  createSendDefinition(shortCode?: string): Promise<ProvisionResult>;
  getSendDefinition(shortCode?: string): Promise<{ exists: boolean; status?: string }>;
  /**
   * How many MO keyword objects exist.
   *
   * These appear when a Text Response message binds behaviour to a keyword, so
   * a non-zero count is evidence that the manual inbound step is done. Returns
   * undefined when the check itself could not run.
   */
  countBoundMoKeywords(): Promise<number | undefined>;
  /** Replays an inbound message so setup can be verified without a handset. */
  simulateInbound(mobileNumber: string, text: string, shortCode?: string): Promise<ProvisionResult>;
}

export interface ProvisionResult {
  ok: boolean;
  /** True when the artefact already existed, which is not a failure. */
  alreadyExists?: boolean;
  detail: string;
}

/** Name of the outbound send definition this app provisions. */
export const OUTBOUND_DEFINITION_NAME = 'Two-Way Chat Outbound';

/**
 * Name to give the Text Response message.
 *
 * Deliberately the inbound counterpart of OUTBOUND_DEFINITION_NAME: they are
 * different objects in opposite directions, and sharing a name makes them very
 * hard to tell apart later.
 */
export const INBOUND_MESSAGE_NAME = 'Two-Way Chat Inbound';

/** Field spec for the inbound Data Extension, mirroring inbound-data-extension.md. */
const INBOUND_FIELDS = [
  { name: 'MessageId', type: 'Text', maxLength: 100, primaryKey: true, required: true },
  { name: 'MobileNumber', type: 'Text', maxLength: 20, primaryKey: false, required: true },
  { name: 'SubscriberKey', type: 'Text', maxLength: 254, primaryKey: false, required: false },
  { name: 'MessageBody', type: 'Text', maxLength: 500, primaryKey: false, required: false },
  { name: 'Keyword', type: 'Text', maxLength: 50, primaryKey: false, required: false },
  { name: 'ShortCode', type: 'Text', maxLength: 20, primaryKey: false, required: false },
  { name: 'ReceivedAt', type: 'Date', maxLength: undefined, primaryKey: false, required: true },
] as const;

export class RestSfmcProvisioner implements SfmcProvisioner {
  #config: Config;
  #tokens: TokenProvider;

  constructor(config: Config, tokens: TokenProvider) {
    this.#config = config;
    this.#tokens = tokens;
  }

  /**
   * Data Extension creation is SOAP-only. No REST route creates a Data
   * Extension; the REST data routes are all row-level.
   */
  async createInboundDataExtension(): Promise<ProvisionResult> {
    const key = this.#config.sfmc.inboundDataExtensionKey;
    const fields = INBOUND_FIELDS.map((field) => {
      const parts = [
        `<Name>${escapeXml(field.name)}</Name>`,
        `<FieldType>${field.type}</FieldType>`,
        `<IsPrimaryKey>${field.primaryKey}</IsPrimaryKey>`,
        // A primary key cannot also be nullable.
        `<IsRequired>${field.required || field.primaryKey}</IsRequired>`,
      ];
      if (field.maxLength !== undefined) parts.push(`<MaxLength>${field.maxLength}</MaxLength>`);
      return `<Field>${parts.join('')}</Field>`;
    }).join('');

    const body = `<Objects xsi:type="DataExtension">
      <CustomerKey>${escapeXml(key)}</CustomerKey>
      <Name>${escapeXml(key)}</Name>
      <Description>Inbound SMS captured by the two-way chat app</Description>
      <Fields>${fields}</Fields>
    </Objects>`;

    const response = await soapMutate(this.#tokens, 'Create', body);

    if (/<StatusCode>OK<\/StatusCode>/.test(response)) {
      return { ok: true, detail: `Created Data Extension "${key}".` };
    }
    // SFMC reports "already exists" as an error; for provisioning that is success.
    if (/already exists|duplicate/i.test(response)) {
      return { ok: true, alreadyExists: true, detail: `Data Extension "${key}" already exists.` };
    }
    return { ok: false, detail: extractSoapError(response) };
  }

  /**
   * Provisions the keyword on the code. Note this creates the hook only - it
   * binds no inbound behaviour, which is what the Text Response message does
   * and which has no API.
   */
  async createKeyword(shortCode?: string): Promise<ProvisionResult> {
    const target = this.#resolve(shortCode);
    if (!target.ok) return target.error;

    const { keyword } = this.#config.sfmc;
    const { code, countryCode } = target.code;

    try {
      const json = await this.#rest<{ KeywordId?: string }>('POST', '/sms/v1/keyword', {
        Keyword: keyword,
        ShortCode: code,
        // Documented as required for short codes and omitted for long codes.
        ...(countryCode ? { CountryCode: countryCode } : {}),
      });
      return {
        ok: true,
        detail: `Created keyword "${keyword}" on ${code} (id ${json.KeywordId ?? 'n/a'}).`,
      };
    } catch (error) {
      if (error instanceof SfmcApiError && /exist|duplicate|already/i.test(error.body)) {
        return {
          ok: true,
          alreadyExists: true,
          detail: `Keyword "${keyword}" already exists on ${code}.`,
        };
      }
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * The send definition is what replaces a hand-built MobileConnect Outbound
   * message. Its body is a placeholder: every send overrides `content.message`.
   */
  async createSendDefinition(shortCode?: string): Promise<ProvisionResult> {
    const target = this.#resolve(shortCode);
    if (!target.ok) return target.error;

    const { keyword } = this.#config.sfmc;
    const { code, countryCode, definitionKey } = target.code;

    // Salesforce documents the keyword as a prerequisite for the definition,
    // and there is no way to check whether it exists, so create it first.
    // Creating an existing keyword is reported as "already exists", not an error.
    const keywordResult = await this.createKeyword(code);

    try {
      await this.#rest('POST', '/messaging/v1/sms/definitions', {
        definitionKey,
        name: this.#definitionName(target.code),
        description: 'Created by the two-way chat app. Content is overridden per send.',
        status: 'Active',
        content: { message: 'Chat message' },
        subscriptions: {
          shortCode: code,
          ...(countryCode ? { countryCode } : {}),
          keyword,
          autoAddSubscriber: true,
          // Documented constraint: updateSubscriber true requires autoAddSubscriber true.
          updateSubscriber: true,
        },
      });
      return {
        ok: true,
        detail: `Created send definition "${definitionKey}". ${keywordResult.detail}`,
      };
    } catch (error) {
      if (error instanceof SfmcApiError && /exist|duplicate|already/i.test(error.body)) {
        // An existing but inactive definition cannot send, so fix it rather
        // than reporting a green tick on something that does not work.
        const activated = await this.#ensureDefinitionActive(target.code);
        return {
          ok: true,
          alreadyExists: true,
          detail: `Send definition "${definitionKey}" already exists. ${activated}`,
        };
      }
      if (error instanceof SfmcApiError && error.status === 404) {
        // errorcode 30003 is a code-lookup failure, not a missing API. The
        // distinction matters: one is a config fix, the other is provisioning.
        const isCodeLookup = /ObjectNotFound|Unable to find ShortCode/i.test(error.body);

        return {
          ok: false,
          detail: isCodeLookup
            ? `${error.message}

SFMC could not resolve "${code}" using countryCode "${countryCode || '(omitted)'}". The Transactional Messaging API is reachable, so this is a configuration mismatch rather than a missing feature.

Salesforce's documented rule: a SHORT code takes an alphabetic countryCode; a LONG code has the country code prepended to the number and countryCode omitted unless your account requires it.

"${code}" begins with ${code.slice(0, 2)}, which looks like a long code with an embedded country code. Try clearing the country code for this entry in .env, or setting it to the country that actually owns the code, then restart.

Also confirm SFMC_ACCOUNT_ID (${this.#config.sfmc.accountId ?? 'not set'}) is the business unit that owns this code.`
            : `${error.message}

A 404 here with no code-lookup error usually means Transactional Messaging SMS is not enabled for this account or business unit. Check that it is provisioned, that SFMC_ACCOUNT_ID is the right business unit, and that the package grants sms_write.`,
        };
      }
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Retrieve is the only operation SFMC exposes on the MO keyword objects; they
   * cannot be created by API. Property names are fussy - ObjectID and
   * CustomerKey are accepted on SendSMSMOKeyword, Keyword is not.
   */
  async countBoundMoKeywords(): Promise<number | undefined> {
    try {
      const response = await soapRetrieve(this.#tokens, 'SendSMSMOKeyword', [
        'ObjectID',
        'CustomerKey',
      ]);
      if (!isSoapOk(response)) return undefined;
      return (response.match(/<Results>/g) ?? []).length;
    } catch {
      return undefined;
    }
  }

  /**
   * Transactional send definitions are API-managed; there is no MobileConnect
   * UI to toggle them, so status changes go through PATCH.
   */
  async #ensureDefinitionActive(code: MessagingCode): Promise<string> {
    try {
      const current = await this.getSendDefinition(code.code);
      if (!current.exists) return '';
      if ((current.status ?? '').toLowerCase() === 'active') return 'It is active.';

      await this.#rest(
        'PATCH',
        `/messaging/v1/sms/definitions/${encodeURIComponent(code.definitionKey)}`,
        { status: 'Active' },
      );
      return `It was ${current.status}, and has been activated.`;
    } catch (error) {
      return `Could not activate it: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async getSendDefinition(shortCode?: string): Promise<{ exists: boolean; status?: string }> {
    const target = this.#resolve(shortCode);
    if (!target.ok) return { exists: false };

    try {
      const json = await this.#rest<{ status?: string }>(
        'GET',
        `/messaging/v1/sms/definitions/${encodeURIComponent(target.code.definitionKey)}`,
      );
      return { exists: true, ...(json.status ? { status: json.status } : {}) };
    } catch (error) {
      if (error instanceof SfmcApiError && error.status === 404) return { exists: false };
      throw error;
    }
  }

  /**
   * Replays an inbound message against the code.
   *
   * This is how setup verifies the one part it cannot automate: if the Text
   * Response message is wired correctly, this produces a row in the inbound
   * Data Extension without anyone touching a handset.
   */
  async simulateInbound(
    mobileNumber: string,
    text: string,
    shortCode?: string,
  ): Promise<ProvisionResult> {
    const target = this.#resolve(shortCode);
    if (!target.ok) return target.error;

    const { keyword } = this.#config.sfmc;
    const { code } = target.code;

    // MobileConnect treats the first token of an inbound message as the
    // keyword. A probe that does not start with a registered keyword is
    // rejected as an invalid Client/ShortCode/Keyword combination.
    const body = text.toUpperCase().startsWith(keyword.toUpperCase())
      ? text
      : `${keyword} ${text}`;

    try {
      await this.#rest('POST', '/sms/v1/queueMO', {
        mobileNumbers: [mobileNumber.replace(/\D/g, '')],
        shortCode: code,
        messageText: body,
      });
      return { ok: true, detail: `Queued a simulated inbound message: "${body}"` };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const isCombo = /combination is invalid/i.test(detail);
      return {
        ok: false,
        detail: isCombo
          ? `${detail}

SFMC rejected the keyword/code combination. The message was sent as "${body}", so check that:
  1. The keyword "${keyword}" is registered on code ${code}.
  2. SFMC_ACCOUNT_ID (${this.#config.sfmc.accountId ?? 'not set'}) is the business unit that owns the code.
  3. The mobile number is subscribed to this code.`
          : detail,
      };
    }
  }

  /**
   * Send definition names must be unique within the account.
   *
   * The default code keeps the bare name so a tenant that already provisioned
   * one is not asked to create a second; further codes are suffixed.
   */
  #definitionName(code: MessagingCode): string {
    const isDefault = this.#config.sfmc.codes[0]?.code === code.code;
    return isDefault ? OUTBOUND_DEFINITION_NAME : `${OUTBOUND_DEFINITION_NAME} (${code.code})`;
  }

  /** Resolve a code, or explain which of the two ways it failed. */
  #resolve(
    shortCode?: string,
  ): { ok: true; code: MessagingCode } | { ok: false; error: ProvisionResult } {
    const code = resolveCode(this.#config, shortCode);
    if (code) return { ok: true, code };

    return {
      ok: false,
      error: {
        ok: false,
        detail: shortCode
          ? `"${shortCode}" is not one of the configured codes.`
          : 'No short or long code is configured. Set SFMC_SHORT_CODE, or SFMC_SHORT_CODES for several.',
      },
    };
  }

  async #rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.#tokens.getAccessToken();
    const response = await fetch(`${token.restInstanceUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new SfmcApiError(
        `SFMC ${method} ${path} failed (${response.status}): ${text || '(empty response body)'}`,
        response.status,
        text,
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}
