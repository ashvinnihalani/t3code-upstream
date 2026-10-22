# Self-hosted T3 Connect

Runs T3 Connect on your own server instead of Cloudflare. Use it when the hosted service doesn't
fit: more linked machines than its per-account limit, or networks that block `cloudflared` and
Tailscale but allow ordinary outbound HTTPS.

The self-hosted relay runs the same relay services on Node and Postgres. Its built-in tunnel
replaces Cloudflare Tunnel: each environment holds one outbound WebSocket to
`wss://<relay>/v1/tunnel/connect` and honors `HTTPS_PROXY`/`NO_PROXY`. Phones and browsers reach
the environment at `https://<label>.<tunnel domain>`, and Caddy terminates TLS for those names.

Your own relay means your own client builds. Clients embed the relay URL and Clerk keys, and push
notifications are signed with your Apple key, so they reach only an iOS app with your bundle ID.

## What you need

- A server with a public IP, Docker, and ports 80 and 443 open.
- A domain whose DNS you control.
- A [Clerk](https://clerk.com) application for sign-in. The free tier is enough.
- For iOS push: a paid Apple Developer Program membership and a Mac with Xcode.
- For Android push (optional): a Firebase project.

## 1. DNS

Point both names at the server:

| Record                    | Example                 |
| ------------------------- | ----------------------- |
| Relay API                 | `relay.example.com`     |
| Tunnels (wildcard)        | `*.tunnels.example.com` |
| Hosted web app (optional) | `app.example.com`       |

Caddy issues a certificate for each tunnel hostname the first time it's used, and only for
hostnames the relay has assigned. Let's Encrypt allows 50 new certificates per registered domain
per week.

## 2. Clerk

Follow [T3 Connect setup](./connect-setup.md) for your Clerk instance: the `t3-relay` JWT
template, the CLI OAuth application, desktop OAuth redirects, and sign-up restrictions. Restrict
sign-ups to yourself; anyone who can sign in can link environments to your relay.

## 3. Apple push key and bundle ID

In the Apple Developer portal:

1. Register an App ID such as `com.example.t3code` with Push Notifications, App Groups, Associated
   Domains, and Sign in with Apple. Register `.widgets` and `.sharing` App IDs under it, and the
   App Group `group.com.example.t3code`.
2. Under Keys, create a key with Apple Push Notifications service enabled. Download the `.p8`
   file and note its Key ID and your Team ID.

## 4. Start the relay

On the server, in a checkout of this repository:

```sh
cd infra/relay/selfhost
cp .env.example .env   # fill in domains, Clerk, and APNs values
docker compose up -d --build
docker compose logs -f relay   # wait for "Self-hosted T3 Connect relay ready"
```

Set `APNS_ENVIRONMENT=sandbox` for an app installed from Xcode in Debug, and `production` for
Release, TestFlight, or ad hoc builds. The relay creates its signing keys in Postgres on first
start, so back up the `postgres` volume. Losing it unlinks every environment.

`RELAY_TUNNEL_LIMIT` sets how many environments each account can link (default 100).

## 5. Build the clients

Set these in the repository-root `.env` on the machine that builds the clients:

```dotenv
T3CODE_RELAY_URL=https://relay.example.com
T3CODE_RELAY_TUNNEL=builtin
T3CODE_CLERK_PUBLISHABLE_KEY=pk_live_...
T3CODE_CLERK_JWT_TEMPLATE=t3-relay
T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=...
T3CODE_HOSTED_APP_URL=https://app.example.com
```

`T3CODE_RELAY_TUNNEL=builtin` stops the server from installing `cloudflared`. A server built
without it also accepts the same value as a runtime environment variable.

- **Desktop and CLI**: build them as usual ([release runbook](./release.md)) and install the result
  on each machine you want to reach.
- **Hosted web app**: needed only for `t3 connect login` in a browser. Build `apps/web`, then set
  `APP_DOMAIN` and `WEB_APP_DIR` in `infra/relay/selfhost/.env`.
- **iOS**: build with your bundle ID and team, then install from Xcode or distribute through
  TestFlight:

  ```sh
  T3CODE_IOS_BUNDLE_ID=com.example.t3code \
  T3CODE_APPLE_TEAM_ID=ABCDE12345 \
  vp run --filter @t3tools/mobile ios:release
  ```

  `APNS_BUNDLE_ID` on the relay must match `T3CODE_IOS_BUNDLE_ID`.

## 6. Link environments

On each machine, sign in and link it as usual, from **Settings → Connections** in the desktop app
or with `t3 connect`. The environment connects out to the relay and appears on your phone after
you sign in there. If the machine reaches the internet through a proxy, set `HTTPS_PROXY` for the
T3 Code process.

## Not yet supported

- Holding webhooks while an environment is offline. Webhooks still forward while it's online.
- Hosted tracing. The relay logs to stdout.

## Troubleshooting

- `docker compose logs relay` shows tunnel connects and disconnects per environment.
- `curl https://relay.example.com/health` should return `{"ok":true,...}`.
- An environment that shows offline: check that the machine can open
  `wss://relay.example.com/v1/tunnel/connect` through its network, and that `t3 connect status`
  reports the built-in relay client.
