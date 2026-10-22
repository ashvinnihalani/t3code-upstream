// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Exercises the raw socket gateway with real sockets.
import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";

import {
  encodeTunnelToken,
  runTunnelConnector,
  type TunnelConnectorEvent,
  type TunnelWebSocket,
} from "@t3tools/shared/tunnelConnector";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { WebSocket, WebSocketServer } from "ws";

import { makeTunnelGateway, type TunnelAuthResult } from "./TunnelGateway.ts";

const TUNNEL_DOMAIN = "tunnels.example.test";
const HOSTNAME = `desk1.${TUNNEL_DOMAIN}`;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function listen(server: NodeHttp.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

async function startOrigin() {
  const seen: Array<{ host: string | undefined; forwardedHost: string | undefined }> = [];
  const origin = NodeHttp.createServer((request, response) => {
    seen.push({
      host: request.headers.host,
      forwardedHost: request.headers["x-forwarded-host"] as string | undefined,
    });
    if (request.url === "/big") {
      response.end(Buffer.alloc(3 * 1024 * 1024, 7));
      return;
    }
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          method: request.method,
          url: request.url,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
  });
  const wss = new WebSocketServer({ server: origin });
  wss.on("connection", (socket) =>
    socket.on("message", (data) => socket.send(`echo:${String(data)}`)),
  );
  const port = await listen(origin);
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        origin.close(() => resolve());
        origin.closeAllConnections();
      }),
  );
  return { port, seen };
}

async function startGateway(authenticate: (token: string) => Promise<TunnelAuthResult>) {
  const changes: Array<[string, number]> = [];
  const gateway = makeTunnelGateway({
    tunnelDomain: TUNNEL_DOMAIN,
    authenticate,
    isTunnelHostname: async (hostname) => hostname === HOSTNAME,
    onConnectorsChanged: (tunnelId, count) => changes.push([tunnelId, count]),
  });
  const port = await listen(gateway.server);
  cleanups.push(() => gateway.close());
  return { gateway, port, changes };
}

function connectorFor(gatewayPort: number, tunnelId = "tun-1") {
  const events: Array<TunnelConnectorEvent> = [];
  const token = encodeTunnelToken({
    url: `ws://127.0.0.1:${gatewayPort}/v1/tunnel/connect`,
    tunnelId,
    signature: "sig",
  });
  let onEvent: (event: TunnelConnectorEvent) => void = () => {};
  const handle = runTunnelConnector({
    token,
    createWebSocket: (url) => new WebSocket(url) as unknown as TunnelWebSocket,
    onEvent: (event) => {
      events.push(event);
      onEvent(event);
    },
  });
  cleanups.push(() => handle.stop());
  const next = (type: TunnelConnectorEvent["type"]) =>
    new Promise<TunnelConnectorEvent>((resolve) => {
      const existing = events.find((event) => event.type === type);
      if (existing) return resolve(existing);
      onEvent = (event) => {
        if (event.type === type) resolve(event);
      };
    });
  return { handle, token, events, next };
}

function publicRequest(
  gatewayPort: number,
  options: {
    method?: string;
    path: string;
    body?: string;
    host?: string;
    headers?: NodeHttp.OutgoingHttpHeaders;
  },
) {
  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const request = NodeHttp.request(
      {
        host: "127.0.0.1",
        port: gatewayPort,
        method: options.method ?? "GET",
        path: options.path,
        headers: { host: options.host ?? HOSTNAME, ...options.headers },
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }),
        );
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });
}

describe("TunnelGateway", () => {
  it("forwards HTTP requests and WebSocket upgrades through a connector", async () => {
    const origin = await startOrigin();
    const { port, changes } = await startGateway(async (token) =>
      token.length > 0
        ? {
            status: "ok",
            tunnel: {
              tunnelId: "tun-1",
              hostname: HOSTNAME,
              origin: { host: "127.0.0.1", port: origin.port },
            },
          }
        : { status: "unauthorized" },
    );
    const connector = connectorFor(port);
    expect(await connector.next("connected")).toMatchObject({ hostname: HOSTNAME });
    expect(changes).toEqual([["tun-1", 1]]);

    const posted = await publicRequest(port, {
      method: "POST",
      path: "/api/echo?x=1",
      body: "hello",
      headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
    });
    expect(posted.status).toBe(200);
    expect(JSON.parse(posted.body.toString())).toEqual({
      method: "POST",
      url: "/api/echo?x=1",
      body: "hello",
    });
    // The original Host survives; the proxy's forwarded authority does not.
    expect(origin.seen.at(-1)).toEqual({ host: HOSTNAME, forwardedHost: undefined });

    const big = await publicRequest(port, { path: "/big" });
    expect(big.body.byteLength).toBe(3 * 1024 * 1024);
    expect(big.body.every((byte) => byte === 7)).toBe(true);

    const concurrent = await Promise.all(
      Array.from({ length: 20 }, (_, index) => publicRequest(port, { path: `/n/${index}` })),
    );
    expect(concurrent.map((result) => JSON.parse(result.body.toString()).url)).toEqual(
      Array.from({ length: 20 }, (_, index) => `/n/${index}`),
    );

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { host: HOSTNAME } });
    cleanups.push(() => ws.terminate());
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("ping"));
      ws.on("message", (data) => resolve(String(data)));
      ws.on("error", reject);
    });
    expect(reply).toBe("echo:ping");
  });

  it("answers 502 while no connector serves the hostname and 404 for other hosts", async () => {
    const { port } = await startGateway(async () => ({ status: "unauthorized" }));
    expect((await publicRequest(port, { path: "/" })).status).toBe(502);
    expect((await publicRequest(port, { path: "/", host: "relay.example.test" })).status).toBe(404);
    expect(
      (await publicRequest(port, { path: `/tls-ask?domain=${HOSTNAME}`, host: "gateway" })).status,
    ).toBe(200);
    expect(
      (await publicRequest(port, { path: "/tls-ask?domain=other.example.test", host: "gateway" }))
        .status,
    ).toBe(404);
  });

  it("rejects a connector whose token does not authenticate", async () => {
    const { port } = await startGateway(async () => ({ status: "unauthorized" }));
    const connector = connectorFor(port);
    expect(await connector.next("rejected")).toEqual({ type: "rejected", reason: "unauthorized" });
    expect(connector.handle.connected()).toBe(false);
  });

  it("disconnects connectors when their tunnel is deleted", async () => {
    const origin = await startOrigin();
    const { gateway, port } = await startGateway(async () => ({
      status: "ok",
      tunnel: {
        tunnelId: "tun-1",
        hostname: HOSTNAME,
        origin: { host: "127.0.0.1", port: origin.port },
      },
    }));
    const connector = connectorFor(port);
    await connector.next("connected");
    gateway.closeTunnel("tun-1");
    expect(await connector.next("rejected")).toEqual({ type: "rejected", reason: "unauthorized" });
    expect((await publicRequest(port, { path: "/" })).status).toBe(502);
  });

  it("refuses a non-loopback origin from the gateway", async () => {
    const { port } = await startGateway(async () => ({
      status: "ok",
      tunnel: { tunnelId: "tun-1", hostname: HOSTNAME, origin: { host: "10.0.0.5", port: 80 } },
    }));
    const connector = connectorFor(port);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(connector.events.some((event) => event.type === "connected")).toBe(false);
  });
});
