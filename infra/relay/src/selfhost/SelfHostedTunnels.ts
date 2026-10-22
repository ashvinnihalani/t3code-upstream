// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac, timingSafeEqual or randomUUID.
import * as NodeCrypto from "node:crypto";

import { and, count, eq, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  decodeTunnelToken,
  encodeTunnelToken,
  isLoopbackTunnelOrigin,
} from "@t3tools/shared/tunnelConnector";

import * as RelayDb from "../db.ts";
import {
  type ManagedEndpointDnsClient,
  type ManagedEndpointTunnel,
  type ManagedEndpointTunnelClient,
  ManagedEndpointTunnelClientError,
} from "../environments/ManagedEndpointProvider.ts";
import { relaySelfHostedTunnels } from "./schema.ts";
import type { TunnelAuthResult, TunnelRegistration } from "./TunnelGateway.ts";

/** `isManagedEndpointNotFound` recognizes this tag, as it does Cloudflare's 404. */
class NotFound extends Data.TaggedError("NotFound")<{ readonly tunnelId: string }> {}

export interface TunnelGatewayNotifier {
  readonly updateTunnel: (tunnel: TunnelRegistration) => void;
  readonly closeTunnel: (tunnelId: string) => void;
}

type TunnelRow = typeof relaySelfHostedTunnels.$inferSelect;

function toManagedEndpointTunnel(row: TunnelRow): ManagedEndpointTunnel {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt,
    connsInactiveAt: row.connsInactiveAt,
    deletedAt: row.deletedAt,
  };
}

function toRegistration(row: TunnelRow): TunnelRegistration | null {
  if (row.hostname === null || row.originHost === null || row.originPort === null) return null;
  return {
    tunnelId: row.id,
    hostname: row.hostname,
    origin: { host: row.originHost, port: row.originPort },
  };
}

/** Parses the `http://127.0.0.1:<port>` service the provider writes into ingress. */
function parseOriginService(service: string) {
  try {
    const url = new URL(service);
    const origin = {
      host: url.hostname.replace(/^\[(.*)\]$/u, "$1"),
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    };
    return url.protocol === "http:" && isLoopbackTunnelOrigin(origin) ? origin : null;
  } catch {
    return null;
  }
}

export function signTunnelId(secret: string, tunnelId: string): string {
  return NodeCrypto.createHmac("sha256", secret).update(`t3tun1:${tunnelId}`).digest("base64url");
}

function signatureMatches(secret: string, tunnelId: string, signature: string): boolean {
  const expected = Buffer.from(signTunnelId(secret, tunnelId));
  const actual = Buffer.from(signature);
  return expected.byteLength === actual.byteLength && NodeCrypto.timingSafeEqual(expected, actual);
}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/**
 * Self-hosted stand-in for Cloudflare's tunnel and DNS APIs. The managed
 * endpoint provider keeps its allocation, recovery and cleanup logic; tunnels
 * become rows here and connectors reach them through the built-in gateway.
 * DNS is a single wildcard record, so the DNS client only returns stable ids.
 */
