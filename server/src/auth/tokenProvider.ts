import type { Config } from '../config/index.js';

/**
 * Access token acquisition.
 *
 * Two grant types matter to this project and they are not interchangeable:
 *
 * - `client_credentials` is the simplest path and is what the prototype uses.
 *   Salesforce is explicit that it cannot ship on AppExchange: "AppExchange
 *   partners can't upload a package with a server-to-server integration to
 *   AppExchange."
 * - `authorization_code` is what a distributed app must use. Because an inbound
 *   message arrives with no user present, the backend then has to work from a
 *   stored refresh token obtained with the `offline` scope.
 *
 * The interface below is the seam. Swapping providers should not touch the
 * SFMC client.
 *
 * https://developer.salesforce.com/docs/marketing/marketing-cloud/guide/integration-s2s-client-credentials.html
 */
export interface TokenProvider {
  getAccessToken(): Promise<AccessToken>;
}

export interface AccessToken {
  accessToken: string;
  restInstanceUrl: string;
  soapInstanceUrl: string;
  expiresAt: number;
  scope: string;
}

/**
 * Salesforce returns `expires_in` as 1080 seconds while the real lifetime is
 * 1200, precisely so callers refresh two minutes early. We refresh against
 * `expires_in` and keep a further safety margin.
 */
const REFRESH_MARGIN_MS = 60_000;

export class ClientCredentialsTokenProvider implements TokenProvider {
  #config: Config;
  #cached: AccessToken | undefined;
  #inFlight: Promise<AccessToken> | undefined;

  constructor(config: Config) {
    this.#config = config;
  }

  async getAccessToken(): Promise<AccessToken> {
    if (this.#cached && Date.now() < this.#cached.expiresAt - REFRESH_MARGIN_MS) {
      return this.#cached;
    }
    // Collapse concurrent refreshes. Salesforce rate-limits token creation per
    // app, and a burst of inbound traffic would otherwise stampede the endpoint.
    this.#inFlight ??= this.#fetchToken().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #fetchToken(): Promise<AccessToken> {
    const url = `https://${this.#config.sfmc.subdomain}.auth.marketingcloudapis.com/v2/token`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.#config.sfmc.clientId,
        client_secret: this.#config.sfmc.clientSecret,
        // Scopes the token to a specific business unit. Omitted entirely when
        // unset, since an empty account_id is rejected rather than ignored.
        ...(this.#config.sfmc.accountId ? { account_id: this.#config.sfmc.accountId } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`SFMC token request failed (${response.status}): ${body}`);
    }

    const json = (await response.json()) as {
      access_token: string;
      expires_in: number;
      rest_instance_url: string;
      soap_instance_url: string;
      scope: string;
    };

    this.#cached = {
      accessToken: json.access_token,
      restInstanceUrl: json.rest_instance_url.replace(/\/$/, ''),
      soapInstanceUrl: json.soap_instance_url.replace(/\/$/, ''),
      expiresAt: Date.now() + json.expires_in * 1000,
      scope: json.scope,
    };
    return this.#cached;
  }
}
