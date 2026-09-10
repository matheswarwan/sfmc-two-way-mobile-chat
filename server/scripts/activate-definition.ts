/**
 * Activate the send definition.
 *
 * Transactional send definitions are API-managed, so status is changed with
 * PATCH rather than in the MobileConnect UI.
 */
import { loadConfig } from '../src/config/index.js';
import { ClientCredentialsTokenProvider } from '../src/auth/tokenProvider.js';

const config = loadConfig();
const token = await new ClientCredentialsTokenProvider(config).getAccessToken();
const url = `${token.restInstanceUrl}/messaging/v1/sms/definitions/${encodeURIComponent(config.sfmc.definitionKey)}`;

const patch = await fetch(url, {
  method: 'PATCH',
  headers: {
    Authorization: `Bearer ${token.accessToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ status: 'Active' }),
});

console.log(`PATCH status: ${patch.status}`);
console.log(await patch.text());

const after = await fetch(url, { headers: { Authorization: `Bearer ${token.accessToken}` } });
const json = (await after.json()) as { status?: string };
console.log(`\nStatus now: ${json.status}`);
