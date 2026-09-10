import type { Config } from '../config/index.js';
import type { TokenProvider } from '../auth/tokenProvider.js';
import { SfmcApiError } from '../sfmc/client.js';
import { SMS_EVENT_TYPES } from './events.js';
import { readRegistration, writeRegistration, type EnsRegistration } from './store.js';

export interface EnsActionResult {
  ok: boolean;
  detail: string;
}

/**
 * Event Notification Service registration.
 *
 * The flow is: create a callback, respond 200 to the verification POST SFMC
 * immediately sends, confirm with ens-verify, then subscribe event types to
 * that callback.
 *
 * https://developer.salesforce.com/docs/marketing/marketing-cloud/guide/ens.html
 */
export class EnsService {
  #config: Config;
  #tokens: TokenProvider;
  /** Verification key from the handshake, held only until ens-verify is called. */
  #pendingVerification = new Map<string, string>();

  constructor(config: Config, tokens: TokenProvider) {
    this.#config = config;
    this.#tokens = tokens;
  }

  getRegistration(): EnsRegistration | undefined {
    return readRegistration();
  }

  /** Called by the webhook when SFMC posts the verification challenge. */
  recordVerification(callbackId: string, verificationKey: string): void {
    this.#pendingVerification.set(callbackId, verificationKey);
  }

  async registerCallback(): Promise<EnsActionResult> {
    const url = this.#config.ens.callbackUrl;
    if (!url) {
      return {
        ok: false,
        detail:
          'ENS_CALLBACK_URL is not set. ENS needs a public HTTPS URL with no port and no query string, so a tunnel or deployed host is required.',
      };
    }
    if (!url.startsWith('https://')) {
      return { ok: false, detail: `ENS requires HTTPS. "${url}" will be rejected.` };
    }

    try {
      // SFMC posts the verification challenge to the URL during this call, so
      // the server must already be reachable at it.
      const created = await this.#rest<
        Array<{ callbackId: string; callbackName: string; url: string; signatureKey: string }>
      >('POST', '/platform/v1/ens-callbacks', [
        {
          callbackName: this.#config.ens.callbackName,
          url,
          maxBatchSize: 100,
        },
      ]);

      const callback = created[0];
      if (!callback) return { ok: false, detail: 'SFMC returned no callback.' };

      // The signature key is shown only here; losing it means regenerating.
      writeRegistration({
        callbackId: callback.callbackId,
        callbackName: callback.callbackName,
        url: callback.url,
        signatureKey: callback.signatureKey,
        verified: false,
      });

      return {
        ok: true,
        detail: `Callback "${callback.callbackName}" created. Signature key stored. Now verify it.`,
      };
    } catch (error) {
      return { ok: false, detail: describe(error) };
    }
  }

  async verifyCallback(): Promise<EnsActionResult> {
    const registration = readRegistration();
    if (!registration) return { ok: false, detail: 'No callback registered yet.' };

    const verificationKey = this.#pendingVerification.get(registration.callbackId);
    if (!verificationKey) {
      return {
        ok: false,
        detail:
          'No verification challenge received. SFMC posts it to the callback URL during registration, so confirm the URL is publicly reachable and re-register.',
      };
    }

    try {
      await this.#rest('POST', '/platform/v1/ens-verify', {
        callbackId: registration.callbackId,
        verificationKey,
      });
      writeRegistration({ ...registration, verified: true });
      return { ok: true, detail: 'Callback verified.' };
    } catch (error) {
      return { ok: false, detail: describe(error) };
    }
  }

  async createSubscription(): Promise<EnsActionResult> {
    const registration = readRegistration();
    if (!registration) return { ok: false, detail: 'No callback registered yet.' };
    if (!registration.verified) return { ok: false, detail: 'Verify the callback first.' };

    try {
      const created = await this.#rest<Array<{ subscriptionId: string; subscriptionName: string }>>(
        'POST',
        '/platform/v1/ens-subscriptions',
        [
          {
            callbackId: registration.callbackId,
            subscriptionName: this.#config.ens.subscriptionName,
            eventCategoryTypes: [...SMS_EVENT_TYPES],
          },
        ],
      );

      const subscription = created[0];
      writeRegistration({
        ...registration,
        ...(subscription
          ? {
              subscriptionId: subscription.subscriptionId,
              subscriptionName: subscription.subscriptionName,
            }
          : {}),
      });
      return {
        ok: true,
        detail: `Subscribed to ${SMS_EVENT_TYPES.length} SMS delivery events. Allow up to two minutes for it to become active.`,
      };
    } catch (error) {
      return { ok: false, detail: describe(error) };
    }
  }

  async #rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.#tokens.getAccessToken();
    const response = await fetch(`${token.restInstanceUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new SfmcApiError(
        `SFMC ${method} ${path} failed (${response.status}): ${text || '(empty body)'}`,
        response.status,
        text,
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}

function describe(error: unknown): string {
  if (error instanceof SfmcApiError && (error.status === 401 || error.status === 403)) {
    return `${error.message}

The Installed Package is missing the Event Notification scopes. Add these under Event Notifications, then wait up to 5 minutes:
  Callbacks: Read, Create, Update, Delete
  Subscriptions: Read, Create, Update, Delete`;
  }
  return error instanceof Error ? error.message : String(error);
}
