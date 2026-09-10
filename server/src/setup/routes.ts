import type { FastifyInstance } from 'fastify';
import type { Config } from '../config/index.js';
import type { SfmcProvisioner } from '../sfmc/provisioning.js';
import { SetupStatusService, generateTextResponseAmpscript } from './status.js';
import type { InboundPoller } from '../inbound/poller.js';
import type { ConversationStore } from '../conversations/store.js';
import type { EnsService } from '../ens/service.js';

export interface SetupRouteDeps {
  config: Config;
  provisioner: SfmcProvisioner;
  status: SetupStatusService;
  poller: InboundPoller;
  store: ConversationStore;
  ens: EnsService;
}

export function registerSetupRoutes(app: FastifyInstance, deps: SetupRouteDeps): void {
  const { config, provisioner, status, poller, store, ens } = deps;

  app.get('/api/setup/status', async () => ({
    mode: config.mode,
    steps: await status.getSteps(),
    codes: config.sfmc.codes.map((code) => ({
      code: code.code,
      countryCode: code.countryCode,
      definitionKey: code.definitionKey,
    })),
    config: {
      subdomain: config.sfmc.subdomain,
      shortCode: config.sfmc.shortCode,
      countryCode: config.sfmc.countryCode,
      keyword: config.sfmc.keyword,
      definitionKey: config.sfmc.definitionKey,
      inboundDataExtensionKey: config.sfmc.inboundDataExtensionKey,
      accountId: config.sfmc.accountId ?? null,
    },
  }));

  app.get<{ Querystring: { webhookUrl?: string } }>('/api/setup/ampscript', async (request) => ({
    ampscript: generateTextResponseAmpscript(config, request.query.webhookUrl),
  }));

  /**
   * Creates one artefact. Provisioning is idempotent: an artefact that already
   * exists reports success rather than an error, so the button is safe to press
   * repeatedly while working through setup.
   */
  app.post<{ Params: { step: string } }>('/api/setup/provision/:step', async (request, reply) => {
    if (config.mode !== 'live' && config.mode !== 'mock') {
      return reply.code(400).send({ error: 'Unsupported mode' });
    }

    // Code-scoped steps carry their code in the id, as "send-definition:86288",
    // because an account with several codes needs one of each per code.
    const [step = '', shortCode] = splitStepId(request.params.step);

    switch (step) {
      case 'data-extension':
        return provisioner.createInboundDataExtension();
      case 'keyword':
        return provisioner.createKeyword(shortCode);
      case 'send-definition':
        return provisioner.createSendDefinition(shortCode);
      case 'delivery-events': {
        // Registration, verification and subscription are three calls with an
        // SFMC round trip between them, so one button walks the sequence.
        const registration = ens.getRegistration();
        if (!registration) return ens.registerCallback();
        if (!registration.verified) return ens.verifyCallback();
        return ens.createSubscription();
      }
      default:
        return reply.code(400).send({
          error: `"${request.params.step}" cannot be provisioned by API. See the instructions for this step.`,
        });
    }
  });

  /**
   * Verifies the one step that cannot be automated.
   *
   * Replays an inbound message with queueMO, then polls the Data Extension. If
   * the Text Response message is wired correctly the row appears and the app
   * ingests it. This proves the manual work without touching a handset.
   */
  app.post<{ Body: { mobileNumber?: string; text?: string; shortCode?: string } }>(
    '/api/setup/verify-inbound',
    async (request, reply) => {
      const mobileNumber = (request.body?.mobileNumber ?? '').replace(/\D/g, '');
      if (!mobileNumber) {
        return reply.code(400).send({ error: 'mobileNumber is required' });
      }

      // Tag the probe so it can be identified regardless of which poll picks
      // it up: the background poller races this one and usually wins.
      const text = request.body?.text ?? `setup verification ${Date.now()}`;
      const startedAt = new Date().toISOString();

      const queued = await provisioner.simulateInbound(mobileNumber, text, request.body?.shortCode);
      if (!queued.ok) return reply.code(502).send({ stage: 'queueMO', ...queued });

      // Give SFMC time to process the MO and run the Text Response.
      const deadline = Date.now() + 15_000;
      let arrived = false;
      while (Date.now() < deadline && !arrived) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        // Nudge the poller, but decide by looking at what actually landed.
        await poller.tick();
        arrived = hasInboundSince(store, mobileNumber, text, startedAt);
      }

      return arrived
        ? { ok: true, detail: 'Inbound message was captured and ingested. Setup is working.' }
        : {
            ok: false,
            detail:
              'The message was queued but no row arrived within 15 seconds. Check that the Text Response message is activated on this keyword and that its AMPscript writes to the Data Extension.',
          };
    },
  );
}

/**
 * Did the probe message reach a conversation?
 *
 * Checks the store rather than a poll's return value, so it does not matter
 * whether the verification poll or the background poller ingested it.
 */
function hasInboundSince(
  store: ConversationStore,
  mobileNumber: string,
  text: string,
  sinceIso: string,
): boolean {
  const conversation = store.findConversationByNumber('sms', mobileNumber);
  if (!conversation) return false;

  return store
    .listMessages(conversation.id)
    .some(
      (message) =>
        message.direction === 'inbound' &&
        message.body.includes(text) &&
        message.createdAt >= sinceIso,
    );
}

/**
 * Split "send-definition:86288" into its step and its code.
 *
 * A step with no code returns undefined for it, which every provisioner
 * operation reads as "the default code".
 */
function splitStepId(id: string): [string, string | undefined] {
  const separator = id.indexOf(':');
  if (separator === -1) return [id, undefined];
  return [id.slice(0, separator), id.slice(separator + 1) || undefined];
}
