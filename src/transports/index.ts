/** Choix du driver à partir de la configuration. */

import type { Config } from "../config.js";
import { BridgeTransport } from "./bridge.js";
import { ClientTransport } from "./client-adapter.js";
import { createSnapchatTransport } from "./snapchat.js";
import { TelegramTransport } from "./telegram.js";
import { TransportError, type Transport } from "./types.js";

export { BridgeTransport, ClientTransport, TelegramTransport, TransportError };
export type { Transport } from "./types.js";

/**
 * Ce que chaque backend Snapchat sait faire. Le vocal n'est pas devinable à
 * l'exécution : mieux vaut le déclarer et laisser le démon replier vers le
 * texte que de tenter un envoi qui échouera à chaque message.
 */
const SNAPCHAT_BACKENDS: Record<string, { voice: boolean; images: boolean; note: string }> = {
  adb: { voice: true, images: true, note: "téléphone Android via adb" },
  web: {
    voice: false,
    images: false,
    note: "web.snapchat.com via Playwright — pas de note vocale ni de photo envoyée",
  },
  mock: { voice: true, images: true, note: "client factice, aucun envoi réel" },
};

/**
 * Construit le canal. Asynchrone parce que les clients Snapchat sont chargés à
 * la demande : le démon Telegram n'a aucune raison de tirer Playwright en
 * mémoire au démarrage.
 */
export async function createTransport(cfg: Config): Promise<Transport> {
  const driver = cfg.str("transport.driver") || "telegram";

  switch (driver) {
    case "telegram":
      return new TelegramTransport({
        apiId: cfg.num("transport.telegram_api_id") || undefined,
        apiHash: cfg.str("transport.telegram_api_hash") || undefined,
        sessionFile: cfg.str("transport.telegram_session_file") || undefined,
        authType: (cfg.str("transport.telegram_auth") === "bot" ? "bot" : "account") as "account" | "bot",
        botToken: cfg.str("transport.telegram_bot_token") || undefined,
      });

    case "snapchat": {
      const backend = (cfg.str("transport.snapchat_client") || "adb").toLowerCase();

      // Un pont HTTP externe reste possible : c'est la voie pour un client
      // écrit dans un autre langage, hors de ce dépôt.
      if (backend === "bridge") {
        return createSnapchatTransport({
          baseUrl: cfg.str("transport.bridge_url"),
          token: cfg.str("transport.bridge_token") || undefined,
        });
      }

      const spec = SNAPCHAT_BACKENDS[backend];
      if (!spec) {
        throw new TransportError(
          `backend Snapchat « ${backend} » inconnu. Valeurs acceptées : ${Object.keys(
            SNAPCHAT_BACKENDS,
          ).join(", ")}, bridge.`,
        );
      }

      const { createSnapchatClient } = await import("../client/index.js");
      const client = createSnapchatClient({
        ...process.env,
        SNAPCHAT_CLIENT: backend,
        ADB_SERIAL: cfg.str("transport.adb_serial") || process.env.ADB_SERIAL,
      });

      return new ClientTransport({
        client,
        label: `snapchat:${backend}`,
        voice: spec.voice,
        images: spec.images,
        pollIntervalMs: cfg.num("transport.poll_interval_ms") || 3000,
      });
    }

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
