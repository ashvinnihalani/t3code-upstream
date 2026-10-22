import { integer, pgTable, text, varchar } from "drizzle-orm/pg-core";

// Self-hosted tables live outside the drizzle migration history so the hosted
// relay's migrations stay identical to upstream. `SELF_HOSTED_SCHEMA_SQL`
// creates them idempotently at startup.

export const relaySelfHostedTunnels = pgTable("relay_selfhost_tunnels", {
  id: varchar("id", { length: 64 }).primaryKey(),
  name: text("name").notNull(),
  hostname: text("hostname"),
  originHost: text("origin_host"),
  originPort: integer("origin_port"),
  status: varchar("status", { length: 16 }).notNull().$type<"inactive" | "healthy" | "down">(),
  createdAt: varchar("created_at", { length: 64 }).notNull(),
  connsInactiveAt: varchar("conns_inactive_at", { length: 64 }),
  deletedAt: varchar("deleted_at", { length: 64 }),
});

export const relaySelfHostedSecrets = pgTable("relay_selfhost_secrets", {
  name: varchar("name", { length: 64 }).primaryKey(),
  value: text("value").notNull(),
  createdAt: varchar("created_at", { length: 64 }).notNull(),
});

export const SELF_HOSTED_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS "relay_selfhost_tunnels" (
    "id" varchar(64) PRIMARY KEY,
    "name" text NOT NULL,
    "hostname" text,
    "origin_host" text,
    "origin_port" integer,
    "status" varchar(16) NOT NULL,
    "created_at" varchar(64) NOT NULL,
    "conns_inactive_at" varchar(64),
    "deleted_at" varchar(64)
  )`,
  `CREATE INDEX IF NOT EXISTS "idx_relay_selfhost_tunnels_name" ON "relay_selfhost_tunnels" ("name")`,
  `CREATE INDEX IF NOT EXISTS "idx_relay_selfhost_tunnels_hostname" ON "relay_selfhost_tunnels" ("hostname")`,
  `CREATE TABLE IF NOT EXISTS "relay_selfhost_secrets" (
    "name" varchar(64) PRIMARY KEY,
    "value" text NOT NULL,
    "created_at" varchar(64) NOT NULL
  )`,
];
