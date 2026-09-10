import type { DeliveryStatus } from '../domain/types.js';

/**
 * Delivery events ENS can send for SMS.
 *
 * These are Transactional Send Events: they are emitted for sends made through
 * the Transactional Messaging API. A MobileConnect send does not produce them,
 * which is why delivery status only becomes live on the transactional
 * transport.
 *
 * https://developer.salesforce.com/docs/marketing/marketing-cloud/guide/transactional_sms_events.html
 */
export const SMS_EVENT_TYPES = [
  'TransactionalSendEvents.SmsSent',
  'TransactionalSendEvents.SmsNotSent',
  'TransactionalSendEvents.SmsTransient',
  'TransactionalSendEvents.SmsDelivered',
  'TransactionalSendEvents.SmsBounced',
] as const;

const STATUS_BY_EVENT: Record<string, DeliveryStatus> = {
  'TransactionalSendEvents.SmsSent': 'sent',
  'TransactionalSendEvents.SmsTransient': 'sent',
  'TransactionalSendEvents.SmsDelivered': 'delivered',
  'TransactionalSendEvents.SmsNotSent': 'failed',
  'TransactionalSendEvents.SmsBounced': 'failed',
};

/**
 * Rank so a late-arriving earlier event cannot undo a later one.
 *
 * ENS documents no ordering guarantee and delivers at least once, so a Sent
 * event can arrive after Delivered. Higher rank wins, mirroring the
 * highest-status-code-wins rule used for MobileConnect.
 */
const RANK: Record<DeliveryStatus, number> = {
  pending: 0,
  queued: 1,
  sent: 2,
  delivered: 3,
  failed: 3,
  received: 0,
};

export interface DeliveryEvent {
  eventCategoryType: string;
  /** Correlates to the messageKey we generated for the send. */
  messageKey?: string;
  mobileNumber?: string;
  status: DeliveryStatus;
  timestamp?: string;
  reason?: string;
}

/**
 * Normalise one ENS notification.
 *
 * Field names vary across event categories and Salesforce's own samples are
 * inconsistent, so every field is read defensively and the event is discarded
 * rather than guessed at when the type is unrecognised.
 */
export function parseDeliveryEvent(raw: unknown): DeliveryEvent | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const event = raw as Record<string, unknown>;

  const type = typeof event['eventCategoryType'] === 'string' ? event['eventCategoryType'] : '';
  const status = STATUS_BY_EVENT[type];
  if (!status) return undefined;

  const info = (event['info'] ?? {}) as Record<string, unknown>;

  const messageKey =
    pickString(event['messageKey']) ??
    pickString(info['messageKey']) ??
    pickString(event['compositeId']);

  const mobileNumber =
    pickString(info['to']) ?? pickString(event['mobileNumber']) ?? pickString(info['mobileNumber']);

  const timestamp = pickString(event['timestampUTC']);
  const reason = pickString(info['statusMessage']) ?? pickString(info['reason']);

  return {
    eventCategoryType: type,
    status,
    ...(messageKey ? { messageKey } : {}),
    ...(mobileNumber ? { mobileNumber: mobileNumber.replace(/\D/g, '') } : {}),
    ...(timestamp ? { timestamp } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** True when `next` represents progress over `current`. */
export function supersedes(current: DeliveryStatus, next: DeliveryStatus): boolean {
  return (RANK[next] ?? 0) > (RANK[current] ?? 0);
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
