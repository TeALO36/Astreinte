/**
 * SnapMCP — ADB Client
 *
 * Real client that drives the Snapchat Android app on a physical phone
 * via the adb CLI (USB or wireless). This is the ONLY way to send
 * **voice notes** (audio messages), because Snapchat Web does not
 * support them.
 *
 * Capabilities:
 *   ✅ Text messages (type into the chat)
 *   ✅ Voice notes (press-and-hold the mic button, then release)
 *   ✅ Voice calls (tap the call button) — requires app UI access
 *   ⚠️ Snaps (media) — requires file push + UI automation, partial
 *
 * Setup:
 *   1. Plug an Android phone (or `adb pair` + `adb connect` for Wi-Fi).
 *   2. Enable Developer Options → USB debugging on the phone.
 *   3. Open Snapchat on the phone and log in ONCE manually.
 *   4. Leave the phone unlocked with Snapchat in background.
 *
 * The client automates the UI via:
 *   - `adb shell uiautomator dump` → screen XML
 *   - `adb shell input tap/text/swipe` → interactions
 *   - accessibility labels ("Voice note", "Chat", …) when available
 *
 * NOTE: Snapchat UI labels may be localized — configure `labels` below
 * for your language (fr/en).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const exec = promisify(execFile);

const SNAPCHAT_PACKAGE = "com.snapchat.android";
const SNAPCHAT_ACTIVITY = "com.snapchat.android.LandingPageActivity";

export interface AdbClientConfig {
  /** adb serial (empty = single connected device) */
  serial?: string;
  /** Localized UI labels for Snapchat chat screen */
  labels?: {
    mic?: string;
    chat?: string;
    call?: string;
    hangUp?: string;
  };
}

export class AdbSnapchatClient implements SnapchatClient {
  private readonly serial?: string;
  private readonly labels: Required<NonNullable<AdbClientConfig["labels"]>>;
  private activeCall: VoiceCall | null = null;

  constructor(config: AdbClientConfig = {}) {
    this.serial = config.serial;
    this.labels = {
      mic: config.labels?.mic ?? "Voice note",
      chat: config.labels?.chat ?? "Chat",
      call: config.labels?.call ?? "Call",
      hangUp: config.labels?.hangUp ?? "End call",
    };
  }

  // ── adb plumbing ───────────────────────────────────────────────

  private baseArgs(): string[] {
    return this.serial ? ["-s", this.serial] : [];
  }

  /** Run an adb shell command and return trimmed stdout. */
  private async shell(command: string): Promise<string> {
    try {
      const { stdout } = await exec("adb", [...this.baseArgs(), "shell", command]);
      return stdout.trim();
    } catch (err) {
      const msg = (err as { stderr?: string; message?: string }).stderr
        ?? (err as { message?: string }).message
        ?? "adb error";
      throw new Error(`adb shell failed (${msg}). Is a device connected?`);
    }
  }

  /** Dump the current UI hierarchy as XML. */
  private async dumpUi(): Promise<string> {
    await this.shell("uiautomator dump /sdcard/ui.xml");
    return this.shell("cat /sdcard/ui.xml");
  }

