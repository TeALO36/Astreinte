import type { SnapchatClient } from "./types.js";
import { MockSnapchatClient } from "./mock-client.js";
import { WebSnapchatClient } from "./web-client.js";
import { AdbSnapchatClient } from "./adb-client.js";
import { TelegramSnapchatClient } from "./telegram-client.js";

export type { SnapchatClient } from "./types.js";
export { MockSnapchatClient } from "./mock-client.js";
export { WebSnapchatClient } from "./web-client.js";
export { AdbSnapchatClient } from "./adb-client.js";
export { TelegramSnapchatClient } from "./telegram-client.js";

/**
 * Create the Snapchat client selected by the SNAPCHAT_CLIENT env var.
 *
 *   SNAPCHAT_CLIENT=mock   → in-memory mock (default, no setup)
 *   SNAPCHAT_CLIENT=web    → Playwright on web.snapchat.com (messages,
 *                            snaps, live calls — NOT voice notes)
 *   SNAPCHAT_CLIENT=adb      → Android phone via adb (messages + voice notes)
 *   SNAPCHAT_CLIENT=telegram → Telegram personal account via MTProto (messages + audio voice notes)
 */
export function createSnapchatClient(
  env: Record<string, string | undefined> = process.env,
): SnapchatClient {
  const mode = (env.SNAPCHAT_CLIENT ?? "mock").toLowerCase();
  switch (mode) {
    case "web":
      // SNAPCHAT_HEADLESS=0 → headed browser (first run: scan the QR code).
      // Unset or 1 → headless (after the session is saved).
      return new WebSnapchatClient({
        headless: env.SNAPCHAT_HEADLESS !== "0",
        stateFile: env.SNAPCHAT_STATE_FILE,
      });
    case "adb":
      return new AdbSnapchatClient({ serial: env.ADB_SERIAL });
    case "telegram":
      return new TelegramSnapchatClient({
        apiId: env.TELEGRAM_API_ID ? Number(env.TELEGRAM_API_ID) : undefined,
        apiHash: env.TELEGRAM_API_HASH,
        sessionString: env.TELEGRAM_SESSION_STRING,
        sessionFile: env.TELEGRAM_SESSION_FILE,
      });
    case "mock":
    default:
      return new MockSnapchatClient();
  }
}
