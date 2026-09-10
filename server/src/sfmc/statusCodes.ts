import type { DeliveryStatus } from '../domain/types.js';

/**
 * MobileConnect SMS status codes.
 *
 * Salesforce: "Infer the final message status from the status code with the
 * highest numerical value." Codes arrive out of order, so callers keep the
 * highest seen rather than the most recent.
 *
 * https://developer.salesforce.com/docs/marketing/marketing-cloud/guide/sms-status-codes.html
 */
export const SMS_STATUS_CODES: Record<number, { name: string; status: DeliveryStatus }> = {
  1000: { name: 'QueuedToSfmcSendService', status: 'queued' },
  1500: { name: 'QueueFailureToSfmcSendService', status: 'failed' },
  1501: { name: 'ValidationError', status: 'failed' },
  // For shared codes this is the final status, so it maps to `sent` rather than
  // an intermediate state the UI would wait on forever.
  2000: { name: 'DeliveredToAggregator', status: 'sent' },
  2500: { name: 'FailedToAggregator', status: 'failed' },
  2501: { name: 'UnknownToAggregator', status: 'failed' },
  2502: { name: 'FailedToAggregatorDueToInvalidDestinationAddress', status: 'failed' },
  2600: { name: 'ThrottledToAggregator', status: 'queued' },
  2601: { name: 'SocketExceptionToAggregator', status: 'failed' },
  3000: { name: 'Enroute', status: 'sent' },
  3001: { name: 'SentToCarrier', status: 'sent' },
  3002: { name: 'AcceptedByCarrier', status: 'sent' },
  3400: { name: 'Unknown', status: 'sent' },
  4000: { name: 'Delivered', status: 'delivered' },
  4500: { name: 'Undeliverable', status: 'failed' },
  4501: { name: 'Expired', status: 'failed' },
  4502: { name: 'Deleted', status: 'failed' },
  4503: { name: 'Rejected', status: 'failed' },
  4504: { name: 'FailedDueToUnknownSubscriber', status: 'failed' },
  4505: { name: 'FailedDueToInvalidDestinationAddress', status: 'failed' },
};

export function statusFromCode(code: number): DeliveryStatus {
  return SMS_STATUS_CODES[code]?.status ?? 'sent';
}

export function statusCodeName(code: number): string {
  return SMS_STATUS_CODES[code]?.name ?? `Unknown(${code})`;
}

/**
 * Resolve a message's status given a newly observed code, honouring the
 * highest-code-wins rule. Returns the winning code and its status.
 */
export function resolveStatus(
  previousCode: number | undefined,
  incomingCode: number,
): { code: number; status: DeliveryStatus } {
  const code = previousCode === undefined ? incomingCode : Math.max(previousCode, incomingCode);
  return { code, status: statusFromCode(code) };
}
