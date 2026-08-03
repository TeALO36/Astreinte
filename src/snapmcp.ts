#!/usr/bin/env node
/**
 * SnapMCP — Entry Point
 *
 * Starts the MCP server over stdio using the selected chat client.
 * Select Snapchat, Telegram, or the mock backend with SNAPCHAT_CLIENT.
 */

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createSnapchatClient } from "./client/index.js";
import { createSnapMcpServer } from "./server.js";

// Select client via SNAPCHAT_CLIENT env var (mock | web | adb | telegram).
const client = createSnapchatClient();

serveStdio(() => createSnapMcpServer(client));
