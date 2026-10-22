// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - A raw socket proxy that runs outside the Effect runtime.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import type { Duplex } from "node:stream";

import { binaryMessageData, TunnelMux } from "@t3tools/shared/tunnelMux";
import {
  TUNNEL_CLOSE_UNAUTHORIZED,
  TUNNEL_CONNECT_PATH,
  TUNNEL_PROTOCOL_VERSION,
  type TunnelConnectorMessage,
  type TunnelGatewayMessage,
  type TunnelOrigin,
} from "@t3tools/shared/tunnelConnector";
import { WebSocketServer, type WebSocket } from "ws";

const PING_INTERVAL_MS = 20_000;
const SILENCE_TIMEOUT_MS = 60_000;
const HELLO_TIMEOUT_MS = 10_000;

export interface TunnelRegistration {
  readonly tunnelId: string;
  readonly hostname: string;
  readonly origin: TunnelOrigin;
}

export type TunnelAuthResult =
  | { readonly status: "ok"; readonly tunnel: TunnelRegistration }
  | { readonly status: "unauthorized" | "not_configured" };

export interface TunnelGatewayOptions {
  /** Public tunnel hostnames are `<label>.<tunnelDomain>`. */
  readonly tunnelDomain: string;
  readonly authenticate: (token: string) => Promise<TunnelAuthResult>;
  /** Answers the reverse proxy's on-demand TLS check. */
  readonly isTunnelHostname: (hostname: string) => Promise<boolean>;
  readonly onConnectorsChanged?: (tunnelId: string, connectedCount: number) => void;
  readonly log?: (message: string, attributes?: Record<string, unknown>) => void;
}

interface ConnectorSession {
  readonly socket: WebSocket;
  readonly mux: TunnelMux;
  tunnel: TunnelRegistration;
}

// Hop-by-hop headers, plus the forwarded authority headers the reverse proxy
// adds: the environment treats those as a sign the request did not come
// through its own tunnel (apps/server/src/cloud/linkChecks.ts).
const STRIPPED_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-host",
  "x-forwarded-proto",
]);
const STRIPPED_UPGRADE_HEADERS = new Set(["x-forwarded-host", "x-forwarded-proto"]);
const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function requestHostname(request: NodeHttp.IncomingMessage): string | null {
  const host = request.headers.host?.trim().toLowerCase();
  if (!host) return null;
  return host.replace(/:\d+$/u, "").replace(/\.$/u, "");
}

function sendJson(socket: WebSocket, message: TunnelGatewayMessage) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function parseConnectorMessage(text: string): TunnelConnectorMessage | null {
  try {
    const message = JSON.parse(text) as { type?: unknown; token?: unknown; version?: unknown };
    if (message.type === "pong") return { type: "pong" };
    if (
      message.type === "hello" &&
      typeof message.token === "string" &&
      typeof message.version === "number"
    ) {
      return { type: "hello", token: message.token, version: message.version };
    }
    return null;
  } catch {
    return null;
  }
}