  /** Find a UI element by text or content-desc; return its bounds. */
  private findElementBounds(xml: string, needle: string): { x: number; y: number } | null {
    // uiautomator dump: nodes carry text="..." content-desc="..." and bounds="[l,t][r,b]"
    const re = /<node[^>]*(?:text|content-desc)="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const [, label, l, t, r, b] = m;
      if (label && l && t && r && b && label.toLowerCase().includes(needle.toLowerCase())) {
        return { x: Math.round((+l + +r) / 2), y: Math.round((+t + +b) / 2) };
      }
    }
    return null;
  }

  private async tap(x: number, y: number): Promise<void> {
    await this.shell(`input tap ${x} ${y}`);
  }

  /** Hold a control and release it after durationMs (adb swipe is a long-press). */
  private async longPress(x: number, y: number, durationMs: number): Promise<void> {
    await this.shell(`input swipe ${x} ${y} ${x} ${y} ${durationMs}`);
  }

  private async tapByText(needle: string): Promise<void> {
    const xml = await this.dumpUi();
    const pos = this.findElementBounds(xml, needle);
    if (!pos) throw new Error(`UI element "${needle}" not found on screen`);
    await this.tap(pos.x, pos.y);
  }

  private async openApp(): Promise<void> {
    await this.shell(`am start -n ${SNAPCHAT_PACKAGE}/${SNAPCHAT_ACTIVITY}`);
    await new Promise((r) => setTimeout(r, 2500));
  }

  /** Open the chat screen with a contact by tapping the chat icon. */
  private async openChatScreen(contact: string): Promise<void> {
    await this.openApp();
    await this.tapByText(this.labels.chat);
    await new Promise((r) => setTimeout(r, 1500));
    // If the contact is not directly visible, Snapchat shows a search
    // bar — fall back to typing the name.
    try {
      await this.tapByText(contact);
    } catch {
      await this.shell(`input text ${contact.replace(/[^a-zA-Z0-9._ ]/g, "")}`);
      await new Promise((r) => setTimeout(r, 1200));
      await this.tapByText(contact);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }

  private makeConversation(id: string): Conversation {
    return {
      id,
      type: "individual",
      displayName: id,
      participants: ["me", id],
      lastActivity: new Date().toISOString(),
      unreadCount: 0,
    };
  }

  // ── Conversations ──────────────────────────────────────────────

  async getConversations(_limit = 20): Promise<Conversation[]> {
    await this.openApp();
    const xml = await this.dumpUi();
    const names = new Set<string>();
    const re = /<node[^>]*text="([^"]+)"[^>]*bounds="(\[[^\]]+\]\[[^\]]+\])"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const name = m[1]!.trim();
      if (name && name.length < 40 && !name.includes("Snap")) names.add(name);
    }
    return [...names].slice(0, _limit).map((n) => this.makeConversation(n));
  }

  async getConversation(conversationId: string): Promise<Conversation> {
    return this.makeConversation(conversationId);
  }

  async getMessages(_conversationId: string, _limit = 50): Promise<Message[]> {
    // Reading message history requires scrolling + OCR of the chat UI.
    throw new Error(
      "Reading message history via ADB requires UI scraping which is fragile. " +
        "Use the web client (SNAPCHAT_CLIENT=web) or the mock for message history.",
    );
  }

  // ── Messaging ──────────────────────────────────────────────────

  async sendMessage(params: SendMessageParams): Promise<Message> {
    await this.openChatScreen(params.conversationId);
    // Type text; adb `input text` has limited escaping, use spaces as %s.
    const escaped = params.text
      .replace(/%/g, "%s")
      .replace(/&/g, "\\&")
      .slice(0, 500);
    await this.shell(`input text "${escaped}"`);
    await this.shell("input keyevent 66"); // Enter
    await new Promise((r) => setTimeout(r, 800));
    return {
      id: `adb_msg_${Date.now()}`,
      conversationId: params.conversationId,
      senderId: "me",
      type: "text",
      text: params.text,
      timestamp: new Date().toISOString(),
      status: "sent",
      saved: params.saveInChat ?? true,
    };
  }

  /**
   * Voice note: hold the mic button for N seconds, then release to send.
   * `text` is transcript metadata and only estimates the recording window;
   * a person or an external TTS/audio setup must provide the sound to the phone.
   */
  async sendVoiceNote(params: SendVoiceNoteParams): Promise<Message> {
    if (params.audioPath) {
      throw new Error(
        "Sending a pre-recorded audio file is not supported by plain ADB: " +
          "Snapchat records from the phone microphone, while adb push only copies a file. " +
          "Use live speech or play the file through the phone speaker with a separate Android audio/TTS setup.",
      );
    }

    await this.openChatScreen(params.conversationId);
    // Find the mic button and press-and-hold.
    const xml = await this.dumpUi();
    const mic = this.findElementBounds(xml, this.labels.mic);
    if (!mic) throw new Error(`Mic button ("${this.labels.mic}") not found in chat`);
    // Estimated recording time from text length. The text is only metadata;
    // ADB cannot turn it into microphone audio by itself.
    const seconds = params.text
      ? Math.max(2, Math.round(params.text.split(/\s+/).length / 2.5))
      : 5;
    await new Promise((r) => setTimeout(r, seconds * 1000));

    // A same-coordinate swipe holds the button and releases it to send.
    await this.longPress(mic.x, mic.y, seconds * 1000);
    await new Promise((r) => setTimeout(r, 800));

    return {
      id: `adb_vn_${Date.now()}`,
      conversationId: params.conversationId,
      senderId: "me",
      type: "audio",
      text: params.text,
      duration: seconds,
      timestamp: new Date().toISOString(),
      status: "sent",
      saved: true,
    };
  }

  async sendSnap(_params: SendSnapParams): Promise<Message> {
    throw new Error(
      "Sending media snaps via ADB requires pushing files and complex UI automation " +
        "(camera screen, gallery access). Use the web client for snaps instead.",
    );
  }

  async markAsRead(_conversationId: string): Promise<void> {
    // Opening a chat marks messages as read.
    await this.openChatScreen(_conversationId);
  }

  // ── Friends ────────────────────────────────────────────────────

  async listFriends(): Promise<Friend[]> {
    const convs = await this.getConversations();
    return convs.map((c) => ({
      id: c.id,
      displayName: c.id,
      username: c.id,
      status: "connected" as const,
      hasStory: false,
      lastActive: new Date().toISOString(),
    }));
  }

  async getFriend(friendId: string): Promise<Friend> {
    const f = (await this.listFriends()).find((x) => x.id === friendId);
    if (!f) throw new Error(`Friend ${friendId} not found`);
    return f;
  }

  // ── Voice calls ────────────────────────────────────────────────

  async startVoiceCall(params: VoiceCallParams): Promise<VoiceCall> {
    await this.openChatScreen(params.conversationId);
    await this.tapByText(this.labels.call);
    this.activeCall = {
      callId: `adb_call_${Date.now()}`,
      conversationId: params.conversationId,
      participants: ["me", params.conversationId],
      state: "ringing_outgoing",
      startedAt: new Date().toISOString(),
      outgoing: true,
    };
    return this.activeCall;
  }

  async endVoiceCall(callId: string): Promise<VoiceCall> {
    const call = this.activeCall ?? {
      callId,
      conversationId: "unknown",
      participants: [],
      state: "in_progress" as const,
      outgoing: true,
    };
    await this.tapByText(this.labels.hangUp);
    call.state = "ended";
    call.endedAt = new Date().toISOString();
    call.endReason = "hung_up";
    this.activeCall = null;
    return call;
  }

  async getActiveCall(): Promise<VoiceCall | null> {
    return this.activeCall;
  }

  async getCallStatus(callId: string): Promise<VoiceCall> {
    const call = this.activeCall;
    if (!call || call.callId !== callId) throw new Error(`Call ${callId} not found`);
    return call;
  }
}
