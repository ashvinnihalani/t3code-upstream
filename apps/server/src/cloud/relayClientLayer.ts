import * as RelayClient from "@t3tools/shared/relayClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { relayTunnelConfig } from "./publicConfig.ts";

/** cloudflared for the hosted relay; nothing to install for a self-hosted relay's built-in tunnel. */
export const layerRelayClient = (options: { readonly baseDir: string }) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const tunnel = yield* relayTunnelConfig;
      return tunnel === "builtin"
        ? RelayClient.layerBuiltinTunnel
        : RelayClient.layerCloudflared({ baseDir: options.baseDir });
    }).pipe(Effect.orDie),
  );