function offlineResponse(response: NodeHttp.ServerResponse) {
  response.writeHead(502, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end("This T3 Code environment is offline.\n");
}

function rejectUpgrade(socket: NodeNet.Socket | Duplex, status: number, message: string) {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function makeTunnelGateway(options: TunnelGatewayOptions) {
  const tunnelSuffix = `.${options.tunnelDomain.toLowerCase().replace(/\.$/u, "")}`;
  const log = options.log ?? (() => {});
  // Newest last: a restarting connector takes over before the old one drops.
  const sessionsByHostname = new Map<string, Array<ConnectorSession>>();
  const sessionsByTunnel = new Map<string, Set<ConnectorSession>>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  const isTunnelHost = (hostname: string) =>
    hostname.endsWith(tunnelSuffix) && hostname.length > tunnelSuffix.length;

  const currentSession = (hostname: string) => sessionsByHostname.get(hostname)?.at(-1);

  const addSession = (session: ConnectorSession) => {
    const forHost = sessionsByHostname.get(session.tunnel.hostname) ?? [];
    forHost.push(session);
    sessionsByHostname.set(session.tunnel.hostname, forHost);
    const forTunnel = sessionsByTunnel.get(session.tunnel.tunnelId) ?? new Set();
    forTunnel.add(session);
    sessionsByTunnel.set(session.tunnel.tunnelId, forTunnel);
    options.onConnectorsChanged?.(session.tunnel.tunnelId, forTunnel.size);
  };

  const removeSession = (session: ConnectorSession) => {
    const forHost = sessionsByHostname.get(session.tunnel.hostname);
    if (forHost) {
      const remaining = forHost.filter((candidate) => candidate !== session);
      if (remaining.length === 0) sessionsByHostname.delete(session.tunnel.hostname);
      else sessionsByHostname.set(session.tunnel.hostname, remaining);
    }
    const forTunnel = sessionsByTunnel.get(session.tunnel.tunnelId);
    if (forTunnel?.delete(session)) {
      if (forTunnel.size === 0) sessionsByTunnel.delete(session.tunnel.tunnelId);
      options.onConnectorsChanged?.(session.tunnel.tunnelId, forTunnel.size);
    }
  };

  const acceptConnector = (socket: WebSocket) => {
    socket.binaryType = "arraybuffer";
    let session: ConnectorSession | null = null;
    let silenceTimer = setTimeout(() => socket.close(4408, "hello timeout"), HELLO_TIMEOUT_MS);
    const pingTimer = setInterval(() => sendJson(socket, { type: "ping" }), PING_INTERVAL_MS);
    const resetSilence = () => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => socket.close(4000, "silent"), SILENCE_TIMEOUT_MS);
    };

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        const binary = binaryMessageData(data);
        if (session !== null && binary !== null) session.mux.receive(binary);
        resetSilence();
        return;
      }
      const message = parseConnectorMessage(Buffer.from(data as ArrayBuffer).toString("utf8"));
      if (message === null) return;
      resetSilence();
      if (message.type !== "hello" || session !== null) return;
      if (message.version !== TUNNEL_PROTOCOL_VERSION) {
        socket.close(4426, "unsupported protocol version");
        return;
      }
      void options.authenticate(message.token).then(
        (result) => {
          if (socket.readyState !== socket.OPEN) return;
          if (result.status !== "ok") {
            sendJson(socket, { type: "error", reason: result.status });
            socket.close(TUNNEL_CLOSE_UNAUTHORIZED, result.status);
            return;
          }
          session = { socket, mux: new TunnelMux(socket), tunnel: result.tunnel };
          addSession(session);
          sendJson(socket, {
            type: "ready",
            hostname: result.tunnel.hostname,
            origin: result.tunnel.origin,
          });
          log("Tunnel connector connected", { tunnelId: result.tunnel.tunnelId });
        },
        (error: unknown) => {
          log("Tunnel connector authentication failed", { error: String(error) });
          socket.close(1011, "authentication failed");
        },
      );
    });

    socket.on("close", () => {
      clearTimeout(silenceTimer);
      clearInterval(pingTimer);
      if (session !== null) {
        session.mux.close();
        removeSession(session);
        log("Tunnel connector disconnected", { tunnelId: session.tunnel.tunnelId });
      }
    });
    socket.on("error", () => {
      // Followed by close.
    });
  };

  const forwardRequest = (
    session: ConnectorSession,
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ) => {
    const headers: NodeHttp.OutgoingHttpHeaders = { connection: "close" };
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined && !STRIPPED_REQUEST_HEADERS.has(name)) headers[name] = value;
    }
    const upstream = NodeHttp.request(
      {
        method: request.method,
        path: request.url,
        headers,
        createConnection: () => session.mux.open() as NodeNet.Socket,
      },
      (upstreamResponse) => {
        const responseHeaders: NodeHttp.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(upstreamResponse.headers)) {
          if (value !== undefined && !STRIPPED_RESPONSE_HEADERS.has(name)) {
            responseHeaders[name] = value;
          }
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        upstreamResponse.pipe(response);
        upstreamResponse.on("error", () => response.destroy());
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) offlineResponse(response);
      else response.destroy();
    });
    response.on("close", () => {
      if (!response.writableFinished) upstream.destroy();
    });
    request.pipe(upstream);
  };

  const forwardUpgrade = (
    session: ConnectorSession,
    request: NodeHttp.IncomingMessage,
    socket: NodeNet.Socket | Duplex,
    head: Buffer,
  ) => {
    const stream = session.mux.open();
    const lines = [`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/1.1`];
    for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index]!;
      if (!STRIPPED_UPGRADE_HEADERS.has(name.toLowerCase())) {
        lines.push(`${name}: ${request.rawHeaders[index + 1]}`);
      }
    }
    stream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.byteLength > 0) stream.write(head);
    stream.on("error", () => socket.destroy());
    socket.on("error", () => stream.destroy());
    stream.pipe(socket);
    socket.pipe(stream);
  };

  const server = NodeHttp.createServer((request, response) => {
    const hostname = requestHostname(request);
    if (hostname !== null && isTunnelHost(hostname)) {
      const session = currentSession(hostname);
      if (session === undefined) offlineResponse(response);
      else forwardRequest(session, request, response);
      return;
    }
    const url = new URL(request.url ?? "/", "http://gateway");
    if (url.pathname === "/tls-ask") {
      const domain = url.searchParams.get("domain")?.toLowerCase() ?? "";
      const allowed = isTunnelHost(domain)
        ? options.isTunnelHostname(domain)
        : Promise.resolve(false);
      void allowed.then(
        (ok) => {
          response.writeHead(ok ? 200 : 404).end();
        },
        () => {
          response.writeHead(503).end();
        },
      );
      return;
    }
    if (url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
      return;
    }
    response.writeHead(404).end();
  });

  server.on("upgrade", (request, socket, head) => {
    const hostname = requestHostname(request);
    if (hostname !== null && isTunnelHost(hostname)) {
      const session = currentSession(hostname);
      if (session === undefined) rejectUpgrade(socket, 502, "Bad Gateway");
      else forwardUpgrade(session, request, socket, head);
      return;
    }
    if (new URL(request.url ?? "/", "http://gateway").pathname === TUNNEL_CONNECT_PATH) {
      wss.handleUpgrade(request, socket, head, acceptConnector);
      return;
    }
    rejectUpgrade(socket, 404, "Not Found");
  });

  return {
    server,
    /** Pushes a changed hostname or origin to live connectors. */
    updateTunnel: (tunnel: TunnelRegistration) => {
      for (const session of sessionsByTunnel.get(tunnel.tunnelId) ?? []) {
        if (session.tunnel.hostname !== tunnel.hostname) {
          removeSession(session);
          session.tunnel = tunnel;
          addSession(session);
        } else {
          session.tunnel = tunnel;
        }
        sendJson(session.socket, {
          type: "config",
          hostname: tunnel.hostname,
          origin: tunnel.origin,
        });
      }
    },
    /** Disconnects a deleted tunnel's connectors; their tokens no longer authenticate. */
    closeTunnel: (tunnelId: string) => {
      for (const session of sessionsByTunnel.get(tunnelId) ?? []) {
        sendJson(session.socket, { type: "error", reason: "unauthorized" });
        session.socket.close(TUNNEL_CLOSE_UNAUTHORIZED, "tunnel deleted");
      }
    },
    connectedCount: (tunnelId: string) => sessionsByTunnel.get(tunnelId)?.size ?? 0,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export type TunnelGateway = ReturnType<typeof makeTunnelGateway>;
