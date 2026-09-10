/**
 * Can a keyword's existence be verified by SOAP Retrieve?
 *
 * The REST API has no keyword read route, but the MO keyword SOAP objects are
 * documented as Retrieve-capable. This probes which object and property set
 * actually returns data, so the setup screen can verify instead of shrugging.
 */
import { loadConfig } from '../src/config/index.js';
import { ClientCredentialsTokenProvider } from '../src/auth/tokenProvider.js';

const config = loadConfig();
if (config.mode !== 'live') {
  console.log('Set SFMC_MODE=live to probe.');
  process.exit(0);
}

const token = await new ClientCredentialsTokenProvider(config).getAccessToken();
const endpoint = `${token.soapInstanceUrl}/Service.asmx`;

async function retrieve(objectType: string, properties: string[]): Promise<void> {
  const props = properties.map((p) => `<Properties>${p}</Properties>`).join('');
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing">
  <s:Header>
    <a:Action s:mustUnderstand="1">Retrieve</a:Action>
    <a:To s:mustUnderstand="1">${endpoint}</a:To>
    <fueloauth xmlns="http://exacttarget.com">${token.accessToken}</fueloauth>
  </s:Header>
  <s:Body>
    <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
      <RetrieveRequest>
        <ObjectType>${objectType}</ObjectType>
        ${props}
      </RetrieveRequest>
    </RetrieveRequestMsg>
  </s:Body>
</s:Envelope>`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml', SOAPAction: 'Retrieve' },
    body: envelope,
  });
  const text = await response.text();

  const status = /<OverallStatus>(.*?)<\/OverallStatus>/.exec(text)?.[1] ?? `HTTP ${response.status}`;
  const results = (text.match(/<Results[ >]/g) ?? []).length;
  const keywords = [...text.matchAll(/<Keyword>(.*?)<\/Keyword>/g)].map((m) => m[1]);
  const customerKeys = [...text.matchAll(/<CustomerKey>(.*?)<\/CustomerKey>/g)].map((m) => m[1]);
  const fault = /<faultstring>([\s\S]*?)<\/faultstring>/.exec(text)?.[1];

  console.log(`  ${objectType.padEnd(26)} status=${status.padEnd(28)} results=${results}`);
  if (keywords.length > 0) console.log(`      keywords: ${[...new Set(keywords)].join(', ')}`);
  if (customerKeys.length > 0)
    console.log(`      customerKeys: ${[...new Set(customerKeys)].slice(0, 12).join(', ')}`);
  if (fault) console.log(`      fault: ${fault.slice(0, 160)}`);
  if (status !== 'OK' && !fault) {
    const msg = /<StatusMessage>([\s\S]*?)<\/StatusMessage>/.exec(text)?.[1];
    if (msg) console.log(`      message: ${msg.slice(0, 200)}`);
  }
}

console.log(`\nProbing keyword retrieval for "${config.sfmc.keyword}" on ${config.sfmc.shortCode}\n`);

// SFMC names the invalid properties in its error, so narrow by elimination.
// Which MO keyword objects exist? These appear when a Text Response binds
// behaviour to a keyword, so they verify the manual step, not the keyword.
await retrieve('SendSMSMOKeyword', ['ObjectID', 'CustomerKey']);
await retrieve('HelpMOKeyword', ['ObjectID', 'CustomerKey']);
await retrieve('UnsubscribeFromSMSPublicationMOKeyword', ['ObjectID', 'CustomerKey']);
await retrieve('DoubleOptInMOKeyword', ['ObjectID', 'CustomerKey']);
console.log('');
