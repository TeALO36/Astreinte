/**
 * SnapMCP — Web Client (Playwright)
 *
 * Real client that drives web.snapchat.com in a browser via Playwright.
 * The first run opens a visible Chromium window so the user can scan the QR
 * code. Once authenticated, storageState is saved and later runs are headless.
 */

import { chromium, type Browser, type Page } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
  WebSessionStatus,
} from "./types.js";

const WEB_URL = "https://web.snapchat.com";
const DATA_ROOT = process.env.SNAP_ASTREINTE_HOME?.trim()
  ? path.resolve(process.env.SNAP_ASTREINTE_HOME)
  : path.join(homedir(), ".snap-astreinte");
const STATE_FILE = path.join(DATA_ROOT, ".snapmcp", "state.json");

export interface WebClientConfig {
  headless?: boolean;
  stateFile?: string;
  timeoutMs?: number;
}

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
  private browserVisible = false;
  private inProgressCall: VoiceCall | null = null;

  constructor(config: WebClientConfig = {}) {
    this.headless = config.headless ?? true;
    this.stateFile = config.stateFile ?? STATE_FILE;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  private async launchPage(forceVisible = false): Promise<Page> {
    if (forceVisible && this.page && !this.page.isClosed() && !this.browserVisible) {
      await this.close();
    }
    if (this.page && !this.page.isClosed()) return this.page;

    const hasSavedSession = existsSync(this.stateFile);
    this.browserVisible = forceVisible || !hasSavedSession;
    this.browser = await chromium.launch({
      // First login and the explicit login button must show the QR window.
      headless: this.browserVisible ? false : this.headless,
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    });

    const context = await this.browser.newContext({
      permissions: ["microphone", "camera", "notifications"],
      storageState: hasSavedSession ? this.stateFile : undefined,
    });
    this.page = await context.newPage();
    await this.page.goto(WEB_URL, { waitUntil: "domcontentloaded" });
    return this.page;
  }

  private async isConnected(page: Page): Promise<boolean> {
    const url = page.url();
    if (/accounts\.snapchat\.com|\/login|\/auth/i.test(url)) return false;
    return (await page.locator(SELECTORS.chatFeed).count()) > 0;
  }

  private async status(detailWhenDisconnected: string): Promise<WebSessionStatus> {
    const page = this.page;
    const connected = page ? await this.isConnected(page) : false;
    if (connected) await this.saveSession();
    return {
      connected,
      sessionSaved: existsSync(this.stateFile),
      browserVisible: this.browserVisible,
      stateFile: this.stateFile,
      url: page?.url() ?? WEB_URL,
      detail: connected
        ? "Session Snapchat Web vérifiée. La session est enregistrée pour les prochains démarrages."
        : detailWhenDisconnected,
    };
  }

  private async ensurePage(): Promise<Page> {
    const page = await this.launchPage();
    if (!(await this.isConnected(page))) {
      throw new Error(
        "Snapchat Web attend une connexion. La fenêtre Chromium est ouverte : " +
          "scanne le QR code, puis clique sur « Vérifier la connexion ».",
      );
    }
    await this.saveSession();
    return page;
  }

  /** Open a visible browser without waiting for login. The QR code is shown in Chromium. */
  async openLogin(): Promise<WebSessionStatus> {
    const page = await this.launchPage(true);
    return this.status(
      "Chromium est ouvert sur Snapchat Web. Scanne le QR code, termine la connexion, puis clique sur « Vérifier la connexion ».",
    );
  }

  /** Verify the current browser/session and persist storageState after success. */
  async getSessionStatus(): Promise<WebSessionStatus> {
    const page = await this.launchPage();
    return this.status(
      `Connexion Snapchat Web non détectée (${page.url()}). Ouvre le bouton QR, termine la connexion, puis réessaie.`,
    );
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
    this.browserVisible = false;
  }

  private async openChat(conversationId: string): Promise<void> {
    const page = await this.ensurePage();
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

  async getConversations(limit = 20): Promise<Conversation[]> {
    const page = await this.ensurePage();
    const items = await page.locator(SELECTORS.chatFeed).all();
    const conversations: Conversation[] = [];
    for (const item of items.slice(0, limit)) {
      const name = (await item.textContent())?.trim();
      if (name) conversations.push(this.makeConversation(name, name));
    }
    await this.saveSession();
    return conversations;
  }

  async getConversation(conversationId: string): Promise<Conversation> {
    return this.makeConversation(conversationId, conversationId);
  }

  async getMessages(conversationId: string, limit = 50): Promise<Message[]> {
    await this.openChat(conversationId);
    const page = await this.ensurePage();
    const nodes = await page.locator('[data-testid="message"], [role="listitem"]').all();
    const messages: Message[] = [];
    for (const node of nodes.slice(-limit)) {
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

  async sendMessage(params: SendMessageParams): Promise<Message> {
    await this.openChat(params.conversationId);
    const page = await this.ensurePage();
    await page.locator(SELECTORS.messageInput).first().click();
    await page.keyboard.type(params.text, { delay: 25 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    await this.saveSession();
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
    const input = page.locator('input[type="file"]');
    if ((await input.count()) > 0) {
      await input.first().setInputFiles(params.mediaUrl);
      await page.waitForTimeout(1500);
      await page.keyboard.press("Enter");
    } else {
      throw new Error("Media upload input not found — selectors may need updating");
    }
    await this.saveSession();
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

  async sendVoiceNote(_params: SendVoiceNoteParams): Promise<Message> {
    throw new Error(
      "Voice notes (audio messages) are not supported on Snapchat Web. Use Snapchat Android/ADB.",
    );
  }

  async markAsRead(conversationId: string): Promise<void> {
    await this.openChat(conversationId);
  }

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
    if (!call || call.callId !== callId) throw new Error(`Call ${callId} not found`);
    return call;
  }
}
