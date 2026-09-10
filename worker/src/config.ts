import type { Config, MessagingCode } from '../../server/src/config/index.js';

/**
 * Worker environment bindings.
 *
 * Secrets are set with `wrangler secret put`; the rest live in wrangler.jsonc.
 */
export interface Env {
  CONVERSATIONS: DurableObjectNamespace;
  ASSETS: Fetcher;

  SFMC_MODE?: string;
  SFMC_SUBDOMAIN?: string;
  SFMC_CLIENT_ID?: string;
  SFMC_CLIENT_SECRET?: string;
  SFMC_ACCOUNT_ID?: string;
  SFMC_SHORT_CODE?: string;
  SFMC_SHORT_CODES?: string;
  SFMC_COUNTRY_CODE?: string;
  SFMC_KEYWORD?: string;
  SFMC_DEFINITION_KEY?: string;
  SFMC_SMS_MESSAGE_DEFINITION?: string;
  SFMC_INBOUND_DE_KEY?: string;
  SFMC_OUTBOUND_TRANSPORT?: string;
  INBOUND_WEBHOOK_SECRET?: string;
  ENS_CALLBACK_URL?: string;
  ENS_CALLBACK_NAME?: string;
  ENS_SUBSCRIPTION_NAME?: string;
}

/**
 * Build the shared Config from bindings.
 *
 * Deliberately not reusing the Node loadConfig: that reads process.env and the
 * filesystem, neither of which exists here. The shape is the contract, not the
 * loading mechanism.
 */
export function configFromEnv(env: Env): Config {
  const codes = parseCodes(env);
  const [defaultCode] = codes;

  return {
    port: 0,
    mode: (env.SFMC_MODE ?? 'live') as Config['mode'],
    sfmc: {
      subdomain: env.SFMC_SUBDOMAIN ?? '',
      clientId: env.SFMC_CLIENT_ID ?? '',
      clientSecret: env.SFMC_CLIENT_SECRET ?? '',
      codes,
      definitionKey: defaultCode?.definitionKey ?? (env.SFMC_DEFINITION_KEY ?? 'sfmc-chat-outbound'),
      keyword: env.SFMC_KEYWORD ?? 'CHAT',
      shortCode: defaultCode?.code ?? '',
      countryCode: defaultCode?.countryCode ?? '',
      inboundDataExtensionKey: env.SFMC_INBOUND_DE_KEY ?? 'ChatInbound',
      ...(defaultCode?.smsMessageDefinition
        ? { smsMessageDefinition: defaultCode.smsMessageDefinition }
        : {}),
      ...(env.SFMC_ACCOUNT_ID ? { accountId: env.SFMC_ACCOUNT_ID } : {}),
    },
    outboundTransport:
      (env.SFMC_OUTBOUND_TRANSPORT as Config['outboundTransport'] | undefined) ??
      (env.SFMC_SMS_MESSAGE_DEFINITION ? 'mobileconnect' : 'transactional'),
    ens: {
      callbackUrl: (env.ENS_CALLBACK_URL ?? '').trim().replace(/\/$/, ''),
      callbackName: env.ENS_CALLBACK_NAME ?? 'sfmc-chat-delivery',
      subscriptionName: env.ENS_SUBSCRIPTION_NAME ?? 'sfmc-chat-sms-delivery',
    },
    inboundWebhookSecret: env.INBOUND_WEBHOOK_SECRET ?? '',
    // Ignored here: the Worker polls on a cron trigger, not an interval.
    pollIntervalMs: 60_000,
    redirectUri: '',
    messaging: messagingReadiness(codes, env),
  };
}

function parseCodes(env: Env): MessagingCode[] {
  const base = env.SFMC_DEFINITION_KEY ?? 'sfmc-chat-outbound';
  const list = (env.SFMC_SHORT_CODES ?? '').trim();
  const entries = list
    ? list.split(',')
    : [[env.SFMC_SHORT_CODE ?? '', env.SFMC_COUNTRY_CODE ?? ''].join(':')];

  const codes: MessagingCode[] = [];
  for (const entry of entries) {
    const [rawCode = '', rawCountry = ''] = entry.split(':');
    const code = rawCode.replace(/\s/g, '');
    if (!code) continue;
    if (codes.some((existing) => existing.code === code)) continue;

    const messageId = codes.length === 0 ? (env.SFMC_SMS_MESSAGE_DEFINITION ?? '') : '';
    codes.push({
      code,
      countryCode: rawCountry.trim().toUpperCase(),
      definitionKey: codes.length === 0 ? base : `${base}-${code}`,
      ...(messageId ? { smsMessageDefinition: messageId } : {}),
    });
  }
  return codes;
}

function messagingReadiness(codes: MessagingCode[], env: Env): Config['messaging'] {
  const warnings: string[] = [];
  const hasCode = codes.length > 0;
  if (!hasCode) warnings.push('No messaging code configured. Set SFMC_SHORT_CODE.');

  return {
    canSend: hasCode,
    canPoll: Boolean(env.SFMC_INBOUND_DE_KEY ?? 'ChatInbound'),
    warnings,
  };
}
