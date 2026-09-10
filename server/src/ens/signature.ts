import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify the HMAC-SHA256 signature ENS puts on every notification.
 *
 * Salesforce signs the entire raw payload with the callback's signature key and
 * sends it base64-encoded in `x-sfmc-ens-signature`. The comparison must be
 * over the raw body, not a re-serialised object, because any whitespace or key
 * ordering difference changes the digest.
 */
export function isValidSignature(
  rawBody: string,
  headerValue: string | undefined,
  signatureKey: string,
): boolean {
  if (!headerValue) return false;

  const expected = createHmac('sha256', signatureKey).update(rawBody, 'utf8').digest();

  let received: Buffer;
  try {
    received = Buffer.from(headerValue, 'base64');
  } catch {
    return false;
  }

  // Length must match before timingSafeEqual, which throws on mismatch.
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
