import type { SfmcProvisioner, ProvisionResult } from './provisioning.js';
import type { MockSfmcClient } from './mockClient.js';

/**
 * Mock provisioning so the setup screen is usable without a tenant.
 *
 * Records what would have been created and lets the verification flow run
 * end to end, which is how the UI is developed and tested.
 */
export class MockSfmcProvisioner implements SfmcProvisioner {
  readonly created = new Set<string>();
  #client: MockSfmcClient;
  #codes: string[];

  constructor(client: MockSfmcClient, codes: string[]) {
    this.#client = client;
    this.#codes = codes;
  }

  async createInboundDataExtension(): Promise<ProvisionResult> {
    return this.#record('data-extension', 'Data Extension');
  }

  async createKeyword(shortCode?: string): Promise<ProvisionResult> {
    const code = this.#resolve(shortCode);
    return this.#record(`keyword:${code}`, `Keyword on ${code}`);
  }

  async createSendDefinition(shortCode?: string): Promise<ProvisionResult> {
    const code = this.#resolve(shortCode);
    return this.#record(`send-definition:${code}`, `Send definition for ${code}`);
  }

  async getSendDefinition(shortCode?: string): Promise<{ exists: boolean; status?: string }> {
    return this.created.has(`send-definition:${this.#resolve(shortCode)}`)
      ? { exists: true, status: 'active' }
      : { exists: false };
  }

  async countBoundMoKeywords(): Promise<number | undefined> {
    return this.created.has('text-response') ? 1 : 0;
  }

  async simulateInbound(
    mobileNumber: string,
    text: string,
    shortCode?: string,
  ): Promise<ProvisionResult> {
    // Mirrors what a correctly wired Text Response would write.
    this.#client.pushInboundRow({
      mobileNumber,
      body: text,
      shortCode: this.#resolve(shortCode),
    });
    return { ok: true, detail: 'Queued a simulated inbound message (mock).' };
  }

  /** An unknown code is left as-is so mock mode surfaces the same mismatch live would. */
  #resolve(shortCode?: string): string {
    return shortCode ?? this.#codes[0] ?? '';
  }

  #record(id: string, label: string): ProvisionResult {
    if (this.created.has(id)) {
      return { ok: true, alreadyExists: true, detail: `${label} already exists (mock).` };
    }
    this.created.add(id);
    return { ok: true, detail: `Created ${label} (mock).` };
  }
}
