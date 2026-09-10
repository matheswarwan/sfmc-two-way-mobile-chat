/**
 * Can an inbound MO keyword handler be created by API?
 *
 * The operations matrix says SendSMSMOKeyword is Retrieve-only, but that is
 * worth testing rather than trusting: if Create or Update works, the Text
 * Response step could be automated and the whole setup becomes scriptable.
 */
import { loadConfig } from '../src/config/index.js';
import { ClientCredentialsTokenProvider } from '../src/auth/tokenProvider.js';

const config = loadConfig();
const token = await new ClientCredentialsTokenProvider(config).getAccessToken();
const endpoint = `${token.soapInstanceUrl}/Service.asmx`;

async function call(action: string, objectXml: string, label: string): Promise<void> {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <s:Header>
    <a:Action s:mustUnderstand="1">${action}</a:Action>
    <a:To s:mustUnderstand="1">${endpoint}</a:To>
    <fueloauth xmlns="http://exacttarget.com">${token.accessToken}</fueloauth>
  </s:Header>
  <s:Body>
    <${action}Request xmlns="http://exacttarget.com/wsdl/partnerAPI">
      <Options/>
      ${objectXml}
    </${action}Request>
  </s:Body>
</s:Envelope>`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml', SOAPAction: action },
    body: envelope,
  });
  const text = await response.text();

  const status = /<StatusMessage>([\s\S]*?)<\/StatusMessage>/.exec(text)?.[1];
  const code = /<StatusCode>([\s\S]*?)<\/StatusCode>/.exec(text)?.[1];
  const fault = /<faultstring>([\s\S]*?)<\/faultstring>/.exec(text)?.[1];

  console.log(`  ${label}`);
  console.log(`     HTTP ${response.status}  StatusCode=${code ?? 'n/a'}`);
  if (status) console.log(`     message: ${status.slice(0, 700)}`);
  if (fault) console.log(`     fault:   ${fault.slice(0, 700)}`);
  console.log('');
}

const { keyword, shortCode } = config.sfmc;
const ampscript = '%%[ SET @t = Msg(0) ]%% Thanks, we got your message.';

console.log(`\nAttempting API creation of an inbound handler for "${keyword}" on ${shortCode}\n`);

await call(
  'Create',
  `<Objects xsi:type="SendSMSMOKeyword">
     <Keyword>${keyword}</Keyword>
     <Message>${ampscript.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</Message>
   </Objects>`,
  'Create SendSMSMOKeyword (Keyword + Message)',
);

await call(
  'Create',
  `<Objects xsi:type="SendSMSMOKeyword">
     <CustomerKey>${keyword}</CustomerKey>
     <Message>${ampscript.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</Message>
   </Objects>`,
  'Create SendSMSMOKeyword (CustomerKey + Message)',
);

await call(
  'Update',
  `<Objects xsi:type="SendSMSMOKeyword">
     <CustomerKey>${keyword}</CustomerKey>
     <Message>${ampscript.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</Message>
   </Objects>`,
  'Update SendSMSMOKeyword',
);
