import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Configuration, read once at boot.
 *
 * The app runs in `mock` mode by default so it is usable without an SFMC
 * tenant. Set SFMC_MODE=live once credentials exist.
 */

/**
 * Load `.env` from the repository root.
 *
 * Real values never live in the repo: `.env` is gitignored and `.env.example`
 * is the template. Variables already present in the environment win, so an
 * explicit `SFMC_MODE=live npm run dev` overrides the file.
 */
function loadEnvFile(): void {
  // Never read a developer's .env during tests: real values leaking in makes
  // config assertions depend on whoever happens to be running them.
  if (process.env['VITEST'] || process.env['NODE_ENV'] === 'test') return;

  const envPath = resolve(process.cwd(), '../.env');
  const localPath = resolve(process.cwd(), '.env');
  const target = existsSync(envPath) ? envPath : existsSync(localPath) ? localPath : undefined;
  if (!target) return;

  try {
    process.loadEnvFile(target);
  } catch (error) {
    console.warn(`[config] Could not read ${target}:`, error);
  }
}

loadEnvFile();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export type SfmcMode = 'mock' | 'live';

/**
 * One short or long code the app can converse on.
 *
 * An account may own several, and a conversation belongs to exactly one of
 * them: a subscription, a keyword and a send definition are all scoped to a
 * code, so a thread started on one code cannot be answered from another.
 */
export interface MessagingCode {
  /** The code itself. Digits only, no separators. */
  code: string;
  /**
   * Two-letter country code. Documented as required for short codes and
   * omitted for long codes, which carry their country in the number.
   */
  countryCode: string;
  /**
   * The Transactional Messaging send definition bound to this code.
   *
   * A definition names exactly one shortCode/keyword pair, so multiple codes
   * mean multiple definitions.
   */
  definitionKey: string;
  /**
   * Encoded message ID of an API-triggered MobileConnect Outbound message on
   * this code, used only by the `mobileconnect` transport.
   *
   * Minted when the message is activated in the UI; there is no API to create
   * one, which is why it is supplied rather than provisioned.
   */
  smsMessageDefinition?: string;
}

export interface Config {
  port: number;
  mode: SfmcMode;
  sfmc: {
    subdomain: string;
    clientId: string;
    clientSecret: string;
    /** Every code the agent may start a conversation on. May be empty. */
    codes: MessagingCode[];
    /**
     * Transactional Messaging send definition key for the default code.
     *
     * Unlike a MobileConnect message, this definition is created by API, so the
     * app can provision it rather than asking the user to build one in the UI.
     */
    definitionKey: string;
    /** Keyword contacts subscribed on. Required on a send definition. */
    keyword: string;
    /** The default code: the first configured one, or '' when none are. */
    shortCode: string;
    /** Country code of the default code. */
    countryCode: string;
    /** MobileConnect Outbound message ID for the default code, if supplied. */
    smsMessageDefinition?: string;
    /** External key of the Data Extension the Text Response writes inbound rows into. */
    inboundDataExtensionKey: string;
    /**
     * Business unit MID. Optional.
     *
     * Access tokens act in the context of a single business unit. Left unset,
     * the token lands on the package's own business unit. Set it to target a
     * specific child BU, which is usually where the short code and Data
     * Extension actually live.
     */
    accountId?: string;
  };
  /** Shared secret the AMPscript webhook must present. */
  inboundWebhookSecret: string;
  /**
   * Which API carries outbound messages.
   *
   * `transactional` uses a send definition the app provisions itself.
   * `mobileconnect` uses a hand-built Outbound message, which must be created
   * and activated in the UI to mint its encoded ID.
   */
  outboundTransport: 'transactional' | 'mobileconnect';
  /**
   * Event Notification Service settings.
   *
   * ENS delivers outbound delivery receipts. It needs a publicly reachable
   * HTTPS URL, so it stays inert until one is configured.
   */
  ens: {
    /** Public HTTPS URL of this server's /ens/callback route. No port, no query string. */
    callbackUrl: string;
    callbackName: string;
    subscriptionName: string;
  };
  /** How often the Data Extension poller runs, in milliseconds. */
  pollIntervalMs: number;
  redirectUri: string;
  /**
   * Whether the SFMC messaging artefacts exist yet.
   *
   * Credentials arrive before the Outbound message and Data Extension do, so
   * live mode has to boot usefully while sending is still impossible.
   */
  messaging: {
    canSend: boolean;
    canPoll: boolean;
    warnings: string[];
  };
}

/** Placeholder values that mean "not configured yet" rather than a real id. */
const PLACEHOLDERS = new Set(['', 'mock-message-id', '00000']);

/**
 * Read the configured codes.
 *
 * `SFMC_SHORT_CODES` is the multi-code form: a comma-separated list where each
 * entry is `code` or `code:countryCode`. `SFMC_SHORT_CODE` plus
 * `SFMC_COUNTRY_CODE` remains the single-code form and is used when the list is
 * absent, so an existing `.env` keeps working untouched.
 *
 * The first code is the default. It keeps the configured definition key so a
 * tenant that already provisioned one does not end up with an orphan; any
 * further code gets a derived key, because a send definition binds to exactly
 * one code.
 */
