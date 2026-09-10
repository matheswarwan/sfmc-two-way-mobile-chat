/** Print the send definition exactly as SFMC holds it. */
import { loadConfig } from '../src/config/index.js';
import { ClientCredentialsTokenProvider } from '../src/auth/tokenProvider.js';

const config = loadConfig();
const token = await new ClientCredentialsTokenProvider(config).getAccessToken();

const response = await fetch(
  `${token.restInstanceUrl}/messaging/v1/sms/definitions/${encodeURIComponent(config.sfmc.definitionKey)}`,
  { headers: { Authorization: `Bearer ${token.accessToken}` } },
);

console.log(`HTTP ${response.status}\n`);
console.log(JSON.stringify(JSON.parse(await response.text()), null, 2));
