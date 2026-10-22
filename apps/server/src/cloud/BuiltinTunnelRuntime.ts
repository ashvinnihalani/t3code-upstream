import * as NodeModule from "node:module";

import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import {
  runTunnelConnector,
  type TunnelConnectorEvent,
  type TunnelConnectorHandle,
  type TunnelWebSocket,
} from "@t3tools/shared/tunnelConnector";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import type * as Undici from "undici";

/** `ConnectorFacts.protocol` for the built-in connector; the edge checks are cloudflared's. */
export const BUILTIN_TUNNEL_PROTOCOL = "t3-relay";

// Same recovery window as cloudflared: a token for a deleted tunnel, or a
// gateway that never answers, gets a fresh provision from the relay.
const REGISTRATION_TIMEOUT = Duration.minutes(3);

// undici stays external to the CLI bundle (see outboundHttp.ts).
const requireUndici = NodeModule.createRequire(import.meta.url);

/** Corporate networks often allow only an HTTP proxy; undici's agent honors HTTPS_PROXY and NO_PROXY. */
function makeWebSocketFactory(): (url: string) => TunnelWebSocket {
  const undici = requireUndici("undici") as typeof Undici;
  const dispatcher = new undici.EnvHttpProxyAgent();
  return (url) => new undici.WebSocket(url, { dispatcher }) as unknown as TunnelWebSocket;
}

interface ActiveConnector {
  readonly configKey: string;
  readonly config: RelayManagedEndpointRuntimeConfig;
  readonly handle: TunnelConnectorHandle;
  readonly watchdog: Fiber.Fiber<void>;
}

/**
 * Runs the self-hosted relay's tunnel connector in process. Implements the
 * parts of `CloudManagedEndpointRuntime` that differ from cloudflared;
 * `ManagedEndpointRuntime` routes `t3_relay` configs here.
 */
export const make = Effect.fnUntraced(function* (signals: {
  /** The runtime's own queues, so both connectors report through the same streams. */
  readonly readinessChanges: Queue.Queue<void>;
  readonly tunnelConnections: Queue.Queue<void>;
  readonly recoveryRequests: Queue.Queue<RelayManagedEndpointRuntimeConfig>;
}) {
  const { readinessChanges, tunnelConnections, recoveryRequests } = signals;
  const services = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(services);
  let createWebSocket: ((url: string) => TunnelWebSocket) | null = null;
  let active: ActiveConnector | null = null;

  const stopActive = Effect.gen(function* () {
    const current = active;
    active = null;
    if (current === null) return;
    current.handle.stop();
    yield* Fiber.interrupt(current.watchdog);
    yield* Effect.logInfo("Built-in tunnel connector stopped", {
      tunnelId: current.config.tunnelId,
    });
  });

  const onEvent = Effect.fn("BuiltinTunnelRuntime.onEvent")(function* (
    config: RelayManagedEndpointRuntimeConfig,
    event: TunnelConnectorEvent,
  ) {
    if (active?.config !== config) return;
    switch (event.type) {
      case "connected":
        yield* Effect.logInfo("Built-in tunnel connected", { hostname: event.hostname });
        yield* Queue.offer(tunnelConnections, undefined);
        break;
      case "disconnected":
        yield* Effect.logWarning("Built-in tunnel disconnected; reconnecting", {
          reason: event.reason,
        });
        break;
      case "rejected":
        yield* Effect.logWarning("Relay rejected the tunnel token; requesting recovery", {
          reason: event.reason,
          tunnelId: config.tunnelId,
        });
        yield* Queue.offer(recoveryRequests, config);
        break;
    }
    yield* Queue.offer(readinessChanges, undefined);
  });

  // Lives as long as the connector; untraced so it does not hold a span open.
  const watchRegistration = Effect.fnUntraced(function* (
    config: RelayManagedEndpointRuntimeConfig,
  ) {
    while (true) {
      yield* Effect.sleep(REGISTRATION_TIMEOUT);
      if (active?.config !== config || active.handle.connected()) return;
      yield* Effect.logWarning("Built-in tunnel has not connected; requesting recovery", {
        tunnelId: config.tunnelId,
      });
      yield* Queue.offer(recoveryRequests, config);
    }
  });

  const applyConfig = Effect.fn("BuiltinTunnelRuntime.applyConfig")(function* (
    config: RelayManagedEndpointRuntimeConfig | null,
  ) {
    if (config === null) {
      yield* stopActive;
      return;
    }
    if (active?.configKey === config.connectorToken) return;
    yield* stopActive;
    createWebSocket ??= makeWebSocketFactory();
    const factory = createWebSocket;
    const watchdog = yield* watchRegistration(config).pipe(Effect.forkDetach);
    active = {
      configKey: config.connectorToken,
      config,
      watchdog,
      handle: runTunnelConnector({
        token: config.connectorToken,
        createWebSocket: factory,
        onEvent: (event) => {
          runFork(onEvent(config, event));
        },
      }),
    };
    yield* Effect.logInfo("Built-in tunnel connector started", { tunnelId: config.tunnelId });
  });

  yield* Effect.addFinalizer(() => stopActive);

  return {
    applyConfig,
    isActive: () => active !== null,
    inspectConnector: Effect.sync(() =>
      active === null
        ? null
        : {
            readyConnections: active.handle.connected() ? 1 : 0,
            hostname: active.handle.hostname(),
            protocol: BUILTIN_TUNNEL_PROTOCOL,
          },
    ),
  };
});
