/** Inspect the MO keyword that now exists, and test whether Message is writable. */
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

function retrieveBody(props: string[]): string {
  return `<RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
    <RetrieveRequest>
      <ObjectType>SendSMSMOKeyword</ObjectType>
      ${props.map((p) => `<Properties>${p}</Properties>`).join('')}
    </RetrieveRequest>
  </RetrieveRequestMsg>`;
}

console.log('\n--- Which properties are readable? ---');
for (const props of [
  ['CustomerKey', 'Message'],
  ['CustomerKey', 'IsDefaultKeyword'],
  ['CustomerKey', 'ObjectID', 'Message', 'IsDefaultKeyword'],
]) {
  const text = await soap('Retrieve', retrieveBody(props));
  const status = /<OverallStatus>(.*?)<\/OverallStatus>/.exec(text)?.[1];
  const msg = /<Message>([\s\S]*?)<\/Message>/.exec(text)?.[1];
  console.log(`  ${props.join(', ').padEnd(48)} status=${status}`);
  if (msg !== undefined) console.log(`     Message = ${JSON.stringify(msg.slice(0, 200))}`);
}

console.log('\n--- Is Message writable via Update? ---');
const script = '%%[ SET @t = Msg(0) ]%% probe';
const upd = await soap(
  'Update',
  `<UpdateRequest xmlns="http://exacttarget.com/wsdl/partnerAPI">
     <Options/>
     <Objects xsi:type="SendSMSMOKeyword">
       <CustomerKey>${config.sfmc.keyword}</CustomerKey>
       <Message>${script.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</Message>
     </Objects>
   </UpdateRequest>`,
);
console.log(`  StatusCode: ${/<StatusCode>(.*?)<\/StatusCode>/.exec(upd)?.[1]}`);
console.log(`  Message:    ${(/<StatusMessage>([\s\S]*?)<\/StatusMessage>/.exec(upd)?.[1] ?? '').slice(0, 300)}`);

console.log('\n--- Is Delete supported (to clean up)? ---');
const del = await soap(
  'Delete',
  `<DeleteRequest xmlns="http://exacttarget.com/wsdl/partnerAPI">
     <Options/>
     <Objects xsi:type="SendSMSMOKeyword">
       <CustomerKey>${config.sfmc.keyword}</CustomerKey>
     </Objects>
   </DeleteRequest>`,
);
console.log(`  StatusCode: ${/<StatusCode>(.*?)<\/StatusCode>/.exec(del)?.[1]}`);
console.log(`  Message:    ${(/<StatusMessage>([\s\S]*?)<\/StatusMessage>/.exec(del)?.[1] ?? '').slice(0, 300)}`);
console.log('');
