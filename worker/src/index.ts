import { ConversationHub } from './hub.js';
import type { Env } from './config.js';

export { ConversationHub };

/**
 * All conversation state lives in one Durable Object, so every request that
 * touches it routes to the same instance.
 */
function hub(env: Env): DurableObjectStub {
  return env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName('default'));
}

const API_PREFIXES = ['/api/', '/inbound/', '/ens/', '/ws'];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({ ok: true, mode: env.SFMC_MODE ?? 'live', runtime: 'workers' }),
        { headers: { 'content-type': 'application/json' } },
      );
    }

    if (API_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
      return hub(env).fetch(request);
    }

    // Everything else is the chat UI.
    return env.ASSETS.fetch(request);
  },

  /**
   * Cron trigger.
   *
   * Workers cannot hold a setInterval, so the inbound Data Extension poll runs
   * on a schedule. One minute is the finest granularity Cron Triggers allow,
   * which is the latency cost of this platform for inbound SMS.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      hub(env)
        .fetch(new Request('https://hub/internal/poll', { method: 'POST' }))
        .then(() => undefined)
        .catch((error: unknown) => {
          console.error('[cron] inbound poll failed', error);
        }),
    );
  },
} satisfies ExportedHandler<Env>;
