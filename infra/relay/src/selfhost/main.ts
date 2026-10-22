/**
 * Self-hosted T3 Connect relay: the hosted relay's services on plain Node and
 * Postgres, with the built-in tunnel gateway in place of Cloudflare Tunnel.
 * See docs/operations/self-hosted-connect.md.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync or createPublicKey.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer and the tunnel gateway take a Node server.
import * as NodeHttp from "node:http";
import * as NodeURL from "node:url";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import { eq } from "drizzle-orm";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Etag from "effect/http/Etag";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiScalar from "effect/http-api/HttpApiScalar";

import { RelayApi } from "@t3tools/contracts/relay";
import { TUNNEL_CONNECT_PATH } from "@t3tools/shared/tunnelConnector";

import * as AgentActivityPublisher from "../agentActivity/AgentActivityPublisher.ts";
import * as AgentActivityRows from "../agentActivity/AgentActivityRows.ts";
import * as ApnsClient from "../agentActivity/ApnsClient.ts";
import * as ApnsDeliveries from "../agentActivity/ApnsDeliveries.ts";
import * as ApnsDeliveryQueue from "../agentActivity/ApnsDeliveryQueue.ts";
import * as ApnsProviderTokens from "../agentActivity/ApnsProviderTokens.ts";
import * as DeliveryAttempts from "../agentActivity/DeliveryAttempts.ts";
import * as Devices from "../agentActivity/Devices.ts";
import * as FcmAssertionSigner from "../agentActivity/FcmAssertionSigner.ts";
import * as FcmClient from "../agentActivity/FcmClient.ts";
import * as FcmDeliveries from "../agentActivity/FcmDeliveries.ts";
import * as FcmDeliveryQueueSender from "../agentActivity/FcmDeliveryQueueSender.ts";
import * as LiveActivities from "../agentActivity/LiveActivities.ts";
import * as MobileRegistrations from "../agentActivity/MobileRegistrations.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as CloudflareApiPause from "../environments/CloudflareApiPause.ts";
import * as EnvironmentConnector from "../environments/EnvironmentConnector.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as EnvironmentLinker from "../environments/EnvironmentLinker.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as EnvironmentPublishSignatures from "../environments/EnvironmentPublishSignatures.ts";
import * as ManagedEndpointAllocations from "../environments/ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as ManagedEndpointReaper from "../environments/ManagedEndpointReaper.ts";
import * as ManagedTunnelLimits from "../environments/ManagedTunnelLimits.ts";
import * as HeldHooks from "../hooks/HeldHooks.ts";
import * as HookForwarder from "../hooks/HookForwarder.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import * as RelayHttpApi from "../http/Api.ts";
import {
  RELAY_HTTP_ROUTER_CONFIG,
  traceRelayHttpRequestWith,
  withoutCapturedParentSpan,
} from "../http/Api.ts";
import * as Observability from "../observability.ts";
import * as WebCrypto from "../WebCrypto.ts";
import { relaySelfHostedSecrets, SELF_HOSTED_SCHEMA_SQL } from "./schema.ts";
import * as SelfHostedTunnels from "./SelfHostedTunnels.ts";
import { makeTunnelGateway, type TunnelGateway } from "./TunnelGateway.ts";

const MIGRATIONS_FOLDER = NodeURL.fileURLToPath(
  new URL("../../migrations/postgres", import.meta.url),
);
const QUEUE_WORKERS = 4;
const QUEUE_MAX_ATTEMPTS = 5;
const QUEUE_RETRY_DELAY = "30 seconds";
const DEFAULT_TUNNEL_LIMIT = 100;

const optionalString = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map(
      Option.flatMap((value) => (value.trim() ? Option.some(value.trim()) : Option.none())),
    ),
  );

const SelfHostedConfig = Config.all({
  databaseUrl: Config.Redacted("DATABASE_URL"),
  publicUrl: Config.String("RELAY_PUBLIC_URL"),
  tunnelDomain: Config.NonEmptyString("RELAY_TUNNEL_DOMAIN"),
  namespace: Config.String("RELAY_NAMESPACE").pipe(Config.withDefault("selfhost")),
  listenHost: Config.String("RELAY_LISTEN_HOST").pipe(Config.withDefault("0.0.0.0")),
  apiPort: Config.Port("RELAY_API_PORT").pipe(Config.withDefault(8787)),
  gatewayPort: Config.Port("RELAY_GATEWAY_PORT").pipe(Config.withDefault(8788)),
  tunnelLimit: Config.Int("RELAY_TUNNEL_LIMIT").pipe(Config.withDefault(DEFAULT_TUNNEL_LIMIT)),
  clerkSecretKey: Config.Redacted("CLERK_SECRET_KEY"),
  clerkPublishableKey: Config.String("CLERK_PUBLISHABLE_KEY"),
  clerkJwtAudience: Config.String("CLERK_JWT_AUDIENCE"),
  apnsEnabled: Config.Boolean("APNS_ENABLED").pipe(Config.withDefault(true)),
  fcmServiceAccount: optionalString("FCM_SERVICE_ACCOUNT"),
});

const loadApnsCredentials = Config.all({
  environment: Config.schema(RelayConfiguration.ApnsEnvironment, "APNS_ENVIRONMENT"),
  teamId: Config.String("APNS_TEAM_ID"),
  keyId: Config.String("APNS_KEY_ID"),
  bundleId: Config.String("APNS_BUNDLE_ID"),
  privateKey: Config.Redacted("APNS_PRIVATE_KEY"),
});

const layerWebcrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

const layerHttpPlatformNotSupported = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("Relay API does not serve filesystem responses"),
  fileWebResponse: () => Effect.die("Relay API does not serve file responses"),
});

/** Generated once and kept in Postgres, so restarts keep issued tokens valid. */
const loadOrCreateSecrets = Effect.fnUntraced(function* (db: RelayDb.RelayDb["Service"]) {
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const loadOrCreate = (name: string, generate: () => string) =>
    db
      .insert(relaySelfHostedSecrets)
      .values({ name, value: generate(), createdAt })
      .onConflictDoNothing()
      .pipe(
        Effect.andThen(
          db
            .select({ value: relaySelfHostedSecrets.value })
            .from(relaySelfHostedSecrets)
            .where(eq(relaySelfHostedSecrets.name, name)),
        ),
        Effect.map((rows) => rows[0]!.value),
      );
  const randomSecret = () => NodeCrypto.randomBytes(32).toString("base64url");
  const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const cloudMintPrivateKey = yield* loadOrCreate(
    "cloud_mint_private_key",
    () => keyPair.privateKey,
  );
  const cloudMintPublicKey = NodeCrypto.createPublicKey(cloudMintPrivateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  return {
    cloudMintPrivateKey,
    cloudMintPublicKey,
    apnsDeliveryJobSigningSecret: yield* loadOrCreate(
      "apns_delivery_job_signing_secret",
      randomSecret,
    ),
    tunnelTokenSecret: yield* loadOrCreate("tunnel_token_secret", randomSecret),
  };
});

/** Fixed-window counters standing in for Cloudflare's rate limit binding. */
function makeRateLimiter(limit: { readonly limit: number; readonly periodSeconds: number }) {
  const windows = new Map<string, { readonly startedAt: number; count: number }>();
  return (key: string): Effect.Effect<boolean> =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      const periodMs = limit.periodSeconds * 1000;
      if (windows.size > 10_000) {
        for (const [candidate, window] of windows) {
          if (now - window.startedAt >= periodMs) windows.delete(candidate);
        }
      }
      const current = windows.get(key);
      if (current === undefined || now - current.startedAt >= periodMs) {
        windows.set(key, { startedAt: now, count: 1 });
        return true;
      }
      current.count += 1;
      return current.count <= limit.limit;
    });
}