export const make = Effect.fnUntraced(function* (options: {
  /** `wss://<relay>/v1/tunnel/connect`, embedded in each connector token. */
  readonly connectUrl: string;
  readonly tokenSecret: string;
  readonly notifier: () => TunnelGatewayNotifier | null;
}) {
  const db = yield* RelayDb.RelayDb;
  const t = relaySelfHostedTunnels;

  const clientError = (
    operation: ManagedEndpointTunnelClientError["operation"],
    target: { readonly tunnelId?: string; readonly tunnelName?: string },
  ) =>
    Effect.mapError(
      (cause: unknown) => new ManagedEndpointTunnelClientError({ operation, ...target, cause }),
    );

  const loadRow = (tunnelId: string) =>
    db
      .select()
      .from(t)
      .where(eq(t.id, tunnelId))
      .limit(1)
      .pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

  const requireLiveRow = (tunnelId: string) =>
    loadRow(tunnelId).pipe(
      Effect.flatMap((row) =>
        Option.isSome(row) && row.value.deletedAt === null
          ? Effect.succeed(row.value)
          : Effect.fail(new NotFound({ tunnelId })),
      ),
    );

  const tunnelClient: ManagedEndpointTunnelClient["Service"] = {
    runtimeProviderKind: "t3_relay",
    get: (tunnelId) =>
      loadRow(tunnelId).pipe(
        Effect.flatMap((row) =>
          Option.isSome(row)
            ? Effect.succeed(toManagedEndpointTunnel(row.value))
            : Effect.fail(new NotFound({ tunnelId })),
        ),
        clientError("get", { tunnelId }),
      ),
    list: (request) =>
      Effect.gen(function* () {
        const conditions: Array<SQL | undefined> = [isNull(t.deletedAt)];
        if (request.name !== undefined) conditions.push(eq(t.name, request.name));
        if (request.includePrefix !== undefined) {
          conditions.push(sql`starts_with(${t.name}, ${request.includePrefix})`);
        }
        if (request.status !== undefined) conditions.push(eq(t.status, request.status));
        if (request.existedAt !== undefined) conditions.push(lte(t.createdAt, request.existedAt));
        if (request.wasInactiveAt !== undefined) {
          conditions.push(
            or(
              lte(t.connsInactiveAt, request.wasInactiveAt),
              and(eq(t.status, "inactive"), lte(t.createdAt, request.wasInactiveAt)),
            ),
          );
        }
        const where = and(...conditions);
        const page = Math.max(1, request.page ?? 1);
        const perPage = Math.max(1, request.perPage ?? 20);
        const rows = yield* db
          .select()
          .from(t)
          .where(where)
          .orderBy(t.createdAt, t.id)
          .limit(perPage)
          .offset((page - 1) * perPage);
        const total = yield* db.select({ value: count() }).from(t).where(where);
        return {
          result: rows.map(toManagedEndpointTunnel),
          resultInfo: { page, perPage, totalCount: total[0]?.value ?? 0 },
        };
      }).pipe(clientError("list", request.name === undefined ? {} : { tunnelName: request.name })),
    create: (request) =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso;
        const row: TunnelRow = {
          id: NodeCrypto.randomUUID(),
          name: request.name,
          hostname: null,
          originHost: null,
          originPort: null,
          status: "inactive",
          createdAt,
          connsInactiveAt: null,
          deletedAt: null,
        };
        yield* db.insert(t).values(row);
        return toManagedEndpointTunnel(row);
      }).pipe(clientError("create", { tunnelName: request.name })),
    putConfiguration: (tunnelId, config) =>
      Effect.gen(function* () {
        const rule = config.ingress.find((candidate) => candidate.hostname !== undefined);
        const origin = rule ? parseOriginService(rule.service) : null;
        if (rule?.hostname === undefined || origin === null) {
          return yield* Effect.die(
            new Error("Self-hosted tunnels need one loopback HTTP ingress rule"),
          );
        }
        yield* requireLiveRow(tunnelId);
        const hostname = rule.hostname.toLowerCase();
        yield* db
          .update(t)
          .set({ hostname, originHost: origin.host, originPort: origin.port })
          .where(eq(t.id, tunnelId));
        options.notifier()?.updateTunnel({ tunnelId, hostname, origin });
      }).pipe(clientError("put-configuration", { tunnelId })),
    getToken: (tunnelId) =>
      requireLiveRow(tunnelId).pipe(
        Effect.map(() =>
          encodeTunnelToken({
            url: options.connectUrl,
            tunnelId,
            signature: signTunnelId(options.tokenSecret, tunnelId),
          }),
        ),
        clientError("get-token", { tunnelId }),
      ),
    delete: (tunnelId) =>
      Effect.gen(function* () {
        yield* requireLiveRow(tunnelId);
        yield* db
          .update(t)
          .set({ deletedAt: yield* nowIso })
          .where(eq(t.id, tunnelId));
        options.notifier()?.closeTunnel(tunnelId);
      }).pipe(clientError("delete", { tunnelId })),
  };

  const wildcardRecordId = (hostname: string) => `wildcard:${hostname.toLowerCase()}`;
  const dnsClient: ManagedEndpointDnsClient["Service"] = {
    listRecords: (hostname) => Effect.succeed([{ id: wildcardRecordId(hostname) }]),
    createRecord: (request) => Effect.succeed({ id: wildcardRecordId(request.name) }),
    updateRecord: () => Effect.void,
    deleteRecord: () => Effect.void,
  };

  const authenticate = (token: string): Effect.Effect<TunnelAuthResult> =>
    Effect.gen(function* () {
      const claims = decodeTunnelToken(token);
      if (
        claims === null ||
        !signatureMatches(options.tokenSecret, claims.tunnelId, claims.signature)
      ) {
        return { status: "unauthorized" } as const;
      }
      const row = yield* loadRow(claims.tunnelId);
      if (Option.isNone(row) || row.value.deletedAt !== null) {
        return { status: "unauthorized" } as const;
      }
      const tunnel = toRegistration(row.value);
      return tunnel === null
        ? ({ status: "not_configured" } as const)
        : ({ status: "ok", tunnel } as const);
    }).pipe(Effect.orDie);

  const isTunnelHostname = (hostname: string) =>
    db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.hostname, hostname.toLowerCase()), isNull(t.deletedAt)))
      .limit(1)
      .pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      );

  const recordConnectorCount = (tunnelId: string, connected: number) =>
    nowIso
      .pipe(
        Effect.flatMap((now) =>
          db
            .update(t)
            .set(
              connected > 0
                ? { status: "healthy", connsInactiveAt: null }
                : { status: "down", connsInactiveAt: now },
            )
            .where(eq(t.id, tunnelId)),
        ),
      )
      .pipe(
        Effect.asVoid,
        Effect.catch((cause) =>
          Effect.logWarning("Could not record tunnel connector status", { tunnelId, cause }),
        ),
      );

  return { tunnelClient, dnsClient, authenticate, isTunnelHostname, recordConnectorCount };
});
