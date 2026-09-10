import { describe, it, expect } from 'vitest';
import { SetupStatusService, generateTextResponseAmpscript } from '../src/setup/status.js';
import { SfmcApiError, type SfmcClient } from '../src/sfmc/client.js';
import type { SfmcProvisioner } from '../src/sfmc/provisioning.js';
import { loadConfig } from '../src/config/index.js';
import { stubClient } from './helpers.js';

function makeConfig() {
  process.env['SFMC_MODE'] = 'live';
  process.env['SFMC_SUBDOMAIN'] = 'mc-test';
  process.env['SFMC_CLIENT_ID'] = 'id';
  process.env['SFMC_CLIENT_SECRET'] = 'secret';
  process.env['SFMC_SHORT_CODE'] = '86288';
  return loadConfig();
}

const noopProvisioner: SfmcProvisioner = {
  createInboundDataExtension: async () => ({ ok: true, detail: '' }),
  createKeyword: async () => ({ ok: true, detail: '' }),
  createSendDefinition: async () => ({ ok: true, detail: '' }),
  getSendDefinition: async () => ({ exists: true, status: 'active' }),
  countBoundMoKeywords: async () => 0,
  simulateInbound: async () => ({ ok: true, detail: '' }),
};

function clientThatThrows(error: unknown): SfmcClient {
  return stubClient({
    readInboundRows: async () => {
      throw error;
    },
  });
}

describe('SetupStatusService', () => {
  it('reports a missing Data Extension as creatable rather than as an error', async () => {
    const config = makeConfig();
    const service = new SetupStatusService(
      config,
      clientThatThrows(new SfmcApiError('nope', 404, 'not found')),
      noopProvisioner,
    );

    const step = (await service.getSteps()).find((s) => s.id === 'data-extension');
    expect(step?.state).toBe('missing');
    expect(step?.automatable).toBe(true);
  });

  it('distinguishes a permissions problem from a missing object', async () => {
    const config = makeConfig();
    const service = new SetupStatusService(
      config,
      clientThatThrows(new SfmcApiError('denied', 403, 'forbidden')),
      noopProvisioner,
    );

    const step = (await service.getSteps()).find((s) => s.id === 'data-extension');
    expect(step?.state).toBe('error');
    expect(step?.detail).toMatch(/data_extensions_read/);
  });

  it('marks the Text Response and conversation window as permanently manual', async () => {
    const config = makeConfig();
    const service = new SetupStatusService(
      config,
      clientThatThrows(new SfmcApiError('nope', 404, '')),
      noopProvisioner,
    );
    const steps = await service.getSteps();

    for (const id of ['text-response', 'conversation-window', 'installed-package', 'short-code']) {
      expect(steps.find((s) => s.id === id)?.automatable).toBe(false);
    }
  });
});

describe('generateTextResponseAmpscript', () => {
  it('substitutes the tenant values so it can be pasted unedited', () => {
    const config = makeConfig();
    const script = generateTextResponseAmpscript(config);

    expect(script).toContain(`"${config.sfmc.inboundDataExtensionKey}"`);
    expect(script).toContain(`"${config.sfmc.keyword}"`);
    expect(script).toContain('InsertData(');
    expect(script).toContain('SetSmsConversationNextKeyword(');
  });

  it('omits the HTTP callout unless a webhook URL is supplied', () => {
    const config = makeConfig();
    expect(generateTextResponseAmpscript(config)).not.toContain('HttpPost2');
  });

  it('includes the callout when a webhook URL is supplied, marked unverified', () => {
    const config = makeConfig();
    const script = generateTextResponseAmpscript(config, 'https://example.com/inbound/ampscript');

    expect(script).toContain('HttpPost2("https://example.com/inbound/ampscript"');
    // The uncertainty must travel with the generated code, not just the docs.
    expect(script).toMatch(/UNVERIFIED/);
  });
});
