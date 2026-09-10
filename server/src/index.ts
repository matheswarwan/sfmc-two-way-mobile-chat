import { loadConfig } from './config/index.js';
import { ClientCredentialsTokenProvider } from './auth/tokenProvider.js';
import { RestSfmcClient, type SfmcClient } from './sfmc/client.js';
import { MockSfmcClient } from './sfmc/mockClient.js';
import { RestSfmcProvisioner, type SfmcProvisioner } from './sfmc/provisioning.js';
import { MockSfmcProvisioner } from './sfmc/mockProvisioner.js';
import { SqliteConversationStore } from './conversations/sqliteStore.js';
import { InboundIngest } from './inbound/ingest.js';
import { InboundPoller } from './inbound/poller.js';
import { DeliveryPoller } from './inbound/deliveryPoller.js';
import { RealtimeHub } from './realtime/hub.js';
import { buildServer } from './server.js';
import { EnsService } from './ens/service.js';

const config = loadConfig();

// One token provider shared by the messaging client and the provisioner, so a
// burst of setup calls does not stampede the token endpoint.
const tokens = new ClientCredentialsTokenProvider(config);

const client: SfmcClient =
  config.mode === 'live' ? new RestSfmcClient(config, tokens) : new MockSfmcClient();

const provisioner: SfmcProvisioner =
  client instanceof MockSfmcClient
    ? new MockSfmcProvisioner(client, config.sfmc.codes.map((entry) => entry.code))
    : new RestSfmcProvisioner(config, tokens);

if (config.mode === 'mock') {
  console.warn(
    '[boot] Running in MOCK mode. No SFMC calls will be made. Set SFMC_MODE=live with credentials to talk to a real tenant.',
  );
} else {
  console.warn('[boot] Running in LIVE mode. Real messages will be sent and billed.');
  // Credentials usually arrive before the Outbound message and Data Extension
  // exist, so say plainly what is not wired up rather than failing obscurely.
  for (const warning of config.messaging.warnings) console.warn(`[boot] ${warning}`);
}

// Conversations persist across restarts. Set DATABASE_PATH=:memory: to opt out.
const store = new SqliteConversationStore(process.env['DATABASE_PATH'] ?? 'data/conversations.db');
const hub = new RealtimeHub();
const ingest = new InboundIngest(store, hub);

const poller = new InboundPoller({
  client,
  ingest,
  intervalMs: config.pollIntervalMs,
  shortCode: config.sfmc.shortCode,
});

const ens = new EnsService(config, tokens);

// MobileConnect emits no delivery notifications, so its status must be pulled.
// The transactional transport gets the same information from ENS instead.
const deliveryPoller = new DeliveryPoller({
  client,
  store,
  hub,
  intervalMs: Math.max(config.pollIntervalMs, 5000),
});

const app = await buildServer({ config, client, store, ingest, hub, provisioner, poller, ens });

// Mock mode also exposes the mock client so a demo can inject inbound traffic.
if (client instanceof MockSfmcClient) {
  // A handful of subscribers so the search box has something to find without
  // a tenant. Mirrors the shape a live search returns: a phone number, an
  // optional email, and the codes the number already holds.
  const demoCode = config.sfmc.codes[0]?.code ?? '';
  for (const seed of [
    { mobileNumber: '447700900123', emailAddress: 'jo.rivera@example.com', subscriberKey: 'jo.rivera@example.com' },
    { mobileNumber: '447700900456', emailAddress: 'sam.okafor@example.com', subscriberKey: 'sam.okafor@example.com' },
    { mobileNumber: '15555551212', emailAddress: 'ada@example.com', subscriberKey: '15555551212' },
  ]) {
    client.addSubscriber({
      ...seed,
      subscriptions: [
        {
          mobileNumber: seed.mobileNumber,
          subscriberKey: seed.subscriberKey,
          shortCode: demoCode,
          keyword: config.sfmc.keyword,
          status: 'subscribed',
        },
      ],
    });
  }

  app.post<{ Body: { mobileNumber?: string; body?: string; shortCode?: string } }>(
    '/dev/simulate-inbound',
    async (request, reply) => {
      const mobileNumber = request.body?.mobileNumber;
      const body = request.body?.body;
      if (!mobileNumber || !body) {
        return reply.code(400).send({ error: 'mobileNumber and body are required' });
      }
      client.pushInboundRow({
        mobileNumber,
        body,
        shortCode: request.body?.shortCode ?? config.sfmc.shortCode,
      });
      const accepted = await poller.tick();
      return { accepted };
    },
  );
  await app.ready();
}

if (config.outboundTransport === 'mobileconnect') {
  deliveryPoller.start();
  console.warn('[boot] Polling MobileConnect for delivery status (this transport has no ENS events).');
}

if (config.messaging.canPoll) {
  poller.start();
} else {
  console.warn('[boot] Inbound polling is off until SFMC_INBOUND_DE_KEY is configured.');
}

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    poller.stop();
    deliveryPoller.stop();
    void app.close().then(() => process.exit(0));
  });
}
