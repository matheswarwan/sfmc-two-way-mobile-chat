/**
 * Verify _SMSMessageTracking column names against this tenant.
 *
 * Salesforce validates a QueryDefinition's SQL when it is created, naming any
 * column it does not recognise. That gives a definitive answer without running
 * anything or writing rows. The probe definition is deleted afterwards.
 */
import { loadConfig } from '../src/config/index.js';
import { ClientCredentialsTokenProvider } from '../src/auth/tokenProvider.js';

const config = loadConfig();
const token = await new ClientCredentialsTokenProvider(config).getAccessToken();
const endpoint = `${token.soapInstanceUrl}/Service.asmx`;

async function soap(action: string, body: string): Promise<string> {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <s:Header>
    <a:Action s:mustUnderstand="1">${action}</a:Action>
    <a:To s:mustUnderstand="1">${endpoint}</a:To>
    <fueloauth xmlns="http://exacttarget.com">${token.accessToken}</fueloauth>
  </s:Header>
  <s:Body>${body}</s:Body>
</s:Envelope>`;
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml', SOAPAction: action },
    body: envelope,
  });
  return r.text();
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const TARGET = 'ChatQueryProbe';

/** Try a candidate column list; report exactly what SFMC says. */
async function tryQuery(label: string, sql: string): Promise<boolean> {
  const key = `probe-${Date.now()}`;
  const response = await soap(
    'Create',
    `<CreateRequest xmlns="http://exacttarget.com/wsdl/partnerAPI">
       <Options/>
       <Objects xsi:type="QueryDefinition">
         <CustomerKey>${key}</CustomerKey>
         <Name>${key}</Name>
         <QueryText>${esc(sql)}</QueryText>
         <TargetType>DE</TargetType>
         <DataExtensionTarget>
           <CustomerKey>${TARGET}</CustomerKey>
           <Name>${TARGET}</Name>
         </DataExtensionTarget>
         <TargetUpdateType>Overwrite</TargetUpdateType>
       </Objects>
     </CreateRequest>`,
  );

  const status = /<StatusCode>(.*?)<\/StatusCode>/.exec(response)?.[1];
  const message = /<StatusMessage>([\s\S]*?)<\/StatusMessage>/.exec(response)?.[1] ?? '';
  const ok = status === 'OK';

  console.log(`  ${label}: ${ok ? 'VALID' : 'rejected'}`);
  if (!ok) console.log(`     ${message.slice(0, 300)}`);

  if (ok) {
    await soap(
      'Delete',
      `<DeleteRequest xmlns="http://exacttarget.com/wsdl/partnerAPI">
         <Options/>
         <Objects xsi:type="QueryDefinition"><CustomerKey>${key}</CustomerKey></Objects>
       </DeleteRequest>`,
    );
  }
  return ok;
}

console.log('\nVerifying _SMSMessageTracking columns against this tenant\n');

// The two candidates community sources disagree on.
await tryQuery('Mobile', 'SELECT Mobile FROM _SMSMessageTracking');
await tryQuery('MobileNumber', 'SELECT MobileNumber FROM _SMSMessageTracking');

console.log('\nFull candidate list:\n');
await tryQuery(
  'full delivery query',
  `SELECT Mobile, MessageText, ShortCode, Sent, Delivered, Undelivered, Outbound, Inbound,
          SMSStandardStatusCodeId, Description, CreateDateTime, ActionDateTime, SubscriberKey
     FROM _SMSMessageTracking`,
);
console.log('');
