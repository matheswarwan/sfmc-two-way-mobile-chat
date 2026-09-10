/**
 * Preflight connectivity check.
 *
 * Verifies that credentials in .env actually authenticate against the tenant,
 * and reports which messaging artefacts are still missing. Safe to run at any
 * point: it never sends a message.
 *
 *   npm run check --workspace=server
 */
import { loadConfig } from '../src/config/index.js';
import { ClientCredentialsTokenProvider } from '../src/auth/tokenProvider.js';
import { RestSfmcClient, SfmcApiError } from '../src/sfmc/client.js';

const config = loadConfig();

function line(ok: boolean | undefined, label: string, detail = ''): void {
  const mark = ok === undefined ? '-' : ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark.padEnd(4)}] ${label}${detail ? ` - ${detail}` : ''}`);
}

console.log(`\nSFMC preflight (mode: ${config.mode})\n`);

if (config.mode !== 'live') {
  console.log('  Mode is "mock", so there is nothing to check.');
  console.log('  Set SFMC_MODE=live in .env to test a real tenant.\n');
  process.exit(0);
}

line(Boolean(config.sfmc.subdomain), 'SFMC_SUBDOMAIN', config.sfmc.subdomain);
line(Boolean(config.sfmc.clientId), 'SFMC_CLIENT_ID', mask(config.sfmc.clientId));
line(Boolean(config.sfmc.clientSecret), 'SFMC_CLIENT_SECRET', mask(config.sfmc.clientSecret));
line(
  config.sfmc.accountId ? true : undefined,
  'SFMC_ACCOUNT_ID',
  config.sfmc.accountId ?? 'not set - token will use the package business unit',
);

console.log('\nAuthenticating...\n');

let scopes: string[] = [];
try {
  const token = await new ClientCredentialsTokenProvider(config).getAccessToken();
  scopes = token.scope.split(/\s+/).filter(Boolean);

  line(true, 'Access token acquired');
  line(true, 'REST instance', token.restInstanceUrl);
  console.log(`\n  Granted scopes: ${scopes.join(', ') || '(none reported)'}\n`);
} catch (error) {
  line(false, 'Access token', error instanceof Error ? error.message : String(error));
  console.log('\n  Check the subdomain, client ID and secret against the Installed Package.');
  console.log('  Note that changes to Installed Packages take up to 5 minutes to propagate.\n');
  process.exit(1);
}

// Scopes the app needs. Missing ones are a configuration problem in the
// Installed Package, not a code problem, so name them precisely.
const REQUIRED = ['sms_send', 'sms_read', 'data_extensions_read', 'data_extensions_write'];
console.log('Required scopes\n');
for (const scope of REQUIRED) {
  line(scopes.includes(scope), scope, scopes.includes(scope) ? '' : 'not granted');
}

// Actually read the Data Extension rather than assuming it exists. This is the
// single most common setup failure: the key is wrong, or the token is scoped to
// the wrong business unit.
console.log('\nInbound Data Extension\n');
try {
  const client = new RestSfmcClient(config, new ClientCredentialsTokenProvider(config));
  const rows = await client.readInboundRows(new Date(Date.now() - 60_000).toISOString());
  line(true, `Readable: ${config.sfmc.inboundDataExtensionKey}`, `${rows.length} recent row(s)`);
} catch (error) {
  if (error instanceof SfmcApiError && error.status === 404) {
    line(false, `Not found: ${config.sfmc.inboundDataExtensionKey}`);
    console.log('\n    Create it per sfmc-assets/inbound-data-extension.md (SETUP.md step 4).');
    console.log('    If it exists, check SFMC_INBOUND_DE_KEY matches its external key exactly,');
    console.log('    and that SFMC_ACCOUNT_ID points at the business unit that owns it.');
  } else if (error instanceof SfmcApiError && (error.status === 401 || error.status === 403)) {
    line(false, 'Access denied', 'the package likely lacks data_extensions_read');
  } else {
    line(false, 'Read failed', error instanceof Error ? error.message : String(error));
  }
}

console.log('\nMessaging setup\n');
line(
  config.messaging.canSend,
  'Outbound sending',
  config.messaging.canSend ? `definition ${config.sfmc.definitionKey}` : 'short code not configured',
);
line(config.messaging.canPoll, 'Inbound polling', config.messaging.canPoll ? config.sfmc.inboundDataExtensionKey : 'not configured');

if (config.messaging.warnings.length > 0) {
  console.log('\nStill to do\n');
  for (const warning of config.messaging.warnings) console.log(`  - ${warning}`);
}

console.log('');

function mask(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
