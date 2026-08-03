/** Choix du driver à partir de la configuration. */

import type { Config } from "../config.js";
import { BridgeTransport } from "./bridge.js";
import { createSnapchatTransport } from "./snapchat.js";
import { TelegramTransport } from "./telegram.js";
import { TransportError, type Transport } from "./types.js";

export { BridgeTransport, TelegramTransport, TransportError };
export type { Transport } from "./types.js";

export function createTransport(cfg: Config): Transport {
  const driver = cfg.str("transport.driver") || "telegram";

  switch (driver) {
    case "telegram":
      return new TelegramTransport(
        cfg.str("transport.telegram_token"),
        cfg.num("transport.poll_interval_ms") || 2000,
      );

    case "snapchat":
      return createSnapchatTransport({
        baseUrl: cfg.str("transport.bridge_url"),
        token: cfg.str("transport.bridge_token") || undefined,
      });

    case "bridge":
      return new BridgeTransport({
        baseUrl: cfg.str("transport.bridge_url"),
        token: cfg.str("transport.bridge_token") || undefined,
      });

    default:
      throw new TransportError(
        `canal « ${driver} » inconnu. Valeurs acceptées : telegram, snapchat, bridge.`,
      );
  }
}
