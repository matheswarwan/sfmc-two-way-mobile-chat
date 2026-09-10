import type { FastifyInstance } from 'fastify';
import type { ConversationStore } from '../conversations/store.js';
import type { RealtimeHub } from '../realtime/hub.js';
import type { EnsService } from './service.js';
import { parseDeliveryEvent, supersedes } from './events.js';
import { isValidSignature } from './signature.js';

export interface EnsRouteDeps {
  ens: EnsService;
  store: ConversationStore;
  hub: RealtimeHub;
}

export function registerEnsRoutes(app: FastifyInstance, deps: EnsRouteDeps): void {
  const { ens, store, hub } = deps;

  /**
   * ENS callback.
   *
   * Two kinds of request arrive here: the one-off verification challenge, and
   * batches of delivery events. Salesforce's own guidance is to tell them apart
   * by the presence of `verificationKey`.
   *
   * ENS allows 3 seconds to respond and suspends a callback that keeps failing,
   * so this acknowledges first and does the work without blocking the reply.
   */
  app.post(
    '/ens/callback',
    async (request, reply) => {
      const raw = (request as typeof request & { rawBody?: string }).rawBody ?? '';
      const payload = request.body;

      // Verification challenge: respond 200 quickly, no signature yet.
      const challenge = payload as { callbackId?: string; verificationKey?: string } | undefined;
      if (challenge?.verificationKey && challenge.callbackId) {
        ens.recordVerification(challenge.callbackId, challenge.verificationKey);
        app.log.info('[ens] verification challenge received');
        return reply.code(200).send({ ok: true });
      }

      const registration = ens.getRegistration();
      if (!registration) {
        app.log.warn('[ens] event received but no callback is registered');
        return reply.code(200).send({ ok: true });
      }

      const signature = request.headers['x-sfmc-ens-signature'];
      if (!isValidSignature(raw, typeof signature === 'string' ? signature : undefined, registration.signatureKey)) {
        // Do not process unsigned traffic, but do not invite retries either.
        app.log.warn('[ens] rejected a notification with an invalid signature');
        return reply.code(401).send({ error: 'invalid signature' });
      }

      // Acknowledge inside the 3 second budget, then apply.
      void reply.code(202).send({ ok: true });

      const events = Array.isArray(payload) ? payload : [payload];
      for (const item of events) {
        applyDeliveryEvent(item);
      }
      return reply;
    },
  );

  /**
   * Apply one delivery event to the message it belongs to.
   *
   * Events are at-least-once with no ordering guarantee, so a status only moves
   * forward and a repeat is a no-op.
   */
  function applyDeliveryEvent(raw: unknown): void {
    const event = parseDeliveryEvent(raw);
    if (!event) return;

    const message = event.messageKey
      ? store.findMessageByProviderId(event.messageKey)
      : event.mobileNumber
        ? store.findLatestOutbound('sms', event.mobileNumber)
        : undefined;

    if (!message) return;
    if (!supersedes(message.status, event.status)) return;

    const updated = store.setStatus(message.id, event.status, event.reason);
    if (updated) hub.broadcast({ type: 'message.updated', message: updated });
  }
}

