/**
 * SnapMCP — Web Client (Playwright)
 *
 * Real client that drives web.snapchat.com in a browser via Playwright.
 * Capabilities on Snapchat Web:
 *   ✅ Text messages, snaps (photo/video), media upload
 *   ✅ Voice & video CALLS (phone / video icon in chat) — where available
 *   ❌ Voice NOTES (audio messages) — NOT supported by Snapchat Web
 *
 * Setup:
 *   1. `npx playwright install chromium`
 *   2. First run: the client opens a headed browser — scan the QR code
 *      with Snapchat to log in. The session is saved to .snapmcp/state.json
 *      and reused afterwards (run headless after first login).
 *
 * NOTE: selectors for web.snapchat.com change often — if a selector
 * breaks, update it below and keep this file as the single place for
 * DOM integration.
 */

import { chromium, type Browser, type Page } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  Conversation,
  Message,
  Friend,
  VoiceCall,
  SnapchatClient,
  SendMessageParams,
  SendSnapParams,
  SendVoiceNoteParams,
  VoiceCallParams,
} from "./types.js";

const WEB_URL = "https://web.snapchat.com";
const STATE_DIR = path.join(process.cwd(), ".snapmcp");
const STATE_FILE = path.join(STATE_DIR, "state.json");

export interface WebClientConfig {
  headless?: boolean;
  stateFile?: string;
  /** Timeout for page interactions in ms */
  timeoutMs?: number;
}

/**
 * Selectors — maintain these when Snapchat changes its web UI.
 * Text-based selectors are used where possible to reduce breakage.
 */
const SELECTORS = {
  chatFeed: '[role="listitem"], [data-testid="chat-feed"]',
  messageInput: '[contenteditable="true"], textarea[placeholder*="message" i]',
  callButton: '[aria-label*="call" i], [aria-label*="appel" i]',
  hangUpButton: '[aria-label*="hang up" i], [aria-label*="racrocher" i], [aria-label*="end call" i]',
  sendButton: '[aria-label*="send" i], button[data-testid="send"]',
} as const;

export class WebSnapchatClient implements SnapchatClient {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private readonly headless: boolean;
  private readonly stateFile: string;
  private readonly timeoutMs: number;
  private inProgressCall: VoiceCall | null = null;

  constructor(config: WebClientConfig = {}) {
    this.headless = config.headless ?? true;
    this.stateFile = config.stateFile ?? STATE_FILE;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  /**
   * Launch the browser, load the saved session (if any), and open
   * web.snapchat.com. If not logged in, throws with login instructions.
   */
  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;

    this.browser = await chromium.launch({
      headless: this.headless,
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    });

    const context = await this.browser.newContext({
      permissions: ["microphone", "camera", "notifications"],
      storageState: existsSync(this.stateFile) ? this.stateFile : undefined,
    });
    this.page = await context.newPage();
    await this.page.goto(WEB_URL, { waitUntil: "domcontentloaded" });

    // Wait for either the chat feed (logged in) or the login screen
    try {
      await this.page.waitForSelector('[role="listitem"], [aria-label="chat"]', {
        timeout: 15_000,
      });
    } catch {
      await this.saveSession();
      throw new Error(
        "Not logged in. Run once with headless:false (SNAPCHAT_HEADLESS=0), " +
          "scan the QR code on web.snapchat.com, and re-run.",
      );
    }
    return this.page;
  }

  /** Persist browser session so subsequent runs skip the QR login. */
  async saveSession(): Promise<void> {
    if (!this.page) return;
    mkdirSync(path.dirname(this.stateFile), { recursive: true });
    writeFileSync(
      this.stateFile,
      JSON.stringify(await this.page.context().storageState(), null, 2),
    );
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
    this.page = null;
  }

  // ── Helpers ────────────────────────────────────────────────────

  /** Open the chat with the given conversation (by name). */
  private async openChat(conversationId: string): Promise<void> {
    const page = await this.ensurePage();
    // Conversations are listed in the left sidebar; click by visible name.
    // conversationId for the web client is the friend/group display name.
    await page.getByText(conversationId, { exact: false }).first().click({
      timeout: this.timeoutMs,
    });
    await page.waitForTimeout(800);
  }

  private makeConversation(name: string, id: string): Conversation {
    return {
      id,
      type: "individual",
      displayName: name,
      participants: ["me", name],
      lastActivity: new Date().toISOString(),
      unreadCount: 0,
    };
  }

  // ── Conversations ──────────────────────────────────────────────

  async getConversations(_limit = 20): Promise<Conversation[]> {
    const page = await this.ensurePage();
    const items = await page.locator(SELECTORS.chatFeed).all();
    const conversations: Conversation[] = [];
    for (const item of items.slice(0, _limit)) {
      const name = (await item.textContent())?.trim();
      if (name) conversations.push(this.makeConversation(name, name));
    }
    return conversations;
  }

