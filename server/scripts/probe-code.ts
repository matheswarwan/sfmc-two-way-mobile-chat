/**
 * Probe which shortCode / countryCode combination this tenant accepts for a
 * Transactional Messaging send definition.
 *
 * A failed lookup creates nothing, so unsuccessful attempts are harmless. The
 * first success creates the definition, which is the outcome we want anyway.
 *
 *   npx tsx scripts/probe-code.ts
 */
import { loadConfig } from '../src/config/index.js';
import { ClientCredentialsTokenProvider } from '../src/auth/tokenProvider.js';
import { RestSfmcProvisioner } from '../src/sfmc/provisioning.js';

const base = loadConfig();
if (base.mode !== 'live') {
  console.log('Set SFMC_MODE=live to probe a real tenant.');
  process.exit(0);
}

// Long codes carry their own country code and omit the field; short codes need it.
const candidates = ['', 'GB', 'US'];

console.log(`\nProbing code "${base.sfmc.shortCode}" (MID ${base.sfmc.accountId ?? 'default'})\n`);

for (const countryCode of candidates) {
  const config = { ...base, sfmc: { ...base.sfmc, countryCode } };
  const provisioner = new RestSfmcProvisioner(config, new ClientCredentialsTokenProvider(config));
  const label = countryCode === '' ? '(omitted)' : countryCode;

  const result = await provisioner.createSendDefinition();
  const firstLine = result.detail.split('\n')[0] ?? result.detail;

  if (result.ok) {
    console.log(`  countryCode ${label.padEnd(9)} -> SUCCESS: ${firstLine}`);
    console.log(
      `\nSet SFMC_COUNTRY_CODE=${countryCode} in .env${countryCode === '' ? ' (leave it blank)' : ''} and restart.\n`,
    );
    process.exit(0);
  }
  console.log(`  countryCode ${label.padEnd(9)} -> failed: ${firstLine.slice(0, 150)}`);
}

console.log('\nNone of the candidates resolved the code.');
console.log('Confirm in SFMC: Setup > MobileConnect > which business unit owns this code, and');
console.log('whether it is registered as a short code or a long code.\n');
