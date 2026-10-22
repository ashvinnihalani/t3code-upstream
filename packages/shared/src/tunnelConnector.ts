// @effect-diagnostics globalTimers:off globalRandom:off - Socket-level reconnect loop that runs outside the Effect runtime.
import * as NodeNet from "node:net";

import { binaryMessageData, TunnelMux } from "./tunnelMux.ts";

export const TUNNEL_PROTOCOL_VERSION = 1;
export const TUNNEL_CONNECT_PATH = "/v1/tunnel/connect";
export const TUNNEL_TOKEN_PREFIX = "t3tun1.";
/** The gateway closes with this code when it will not accept the token. */
export const TUNNEL_CLOSE_UNAUTHORIZED = 4401;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_UNAUTHORIZED_MS = 60_000;
// The gateway pings every 20 seconds; corporate proxies drop idle sockets silently.
const SILENCE_TIMEOUT_MS = 60_000;
const HELLO_TIMEOUT_MS = 15_000;

export interface TunnelOrigin {
  readonly host: string;
  readonly port: number;
}

export type TunnelGatewayMessage =
  | { readonly type: "ready"; readonly hostname: string; readonly origin: TunnelOrigin }
  | { readonly type: "config"; readonly hostname: string; readonly origin: TunnelOrigin }
  | { readonly type: "ping" }
  | { readonly type: "error"; readonly reason: "unauthorized" | "not_configured" };

export type TunnelConnectorMessage =
  | { readonly type: "hello"; readonly token: string; readonly version: number }
  | { readonly type: "pong" };

export interface TunnelTokenClaims {
  /** WebSocket URL of the gateway's connect endpoint. */
  readonly url: string;
  readonly tunnelId: string;
  readonly signature: string;
}

export function encodeTunnelToken(claims: TunnelTokenClaims): string {
  const json = JSON.stringify({ u: claims.url, i: claims.tunnelId, s: claims.signature });
  return `${TUNNEL_TOKEN_PREFIX}${Buffer.from(json).toString("base64url")}`;
}

