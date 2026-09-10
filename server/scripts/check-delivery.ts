/**
 * Poll MobileConnect for the real delivery outcome of a send.
 *
 * The app records "queued" the moment SFMC accepts the request; this asks what
 * actually happened to the message afterwards.
 *
 *   npx tsx scripts/check-delivery.ts <tokenId> [mobileNumber]
 */
import { loadConfig } from '../src/config/index.js';
import { ClientCredentialsTokenProvider } from '../src/auth/tokenProvider.js';
import { statusCodeName, statusFromCode } from '../src/sfmc/statusCodes.js';

const [tokenId, mobileNumber] = process.argv.slice(2);
if (!tokenId) {
  console.error('Usage: npx tsx scripts/check-delivery.ts <tokenId> [mobileNumber]');
  process.exit(1);
}

const config = loadConfig();
const messageId = config.sfmc.smsMessageDefinition;
if (!messageId) {
  console.error('No SFMC_SMS_MESSAGE_DEFINITION set; this check is for the MobileConnect path.');
  process.exit(1);
}

const token = await new ClientCredentialsTokenProvider(config).getAccessToken();

async function get(path: string): Promise<string> {
  const r = await fetch(`${token.restInstanceUrl}${path}`, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
  });
  return `HTTP ${r.status}\n${await r.text()}`;
}

console.log('\n--- Delivery status ---');
const deliveries = await get(
  `/sms/v1/messageContact/${encodeURIComponent(messageId)}/deliveries/${encodeURIComponent(tokenId)}`,
);
console.log(deliveries);

// Decode any status codes present, since the numbers alone are opaque.
for (const match of deliveries.matchAll(/"statusCode"\s*:\s*(\d+)/g)) {
  const code = Number(match[1]);
  console.log(`  ${code} = ${statusCodeName(code)} -> ${statusFromCode(code)}`);
}

if (mobileNumber) {
  console.log('\n--- Message history for this number ---');
  console.log(
    await get(
      `/sms/v1/messageContact/${encodeURIComponent(messageId)}/history/${encodeURIComponent(tokenId)}/mobileNumber/${mobileNumber}`,
    ),
  );
}
