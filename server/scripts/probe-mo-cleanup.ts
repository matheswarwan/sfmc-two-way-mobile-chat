/** Inspect and attempt to remove the partial MO keyword row. */
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

const retrieved = await soap(
  'Retrieve',
  `<RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
     <RetrieveRequest>
       <ObjectType>SendSMSMOKeyword</ObjectType>
       <Properties>CustomerKey</Properties>
       <Properties>ObjectID</Properties>
       <Properties>Message</Properties>
     </RetrieveRequest>
   </RetrieveRequestMsg>`,
);

const objectId = /<ObjectID>(.*?)<\/ObjectID>/.exec(retrieved)?.[1];
const message = /<Message>([\s\S]*?)<\/Message>/.exec(retrieved)?.[1];
console.log(`\nExisting MO keyword:`);
console.log(`  CustomerKey: ${/<CustomerKey>(.*?)<\/CustomerKey>/.exec(retrieved)?.[1] ?? 'none'}`);
console.log(`  ObjectID:    ${objectId ?? 'none'}`);
console.log(`  Message:     ${message === undefined ? '(absent - partial row)' : JSON.stringify(message.slice(0, 120))}`);

if (objectId) {
  const del = await soap(
    'Delete',
    `<DeleteRequest xmlns="http://exacttarget.com/wsdl/partnerAPI">
       <Options/>
       <Objects xsi:type="SendSMSMOKeyword">
         <ObjectID>${objectId}</ObjectID>
         <CustomerKey>${config.sfmc.keyword}</CustomerKey>
       </Objects>
     </DeleteRequest>`,
  );
  console.log(`\nDelete by ObjectID:`);
  console.log(`  StatusCode: ${/<StatusCode>(.*?)<\/StatusCode>/.exec(del)?.[1] ?? 'no status returned'}`);
  console.log(`  Message:    ${(/<StatusMessage>([\s\S]*?)<\/StatusMessage>/.exec(del)?.[1] ?? '(none)').slice(0, 200)}`);
  console.log(`  Fault:      ${(/<faultstring>([\s\S]*?)<\/faultstring>/.exec(del)?.[1] ?? '(none)').slice(0, 200)}`);
}

const after = await soap(
  'Retrieve',
  `<RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
     <RetrieveRequest><ObjectType>SendSMSMOKeyword</ObjectType>
     <Properties>CustomerKey</Properties></RetrieveRequest>
   </RetrieveRequestMsg>`,
);
console.log(`\nStill present after delete attempt: ${(after.match(/<Results[ >]/g) ?? []).length} row(s)\n`);