export function decodeTunnelToken(token: string): TunnelTokenClaims | null {
  if (!token.startsWith(TUNNEL_TOKEN_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(token.slice(TUNNEL_TOKEN_PREFIX.length), "base64url").toString("utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const { u, i, s } = parsed as Record<string, unknown>;
    if (typeof u !== "string" || typeof i !== "string" || typeof s !== "string") return null;
    const url = new URL(u);
    if (url.protocol !== "wss:" && url.protocol !== "ws:") return null;
    return { url: url.href, tunnelId: i, signature: s };
  } catch {
    return null;
  }
}

export function isLoopbackTunnelOrigin(origin: TunnelOrigin): boolean {
  const host = origin.host.replace(/^\[(.*)\]$/u, "$1").toLowerCase();
  return (
    (host === "127.0.0.1" || host === "::1" || host === "localhost") &&
    Number.isInteger(origin.port) &&
    origin.port > 0 &&
    origin.port <= 65_535
  );
}

export function parseTunnelGatewayMessage(text: string): TunnelGatewayMessage | null {
  try {
    const message = JSON.parse(text) as { type?: unknown };
    switch (message.type) {
      case "ping":
        return { type: "ping" };
      case "error": {
        const { reason } = message as { reason?: unknown };
        return reason === "unauthorized" || reason === "not_configured"
          ? { type: "error", reason }
          : null;
      }
      case "ready":
      case "config": {
        const { hostname, origin } = message as { hostname?: unknown; origin?: unknown };
        if (typeof hostname !== "string" || typeof origin !== "object" || origin === null) {
          return null;
        }
        const { host, port } = origin as { host?: unknown; port?: unknown };
        if (typeof host !== "string" || typeof port !== "number") return null;
        return { type: message.type, hostname, origin: { host, port } };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** The subset of the WHATWG WebSocket API the connector uses. */
export interface TunnelWebSocket {
  binaryType: string;
  readonly bufferedAmount: number;
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(
    type: "close",
    listener: (event: { readonly code: number; readonly reason: string }) => void,
  ): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
}

export type TunnelConnectorEvent =
  | { readonly type: "connected"; readonly hostname: string; readonly origin: TunnelOrigin }
  | { readonly type: "disconnected"; readonly reason: string }
  | { readonly type: "rejected"; readonly reason: "unauthorized" | "not_configured" | "bad_token" };

export interface TunnelConnectorOptions {
  readonly token: string;
  readonly createWebSocket: (url: string) => TunnelWebSocket;
  readonly onEvent: (event: TunnelConnectorEvent) => void;
}

export interface TunnelConnectorHandle {
  readonly stop: () => void;
  readonly connected: () => boolean;
  readonly hostname: () => string | null;
}

/** Keeps one tunnel connection up until stopped, reconnecting with backoff. */
export function runTunnelConnector(options: TunnelConnectorOptions): TunnelConnectorHandle {
  const claims = decodeTunnelToken(options.token);
  let stopped = false;
  let socket: TunnelWebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let isConnected = false;
  let currentHostname: string | null = null;

  if (claims === null) {
    queueMicrotask(() => options.onEvent({ type: "rejected", reason: "bad_token" }));
    return { stop: () => {}, connected: () => false, hostname: () => null };
  }

  const scheduleReconnect = (delayMs?: number) => {
    if (stopped || retryTimer !== null) return;
    const backoff = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    attempt += 1;
    const delay = delayMs ?? backoff / 2 + Math.random() * (backoff / 2);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    if (stopped) return;
    let ws: TunnelWebSocket;
    try {
      ws = options.createWebSocket(claims.url);
    } catch (error) {
      options.onEvent({ type: "disconnected", reason: `connect failed: ${String(error)}` });
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.binaryType = "arraybuffer";
    let origin: TunnelOrigin | null = null;
    let rejectedReason: "unauthorized" | "not_configured" | null = null;
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    const mux = new TunnelMux(ws, {
      onStream: (stream) => {
        if (origin === null) {
          stream.destroy();
          return;
        }
        const local = NodeNet.connect({ host: origin.host, port: origin.port });
        local.on("error", () => stream.destroy());
        stream.on("error", () => local.destroy());
        stream.pipe(local);
        local.pipe(stream);
      },
    });
    const armSilenceTimer = (ms: number) => {
      if (silenceTimer !== null) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => ws.close(4000, "silent"), ms);
    };
    const send = (message: TunnelConnectorMessage) => {
      try {
        ws.send(JSON.stringify(message));
      } catch {
        // The close handler reconnects.
      }
    };

    ws.addEventListener("open", () => {
      send({ type: "hello", token: options.token, version: TUNNEL_PROTOCOL_VERSION });
      armSilenceTimer(HELLO_TIMEOUT_MS);
    });
    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      armSilenceTimer(SILENCE_TIMEOUT_MS);
      const binary = binaryMessageData(event.data);
      if (binary !== null) {
        mux.receive(binary);
        return;
      }
      if (typeof event.data !== "string") return;
      const message = parseTunnelGatewayMessage(event.data);
      if (message === null) return;
      switch (message.type) {
        case "ping":
          send({ type: "pong" });
          return;
        case "error":
          rejectedReason = message.reason;
          return;
        case "ready":
        case "config":
          if (!isLoopbackTunnelOrigin(message.origin)) {
            ws.close(4400, "origin must be loopback");
            return;
          }
          origin = message.origin;
          currentHostname = message.hostname;
          if (message.type === "ready") {
            attempt = 0;
            isConnected = true;
            options.onEvent({ type: "connected", hostname: message.hostname, origin });
          }
          return;
      }
    });
    ws.addEventListener("error", () => {
      // Always followed by close.
    });
    ws.addEventListener("close", (event) => {
      if (silenceTimer !== null) clearTimeout(silenceTimer);
      mux.close();
      if (socket !== ws) return;
      socket = null;
      const wasConnected = isConnected;
      isConnected = false;
      if (stopped) return;
      if (rejectedReason !== null || event.code === TUNNEL_CLOSE_UNAUTHORIZED) {
        options.onEvent({ type: "rejected", reason: rejectedReason ?? "unauthorized" });
        scheduleReconnect(RECONNECT_UNAUTHORIZED_MS);
        return;
      }
      if (wasConnected) {
        options.onEvent({ type: "disconnected", reason: event.reason || `code ${event.code}` });
      }
      scheduleReconnect();
    });
  };

  connect();

  return {
    stop: () => {
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      const current = socket;
      socket = null;
      isConnected = false;
      current?.close(1000, "stopped");
    },
    connected: () => isConnected,
    hostname: () => currentHostname,
  };
}
