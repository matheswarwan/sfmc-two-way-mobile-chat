import type { SfmcClient } from '../src/sfmc/client.js';

/**
 * A no-op SfmcClient with the parts a test cares about overridden.
 *
 * Keeps tests from breaking every time the interface grows a method they do
 * not exercise.
 */
export function stubClient(overrides: Partial<SfmcClient> = {}): SfmcClient {
  return {
    sendSms: async () => ({ tokenId: 'stub' }),
    optIn: async () => ({}),
    getSubscriptionStatus: async () => [],
    searchSubscribers: async () => [],
    readInboundRows: async () => [],
    getDeliveryStatus: async () => [],
    ...overrides,
  };
}
