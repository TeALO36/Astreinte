/** Choix du driver à partir de la configuration. */
import type { Config } from "../config.js";
import { BridgeTransport } from "./bridge.js";
import { TelegramTransport } from "./telegram.js";
import { TransportError, type Transport } from "./types.js";
export { BridgeTransport, TelegramTransport, TransportError };
export type { Transport } from "./types.js";
export declare function createTransport(cfg: Config): Transport;