// Held webhooks need a durable per-environment inbox (a Durable Object on
// Cloudflare). Not offered here yet: holding reports a full inbox, so senders
// get the same answer as for an offline environment without holding.
const layerHookInboxUnavailable = Layer.succeed(HookInbox.HookInbox, {
  hold: () => Effect.succeed(false),
  wake: () => Effect.succeed(false),
  clear: () => Effect.void,
});

interface QueuedJob {
  readonly body: unknown;
  readonly attempt: number;
}

const program = Effect.gen(function* () {
  const settings = yield* SelfHostedConfig;
  const publicUrl = new URL(settings.publicUrl);
  if (publicUrl.protocol !== "https:" || publicUrl.pathname !== "/") {
    return yield* Effect.die(
      new Error("RELAY_PUBLIC_URL must be an https origin, like https://relay.example.com"),
    );
  }
  const relayPublicOrigin = publicUrl.origin;
  const tunnelDomain = settings.tunnelDomain.trim().toLowerCase().replace(/\.$/u, "");
  const apnsCredentials = settings.apnsEnabled ? yield* loadApnsCredentials : null;

  const pgContext = yield* Layer.build(PgClient.layer({ url: settings.databaseUrl }));
  const db = yield* PgDrizzle.makeWithDefaults().pipe(Effect.provideContext(pgContext));
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- drizzle's migrator types its errors as any.
  yield* migrate(db, {
    migrationsFolder: MIGRATIONS_FOLDER,
    migrationsTable: "relay_migrations",
  }).pipe(Effect.orDie);
  for (const statement of SELF_HOSTED_SCHEMA_SQL) {
    yield* db.$client.unsafe(statement);
  }
  const secrets = yield* loadOrCreateSecrets(db);

  let gateway: TunnelGateway | null = null;
  const tunnels = yield* SelfHostedTunnels.make({
    connectUrl: `wss://${publicUrl.host}${TUNNEL_CONNECT_PATH}`,
    tokenSecret: secrets.tunnelTokenSecret,
    notifier: () => gateway,
  }).pipe(Effect.provideService(RelayDb.RelayDb, db));

  const apnsQueue = yield* Queue.unbounded<QueuedJob>();
  const fcmQueue = yield* Queue.unbounded<QueuedJob>();

  const configuration = RelayConfiguration.RelayConfiguration.of({
    relayIssuer: relayPublicOrigin,
    ...(Option.isSome(settings.fcmServiceAccount)
      ? { fcmServiceAccount: Redacted.make(settings.fcmServiceAccount.value) }
      : {}),
    apns: apnsCredentials,
    apnsDeliveryJobSigningSecret: Redacted.make(secrets.apnsDeliveryJobSigningSecret),
    clerkSecretKey: settings.clerkSecretKey,
    clerkPublishableKey: settings.clerkPublishableKey,
    clerkJwtAudience: settings.clerkJwtAudience,
    cloudMintPrivateKey: Redacted.make(secrets.cloudMintPrivateKey),
    cloudMintPublicKey: secrets.cloudMintPublicKey,
    managedEndpointBaseDomain: tunnelDomain,
    managedEndpointNamespace: settings.namespace,
    managedEndpointCleanupMode: yield* RelayConfiguration.managedEndpointCleanupModeConfig,
    legacyManagedEndpointCleanupMode:
      yield* RelayConfiguration.legacyManagedEndpointCleanupModeConfig,
    managedTunnelDefaultLimit: settings.tunnelLimit,
  });

  const layerFoundation = Layer.empty.pipe(
    Layer.provideMerge(EnvironmentCredentials.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        CloudflareApiPause.layer,
        EnvironmentLinks.layer,
        ManagedEndpointAllocations.layer,
        ManagedTunnelLimits.layer,
      ),
    ),
    Layer.provideMerge(LiveActivities.layer),
    Layer.provideMerge(DeliveryAttempts.layer),
    Layer.provideMerge(RelayTokens.layer),
    Layer.provideMerge(
      RelayDb.RelayTransactions.layer.pipe(Layer.provideMerge(Layer.succeed(RelayDb.RelayDb, db))),
    ),
    Layer.provideMerge(Layer.succeed(RelayConfiguration.RelayConfiguration, configuration)),
    Layer.provideMerge(layerWebcrypto),
    Layer.provideMerge(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer)),
  );
  const layerRuntime = Layer.empty.pipe(
    Layer.provideMerge(MobileRegistrations.layer),
    Layer.provideMerge(AgentActivityPublisher.layer),
    Layer.provideMerge(EnvironmentConnector.layer),
    Layer.provideMerge(EnvironmentLinker.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        EnvironmentPublishSignatures.layer,
        ManagedEndpointReaper.layer,
        HeldHooks.layer,
      ),
    ),
    Layer.provideMerge(
      ManagedEndpointProvider.layer.pipe(
        Layer.provideMerge(ManagedEndpointProvider.layerTunnelClient(tunnels.tunnelClient)),
        Layer.provideMerge(ManagedEndpointProvider.layerDnsClient(tunnels.dnsClient)),
      ),
    ),
    Layer.provideMerge(DpopProofs.layer),
    Layer.provideMerge(ApnsDeliveries.layer),
    Layer.provideMerge(
      FcmDeliveries.layer.pipe(
        Layer.provide(
          Layer.succeed(FcmDeliveryQueueSender.FcmDeliveryQueueSender, {
            send: (body) => Queue.offer(fcmQueue, { body, attempt: 1 }).pipe(Effect.asVoid),
          }),
        ),
        Layer.provideMerge(
          FcmClient.layer.pipe(
            Layer.provide(FcmAssertionSigner.layer),
            Layer.provide(Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle })),
          ),
        ),
      ),
    ),
    Layer.provideMerge(ApnsClient.layer.pipe(Layer.provideMerge(ApnsProviderTokens.layer))),
    Layer.provideMerge(
      ApnsDeliveryQueue.layer.pipe(
        Layer.provide(
          Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, {
            send: (body) => Queue.offer(apnsQueue, { body, attempt: 1 }).pipe(Effect.asVoid),
          }),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(AgentActivityRows.layer, Devices.layer, layerHookInboxUnavailable),
    ),
    Layer.provideMerge(layerFoundation),
  );
  const runtimeContext = yield* Layer.build(layerRuntime);
  const layerRuntimeContext = Layer.succeedContext(runtimeContext);

  // Push delivery queues: retried in process, like the Cloudflare queues' retry policy.
  /** `process` reports whether the delivery is done; false retries it. */
  const runQueue = (
    name: string,
    queue: Queue.Queue<QueuedJob>,
    process: (body: unknown) => Effect.Effect<boolean>,
  ) =>
    Effect.forever(
      Effect.gen(function* () {
        const job = yield* Queue.take(queue);
        if (yield* process(job.body)) return;
        if (job.attempt >= QUEUE_MAX_ATTEMPTS) {
          yield* Effect.logWarning(`${name} delivery dropped after ${job.attempt} attempts`);
          return;
        }
        yield* Effect.logWarning(`${name} delivery failed; retrying`, { attempt: job.attempt });
        yield* Effect.sleep(QUEUE_RETRY_DELAY).pipe(
          Effect.andThen(Queue.offer(queue, { body: job.body, attempt: job.attempt + 1 })),
          Effect.forkDetach,
        );
      }),
    ).pipe(Effect.forkScoped);
  const reportDelivery =
    (name: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<boolean, never, R> =>
      effect.pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning(`${name} delivery attempt failed`, { cause }).pipe(Effect.as(false)),
        ),
      );
  for (let worker = 0; worker < QUEUE_WORKERS; worker++) {
    yield* runQueue("APNs", apnsQueue, (body) =>
      ApnsDeliveries.ApnsDeliveries.pipe(
        Effect.flatMap((deliveries) => deliveries.processSignedJob(body)),
        reportDelivery("APNs"),
        Effect.provideContext(runtimeContext),
      ),
    );
    yield* runQueue("FCM", fcmQueue, (body) =>
      FcmDeliveries.FcmDeliveries.pipe(
        Effect.flatMap((deliveries) => deliveries.process(body)),
        reportDelivery("FCM"),
        Effect.provideContext(runtimeContext),
      ),
    );
  }

  // Same five-minute housekeeping as the Worker's cron trigger.
  const logHousekeepingFailure =
    (task: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning(`Relay housekeeping failed: ${task}`, { cause }),
        ),
      );
  yield* Effect.all(
    [
      DpopProofs.DpopProofReplay.pipe(
        Effect.flatMap((dpopProofs) => dpopProofs.pruneExpired),
        Effect.andThen(
          Effect.all([AgentActivityRows.AgentActivityRows, DateTime.now]).pipe(
            Effect.flatMap(([activityRows, now]) =>
              activityRows.pruneTerminal({
                updatedBefore: DateTime.formatIso(DateTime.subtract(now, { minutes: 30 })),
              }),
            ),
          ),
        ),
        logHousekeepingFailure("prune expired state"),
      ),
      ManagedEndpointReaper.ManagedEndpointReaper.pipe(
        Effect.flatMap((reaper) => reaper.sweep.pipe(Effect.timeout("2 minutes"))),
        logHousekeepingFailure("managed tunnel cleanup"),
      ),
      AgentActivityPublisher.AgentActivityPublisher.pipe(
        Effect.flatMap((publisher) => publisher.endIdleLiveActivities),
        logHousekeepingFailure("end idle Live Activities"),
      ),
    ],
    { concurrency: 3, discard: true },
  ).pipe(
    Effect.withSpan("relay.cron.prune_expired_state"),
    Effect.provideContext(runtimeContext),
    Effect.repeat(Schedule.spaced("5 minutes")),
    Effect.forkScoped,
  );

  const rateLimiter = Layer.succeed(HookForwarder.HookRateLimiter, {
    allowHook: makeRateLimiter(HookForwarder.RELAY_HOOK_RATE_LIMIT),
    allowEndpoint: makeRateLimiter(HookForwarder.RELAY_HOOK_ENDPOINT_RATE_LIMIT),
  });

  const layerApp = Layer.merge(
    Layer.mergeAll(
      RelayHttpApi.layerHealthApi,
      RelayHttpApi.layerMetadataApi,
      RelayHttpApi.layerMobileApi,
      RelayHttpApi.layerClientApi,
      RelayHttpApi.layerTokenApi,
      RelayHttpApi.layerDpopClientApi,
      RelayHttpApi.layerServerApi,
    ),
    HookForwarder.layerApi.pipe(Layer.provide(HookForwarder.layer), Layer.provide(rateLimiter)),
  ).pipe(
    Layer.provideMerge(RelayHttpApi.layerClientAuth),
    Layer.provideMerge(RelayHttpApi.layerDpopClientAuth),
    Layer.provideMerge(RelayHttpApi.layerEnvironmentAuth),
    Layer.provide(layerRuntimeContext),
  );

  const httpEffect = yield* Layer.merge(
    Layer.mergeAll(
      HttpApiBuilder.layer(RelayApi, { openapiPath: "/openapi.json" }).pipe(
        Layer.provide(layerApp),
      ),
      HttpApiScalar.layer(RelayApi, { path: "/docs" }),
      RelayHttpApi.layerDocsRedirectRoute,
    ).pipe(Layer.provide([Etag.layerWeak, layerHttpPlatformNotSupported, RelayHttpApi.layerCors])),
    RelayHttpApi.layerNotFoundRoute,
  ).pipe(
    HttpRouter.toHttpEffect,
    Effect.provideService(HttpRouter.RouterConfig, RELAY_HTTP_ROUTER_CONFIG),
    withoutCapturedParentSpan,
    Effect.map((effect) =>
      traceRelayHttpRequestWith(effect, Layer.empty).pipe(
        Observability.withSchemaErrorSpanAttributes,
      ),
    ),
  );

  const serverContext = yield* Layer.build(
    NodeHttpServer.layer(NodeHttp.createServer, {
      host: settings.listenHost,
      port: settings.apiPort,
    }),
  );
  yield* HttpServer.serveEffect(httpEffect.pipe(Effect.provideContext(runtimeContext))).pipe(
    Effect.provideContext(serverContext),
  );

  gateway = makeTunnelGateway({
    tunnelDomain,
    authenticate: (token) => Effect.runPromise(tunnels.authenticate(token)),
    isTunnelHostname: (hostname) => Effect.runPromise(tunnels.isTunnelHostname(hostname)),
    onConnectorsChanged: (tunnelId, connected) => {
      Effect.runFork(tunnels.recordConnectorCount(tunnelId, connected));
    },
    log: (message, attributes) => {
      Effect.runFork(Effect.logInfo(message, attributes ?? {}));
    },
  });
  const activeGateway = gateway;
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      activeGateway.server.once("error", (error) => resume(Effect.die(error)));
      activeGateway.server.listen(settings.gatewayPort, settings.listenHost, () =>
        resume(Effect.void),
      );
    }),
    () => Effect.promise(() => activeGateway.close()),
  );

  yield* Effect.logInfo("Self-hosted T3 Connect relay ready", {
    relay: relayPublicOrigin,
    tunnelDomain,
    apiPort: settings.apiPort,
    gatewayPort: settings.gatewayPort,
    push: { apns: apnsCredentials !== null, fcm: Option.isSome(settings.fcmServiceAccount) },
  });
  return yield* Effect.never;
});

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
