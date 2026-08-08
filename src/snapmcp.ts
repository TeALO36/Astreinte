#!/usr/bin/env node
/**
 * SnapMCP — Entry Point
 *
 * Starts the MCP server over stdio using the selected chat client.
 * The desktop extension config is authoritative when this process is launched
 * by Lochor; explicit environment variables still win for standalone use.
 */

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Config } from "./config.js";
import { createSnapchatClient } from "./client/index.js";
import { createSnapMcpServer } from "./server.js";

const config = Config.load();
const configuredDriver = config.str("transport.driver").toLowerCase();
const configuredSnapchat = config.str("transport.snapchat_client").toLowerCase();
const hasTelegramCredentials =
  config.num("transport.telegram_api_id") > 0 &&
  config.str("transport.telegram_api_hash").trim().length > 0;
const configuredMode = configuredDriver === "telegram"
  ? (hasTelegramCredentials ? "telegram" : "mock")
  : configuredSnapchat || "mock";
const clientMode = process.env.SNAPCHAT_CLIENT ?? configuredMode;

const client = createSnapchatClient({
  ...process.env,
  SNAPCHAT_CLIENT: clientMode,
  SNAPCHAT_HEADLESS: process.env.SNAPCHAT_HEADLESS ?? "1",
  ADB_SERIAL: process.env.ADB_SERIAL ?? config.str("transport.adb_serial"),
  TELEGRAM_API_ID:
    process.env.TELEGRAM_API_ID ?? String(config.num("transport.telegram_api_id") || ""),
  TELEGRAM_API_HASH:
    process.env.TELEGRAM_API_HASH ?? config.str("transport.telegram_api_hash"),
  TELEGRAM_SESSION_FILE:
    process.env.TELEGRAM_SESSION_FILE ?? config.str("transport.telegram_session_file"),
});

serveStdio(() => createSnapMcpServer(client));
