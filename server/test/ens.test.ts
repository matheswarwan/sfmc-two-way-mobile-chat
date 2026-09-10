import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { isValidSignature } from '../src/ens/signature.js';
import { parseDeliveryEvent, supersedes } from '../src/ens/events.js';

describe('ENS signature verification', () => {
  const key = 'V27FXfqI3DnhfQW1bhFDeJixpt8eDAY5R24UJI3cK6M=';
  const body = '[{"eventCategoryType":"TransactionalSendEvents.SmsDelivered"}]';
  const signature = createHmac('sha256', key).update(body, 'utf8').digest('base64');

  it('accepts a correctly signed payload', () => {
    expect(isValidSignature(body, signature, key)).toBe(true);
  });

  it('rejects a payload signed with a different key', () => {
    const wrong = createHmac('sha256', 'other-key').update(body, 'utf8').digest('base64');
    expect(isValidSignature(body, wrong, key)).toBe(false);
  });

  it('rejects a tampered body', () => {
    expect(isValidSignature(`${body} `, signature, key)).toBe(false);
  });

  it('rejects a missing or malformed header rather than throwing', () => {
    expect(isValidSignature(body, undefined, key)).toBe(false);
    expect(isValidSignature(body, 'not-base64!!', key)).toBe(false);
  });
});

describe('ENS delivery events', () => {
  it('maps each SMS event type to a status', () => {
    const cases: Array<[string, string]> = [
      ['TransactionalSendEvents.SmsSent', 'sent'],
      ['TransactionalSendEvents.SmsDelivered', 'delivered'],
      ['TransactionalSendEvents.SmsBounced', 'failed'],
      ['TransactionalSendEvents.SmsNotSent', 'failed'],
    ];

    for (const [type, expected] of cases) {
      expect(parseDeliveryEvent({ eventCategoryType: type })?.status).toBe(expected);
    }
  });

  it('ignores event types it does not handle', () => {
    expect(parseDeliveryEvent({ eventCategoryType: 'EngagementEvents.EmailOpen' })).toBeUndefined();
    expect(parseDeliveryEvent(null)).toBeUndefined();
    expect(parseDeliveryEvent('nonsense')).toBeUndefined();
  });

  it('reads the message key from either the top level or info', () => {
    expect(
      parseDeliveryEvent({ eventCategoryType: 'TransactionalSendEvents.SmsSent', messageKey: 'a' })
        ?.messageKey,
    ).toBe('a');
    expect(
      parseDeliveryEvent({
        eventCategoryType: 'TransactionalSendEvents.SmsSent',
        info: { messageKey: 'b' },
      })?.messageKey,
    ).toBe('b');
  });

  it('normalises the phone number so it matches stored conversations', () => {
    const event = parseDeliveryEvent({
      eventCategoryType: 'TransactionalSendEvents.SmsDelivered',
      info: { to: '+44 7440 422320' },
    });
    expect(event?.mobileNumber).toBe('447440422320');
  });

  it('only moves a status forward, since events are unordered', () => {
    // Delivered arrives, then a stale Sent follows.
    expect(supersedes('delivered', 'sent')).toBe(false);
    expect(supersedes('queued', 'delivered')).toBe(true);
    expect(supersedes('sent', 'failed')).toBe(true);
    expect(supersedes('delivered', 'delivered')).toBe(false);
  });
});