function parseCodes(): MessagingCode[] {
  const baseDefinitionKey = optional('SFMC_DEFINITION_KEY', 'sfmc-chat-outbound');
  const list = optional('SFMC_SHORT_CODES', '').trim();

  const entries = list
    ? list.split(',')
    : [[optional('SFMC_SHORT_CODE', ''), optional('SFMC_COUNTRY_CODE', '')].join(':')];

  const codes: MessagingCode[] = [];
  for (const entry of entries) {
    const [rawCode = '', rawCountry = ''] = entry.split(':');
    const code = rawCode.replace(/\s/g, '');
    if (!code || PLACEHOLDERS.has(code)) continue;
    // Duplicates would produce two conflicting definitions for one code.
    if (codes.some((existing) => existing.code === code)) continue;

    // The MobileConnect message ID applies to the default code only: each code
    // needs its own hand-built message, so additional ones must be supplied
    // per code once that is needed.
    const messageId = codes.length === 0 ? optional('SFMC_SMS_MESSAGE_DEFINITION', '') : '';

    codes.push({
      code,
      countryCode: rawCountry.trim().toUpperCase(),
      definitionKey: codes.length === 0 ? baseDefinitionKey : `${baseDefinitionKey}-${code}`,
      ...(messageId ? { smsMessageDefinition: messageId } : {}),
    });
  }
  return codes;
}

export function loadConfig(): Config {
  const mode = optional('SFMC_MODE', 'mock') as SfmcMode;
  const live = mode === 'live';

  const codes = parseCodes();
  const [defaultCode] = codes;

  const config: Config = {
    port: Number(optional('PORT', '3000')),
    mode,
    sfmc: {
      subdomain: live ? required('SFMC_SUBDOMAIN') : optional('SFMC_SUBDOMAIN', 'mock-subdomain'),
      clientId: live ? required('SFMC_CLIENT_ID') : optional('SFMC_CLIENT_ID', 'mock-client'),
      clientSecret: live
        ? required('SFMC_CLIENT_SECRET')
        : optional('SFMC_CLIENT_SECRET', 'mock-secret'),
      codes,
      definitionKey: defaultCode?.definitionKey ?? optional('SFMC_DEFINITION_KEY', 'sfmc-chat-outbound'),
      keyword: optional('SFMC_KEYWORD', 'CHAT'),
      shortCode: defaultCode?.code ?? '',
      countryCode: defaultCode?.countryCode ?? '',
      ...(defaultCode?.smsMessageDefinition
        ? { smsMessageDefinition: defaultCode.smsMessageDefinition }
        : {}),
      inboundDataExtensionKey: optional('SFMC_INBOUND_DE_KEY', 'ChatInbound'),
      ...(process.env['SFMC_ACCOUNT_ID'] ? { accountId: process.env['SFMC_ACCOUNT_ID'] } : {}),
    },
    // Setting a MobileConnect message ID is an explicit act, so treat it as
    // choosing that transport unless overridden.
    outboundTransport:
      (process.env['SFMC_OUTBOUND_TRANSPORT'] as 'transactional' | 'mobileconnect' | undefined) ??
      (process.env['SFMC_SMS_MESSAGE_DEFINITION'] ? 'mobileconnect' : 'transactional'),
    ens: {
      // Strip any trailing slash: SFMC matches the URL exactly and rejects
      // duplicates, so a stray slash creates a second, conflicting callback.
      callbackUrl: optional('ENS_CALLBACK_URL', '').trim().replace(/\/$/, ''),
      callbackName: optional('ENS_CALLBACK_NAME', 'sfmc-chat-delivery'),
      subscriptionName: optional('ENS_SUBSCRIPTION_NAME', 'sfmc-chat-sms-delivery'),
    },
    inboundWebhookSecret: optional('INBOUND_WEBHOOK_SECRET', 'dev-secret-change-me'),
    pollIntervalMs: Number(optional('POLL_INTERVAL_MS', '5000')),
    redirectUri: optional('REDIRECT_URI', 'https://127.0.0.1:3000/auth/callback'),
    messaging: { canSend: false, canPoll: false, warnings: [] },
  };

  config.messaging = assessMessagingReadiness(config, live);
  return config;
}

/**
 * Find the code a request is asking for.
 *
 * An absent `shortCode` means "the default". An unrecognised one is not
 * silently coerced to the default: sending from a code the account does not own
 * fails deep inside SFMC with an opaque error, so it is rejected up front.
 */
export function resolveCode(config: Config, shortCode?: string): MessagingCode | undefined {
  const wanted = (shortCode ?? '').replace(/\s/g, '');
  if (!wanted) return config.sfmc.codes[0];
  return config.sfmc.codes.find((entry) => entry.code === wanted);
}

function assessMessagingReadiness(config: Config, live: boolean): Config['messaging'] {
  if (!live) return { canSend: true, canPoll: true, warnings: [] };

  const warnings: string[] = [];

  // The send definitions are provisioned by the app, so the codes are the only
  // thing that must come from the customer's account.
  const hasCode = config.sfmc.codes.length > 0;
  const hasDeKey = config.sfmc.inboundDataExtensionKey.trim() !== '';

  if (!hasCode) {
    warnings.push(
      'No short or long code is configured. Outbound sending is disabled until you set SFMC_SHORT_CODE (or SFMC_SHORT_CODES for several) to the code your contacts subscribed on. Open the setup screen at /#setup for the rest.',
    );
  }
  if (!hasDeKey) {
    warnings.push(
      'SFMC_INBOUND_DE_KEY is not set. Inbound polling is disabled until the ChatInbound Data Extension exists (SETUP.md step 4).',
    );
  }

  return { canSend: hasCode, canPoll: hasDeKey, warnings };
}
