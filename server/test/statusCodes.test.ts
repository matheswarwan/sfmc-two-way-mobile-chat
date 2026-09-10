import { describe, it, expect } from 'vitest';
import { resolveStatus, statusFromCode, statusCodeName } from '../src/sfmc/statusCodes.js';

describe('SMS status codes', () => {
  it('maps terminal delivery', () => {
    expect(statusFromCode(4000)).toBe('delivered');
    expect(statusFromCode(4503)).toBe('failed');
  });

  it('treats DeliveredToAggregator as sent, since it is final on shared codes', () => {
    expect(statusFromCode(2000)).toBe('sent');
    expect(statusCodeName(2000)).toBe('DeliveredToAggregator');
  });

  it('keeps the highest code when updates arrive out of order', () => {
    // 4000 Delivered arrives, then a stale 3001 SentToCarrier follows.
    const first = resolveStatus(undefined, 4000);
    expect(first).toEqual({ code: 4000, status: 'delivered' });

    const stale = resolveStatus(first.code, 3001);
    expect(stale).toEqual({ code: 4000, status: 'delivered' });
  });

  it('advances when a higher code arrives', () => {
    expect(resolveStatus(1000, 4000)).toEqual({ code: 4000, status: 'delivered' });
  });

  it('falls back to sent for undocumented codes rather than throwing', () => {
    expect(statusFromCode(9999)).toBe('sent');
  });
});