  async getConversation(conversationId: string): Promise<Conversation> {
    return this.makeConversation(conversationId, conversationId);
  }

  async getMessages(conversationId: string, _limit = 50): Promise<Message[]> {
    await this.openChat(conversationId);
    const page = await this.ensurePage();
    const nodes = await page.locator('[data-testid="message"], [role="listitem"]').all();
    const messages: Message[] = [];
    for (const node of nodes.slice(-_limit)) {
      const text = (await node.textContent())?.trim();
      if (text) {
        messages.push({
          id: `web_msg_${messages.length}`,
          conversationId,
          senderId: "unknown",
          type: "text",
          text,
          timestamp: new Date().toISOString(),
          status: "opened",
          saved: true,
        });
      }
    }
    return messages;
  }

  // ── Messaging ──────────────────────────────────────────────────

  async sendMessage(params: SendMessageParams): Promise<Message> {
    await this.openChat(params.conversationId);
    const page = await this.ensurePage();
    await page.locator(SELECTORS.messageInput).first().click();
    await page.keyboard.type(params.text, { delay: 25 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    return {
      id: `web_msg_${Date.now()}`,
      conversationId: params.conversationId,
      senderId: "me",
      type: "text",
      text: params.text,
      timestamp: new Date().toISOString(),
      status: "sent",
      saved: params.saveInChat ?? true,
    };
  }

  async sendSnap(params: SendSnapParams): Promise<Message> {
    await this.openChat(params.conversationId);
    const page = await this.ensurePage();
    // Snapchat Web accepts image uploads via drag & drop onto the chat.
    const input = page.locator('input[type="file"]');
    if ((await input.count()) > 0) {
      await input.first().setInputFiles(params.mediaUrl);
      await page.waitForTimeout(1500);
      await page.keyboard.press("Enter");
    } else {
      throw new Error("Media upload input not found — selectors may need updating");
    }
    return {
      id: `web_snap_${Date.now()}`,
      conversationId: params.conversationId,
      senderId: "me",
      type: params.type,
      mediaUrl: params.mediaUrl,
      duration: params.duration,
      text: params.caption,
      timestamp: new Date().toISOString(),
      status: "sent",
      saved: false,
    };
  }

  /** Voice notes are NOT supported on Snapchat Web — always throws. */
  async sendVoiceNote(_params: SendVoiceNoteParams): Promise<Message> {
    throw new Error(
      "Voice notes (audio messages) are not supported on Snapchat Web. " +
        "Use the ADB client (SNAPCHAT_CLIENT=adb) with an Android phone to send voice notes.",
    );
  }

  async markAsRead(_conversationId: string): Promise<void> {
    // Opening the chat marks it as read in the web UI.
    await this.openChat(_conversationId);
  }

  // ── Friends ────────────────────────────────────────────────────

  async listFriends(): Promise<Friend[]> {
    const conversations = await this.getConversations();
    return conversations.map((c) => ({
      id: c.id,
      displayName: c.displayName,
      username: c.id,
      status: "connected" as const,
      hasStory: false,
      lastActive: new Date().toISOString(),
    }));
  }

  async getFriend(friendId: string): Promise<Friend> {
    const friend = (await this.listFriends()).find((f) => f.id === friendId);
    if (!friend) throw new Error(`Friend ${friendId} not found`);
    return friend;
  }

  // ── Voice Calls (live calls on web) ────────────────────────────

  async startVoiceCall(params: VoiceCallParams): Promise<VoiceCall> {
    await this.openChat(params.conversationId);
    const page = await this.ensurePage();
    await page.locator(SELECTORS.callButton).first().click({ timeout: this.timeoutMs });
    this.inProgressCall = {
      callId: `web_call_${Date.now()}`,
      conversationId: params.conversationId,
      participants: ["me", params.conversationId],
      state: "ringing_outgoing",
      startedAt: new Date().toISOString(),
      outgoing: true,
    };
    return this.inProgressCall;
  }

  async endVoiceCall(callId: string): Promise<VoiceCall> {
    const page = await this.ensurePage();
    const call = this.inProgressCall ?? {
      callId,
      conversationId: "unknown",
      participants: [],
      state: "in_progress" as const,
      outgoing: true,
    };
    await page.locator(SELECTORS.hangUpButton).first().click({ timeout: this.timeoutMs });
    call.state = "ended";
    call.endedAt = new Date().toISOString();
    call.endReason = "hung_up";
    this.inProgressCall = null;
    return call;
  }

  async getActiveCall(): Promise<VoiceCall | null> {
    return this.inProgressCall;
  }

  async getCallStatus(callId: string): Promise<VoiceCall> {
    const call = this.inProgressCall;
    if (!call || call.callId !== callId) {
      throw new Error(`Call ${callId} not found`);
    }
    return call;
  }
}
