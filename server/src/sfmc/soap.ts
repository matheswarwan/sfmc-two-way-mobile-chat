import type { TokenProvider } from '../auth/tokenProvider.js';
import { SfmcApiError } from './client.js';

/**
 * The small slice of the SOAP Web Service API this app needs.
 *
 * SOAP is unavoidable in two places: creating a Data Extension, which has no
 * REST route at all, and reading the All Subscribers list, which REST exposes
 * only as exact-match address lookups. Everything else goes over REST.
 *
 * Kept as free functions rather than a class because both the runtime client
 * and the setup provisioner need them and neither owns the other.
 *
 * https://developer.salesforce.com/docs/marketing/marketing-cloud/guide/working_with_soap_web_service_api.html
 */

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function extractSoapError(response: string): string {
  const message = /<StatusMessage>([\s\S]*?)<\/StatusMessage>/.exec(response)?.[1];
  const fault = /<faultstring>([\s\S]*?)<\/faultstring>/.exec(response)?.[1];
  return message ?? fault ?? 'SOAP call failed with an unrecognised response.';
}

/**
 * A filter clause, rendered into the `<Filter>` element of a RetrieveRequest.
 *
 * Modelled as a tree rather than a string so callers cannot accidentally build
 * malformed XML, and so values are always escaped exactly once.
 */
export type SoapFilter =
  | { kind: 'simple'; property: string; operator: SimpleOperator; value: string }
  | { kind: 'complex'; left: SoapFilter; operator: 'AND' | 'OR'; right: SoapFilter };

export type SimpleOperator = 'equals' | 'notEquals' | 'like' | 'IN' | 'isNull' | 'isNotNull';

export function simpleFilter(
  property: string,
  operator: SimpleOperator,
  value: string,
): SoapFilter {
  return { kind: 'simple', property, operator, value };
}

export function anyOf(filters: SoapFilter[]): SoapFilter {
  const [first, ...rest] = filters;
  if (!first) throw new Error('anyOf needs at least one filter');
  return rest.reduce<SoapFilter>(
    (left, right) => ({ kind: 'complex', left, operator: 'OR', right }),
    first,
  );
}

function renderFilter(filter: SoapFilter, element = 'Filter'): string {
  if (filter.kind === 'simple') {
    return `<${element} xsi:type="SimpleFilterPart">
      <Property>${escapeXml(filter.property)}</Property>
      <SimpleOperator>${filter.operator}</SimpleOperator>
      <Value>${escapeXml(filter.value)}</Value>
    </${element}>`;
  }
  return `<${element} xsi:type="ComplexFilterPart">
    ${renderFilter(filter.left, 'LeftOperand')}
    <LogicalOperator>${filter.operator}</LogicalOperator>
    ${renderFilter(filter.right, 'RightOperand')}
  </${element}>`;
}

async function post(tokens: TokenProvider, action: string, envelopeBody: string): Promise<string> {
  const token = await tokens.getAccessToken();
  const endpoint = `${token.soapInstanceUrl}/Service.asmx`;

  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:xsd="http://www.w3.org/2001/XMLSchema"
            xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <s:Header>
    <a:Action s:mustUnderstand="1">${action}</a:Action>
    <a:To s:mustUnderstand="1">${endpoint}</a:To>
    <fueloauth xmlns="http://exacttarget.com">${token.accessToken}</fueloauth>
  </s:Header>
  <s:Body>
    ${envelopeBody}
  </s:Body>
</s:Envelope>`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml', SOAPAction: action },
    body: envelope,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new SfmcApiError(`SFMC SOAP ${action} failed (${response.status})`, response.status, text);
  }
  return text;
}

/** Create, Update or Delete. `objects` is one or more rendered `<Objects>` elements. */
export function soapMutate(
  tokens: TokenProvider,
  action: 'Create' | 'Update' | 'Delete',
  objects: string,
): Promise<string> {
  return post(
    tokens,
    action,
    `<${action}Request xmlns="http://exacttarget.com/wsdl/partnerAPI">
      <Options/>
      ${objects}
    </${action}Request>`,
  );
}

export function soapRetrieve(
  tokens: TokenProvider,
  objectType: string,
  properties: string[],
  filter?: SoapFilter,
): Promise<string> {
  const props = properties.map((name) => `<Properties>${escapeXml(name)}</Properties>`).join('');
  return post(
    tokens,
    'Retrieve',
    `<RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
      <RetrieveRequest>
        <ObjectType>${escapeXml(objectType)}</ObjectType>
        ${props}
        ${filter ? renderFilter(filter) : ''}
      </RetrieveRequest>
    </RetrieveRequestMsg>`,
  );
}

/**
 * Pull the requested fields out of each `<Results>` block.
 *
 * A hand-rolled reader rather than an XML parser: the app asks for a fixed set
 * of flat string properties on two object types, so a dependency and a DOM
 * would buy nothing. Only the named fields are read, so nested elements in the
 * response are ignored rather than mis-parsed.
 */
export function parseResults(xml: string, fields: string[]): Array<Record<string, string>> {
  const blocks = xml.match(/<Results\b[\s\S]*?<\/Results>/g) ?? [];

  return blocks.map((block) => {
    const row: Record<string, string> = {};
    for (const field of fields) {
      const match = new RegExp(`<${field}>([\\s\\S]*?)</${field}>`).exec(block);
      if (match?.[1] !== undefined) row[field] = decodeXml(match[1]);
    }
    return row;
  });
}

export function isSoapOk(xml: string): boolean {
  return /<OverallStatus>OK<\/OverallStatus>/.test(xml);
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
