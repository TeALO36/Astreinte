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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  Conversation,
  Message,
  Friend,
  GetMediaParams,
  MediaContent,
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
  /** Chemin explicite d'adb ; par défaut ANDROID_HOME/platform-tools/adb, sinon PATH */
  adbPath?: string;
  /** Localized UI labels for Snapchat chat screen */
  labels?: {
    mic?: string;
    chat?: string;
    call?: string;
    hangUp?: string;
  };
}

/**
 * Ressources vérifiées sur l'app réelle (v14.22, 09/2026) — les ids de l'écran
 * de connexion sont stables, ceux du reste de l'app sont obfusqués.
 */
const SNAP_IDS = {
  welcomeLoginButton: "com.snapchat.android:id/login_text",
  usernameField: "com.snapchat.android:id/username_or_email_field",
  passwordField: "com.snapchat.android:id/password_field",
  submitButton: "com.snapchat.android:id/nav_button",
} as const;

export class AdbSnapchatClient implements SnapchatClient {
  private readonly serial?: string;
  private readonly adbPath: string;
  private readonly labels: Required<NonNullable<AdbClientConfig["labels"]>>;
  private activeCall: VoiceCall | null = null;

  constructor(config: AdbClientConfig = {}) {
    this.serial = config.serial;
    // adb n'est pas toujours dans le PATH (constaté sur Windows) : on essaie
    // ANDROID_HOME/platform-tools d'abord.
    const home = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
    const sdkAdb = home ? join(home, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb") : null;
    this.adbPath = config.adbPath ?? (sdkAdb && existsSync(sdkAdb) ? sdkAdb : "adb");
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
      const { stdout } = await exec(this.adbPath, [...this.baseArgs(), "shell", command]);
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

  /** Trouve un élément par resource-id exact (fiable quand l'obfuscation ne touche pas l'id). */
  private findElementByResourceId(xml: string, resourceId: string): { x: number; y: number } | null {
    const re = /<node[^>]*resource-id="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const [, id, l, t, r, b] = m;
      if (id === resourceId && l && t && r && b) {
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

  /** Tap by exact resource-id (verified-stable ids like the login screen). */
  private async tapByResourceId(resourceId: string): Promise<void> {
    const xml = await this.dumpUi();
    const pos = this.findElementByResourceId(xml, resourceId);
    if (!pos) throw new Error(`UI resource "${resourceId}" not found on screen`);
    await this.tap(pos.x, pos.y);
  }

  /** Masque le clavier virtuel qui couvre les boutons du bas de l'écran. */
  private async hideKeyboard(): Promise<void> {
    await this.shell("input keyevent 111"); // KEYCODE_ESCAPE : ferme l'IME sans quitter l'app
    await new Promise((r) => setTimeout(r, 1200));
  }

  private async openApp(): Promise<void> {
    // monkey LAUNCHER est plus robuste que am start : l'activité d'entrée
    // a changé plusieurs fois (vérifié : LoginSignupActivity puis Landing).
    await this.shell(`monkey -p ${SNAPCHAT_PACKAGE} -c android.intent.category.LAUNCHER 1`);
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

  /**
   * Connexion Snapchat Android par identifiants (SNAPCHAT_USERNAME / EMAIL +
   * PASSWORD de l'environnement ou du .env). Parcours vérifié sur l'app réelle :
   * écran d'accueil → « Log In » → formulaire (ids stables) → clavier masqué
   * → « Log In ». NE PAS répéter les tentatives : un refus silencieux est
   * typique du pare-feu anti-émulateur, et chaque essai abîme la réputation
   * du compte. Un login réussi affiche la boîte « Save password? » (Not now).
   */
  async login(): Promise<{ loggedIn: boolean; detail: string }> {
    await this.openApp();
    await new Promise((r) => setTimeout(r, 6000));

    // Écran d'accueil : bouton « Log In » (texte du lien sous le bouton jaune).
    try {
      await this.tapByResourceId(SNAP_IDS.welcomeLoginButton);
    } catch {
      // Déjà connecté ou écran différent : on continue.
    }
    await new Promise((r) => setTimeout(r, 5000));

    const username = process.env.SNAPCHAT_USERNAME?.trim() || process.env.SNAPCHAT_EMAIL?.trim();
    const password = process.env.SNAPCHAT_PASSWORD;
    if (!username || !password) {
      return { loggedIn: false, detail: "SNAPCHAT_USERNAME/EMAIL ou SNAPCHAT_PASSWORD absent de l'environnement ou du .env." };
    }

    await this.tapByResourceId(SNAP_IDS.usernameField);
    await new Promise((r) => setTimeout(r, 1500));
    await this.shell(`input text ${username.replace(/[^a-zA-Z0-9.@_+-]/g, "")}`);
    await new Promise((r) => setTimeout(r, 1000));
    await this.tapByResourceId(SNAP_IDS.passwordField);
    await new Promise((r) => setTimeout(r, 1500));
    await this.shell(`input text ${password.replace(/[^a-zA-Z0-9@#%+=_-]/g, "")}`);
    await new Promise((r) => setTimeout(r, 1000));
    await this.hideKeyboard();
    await this.tapByResourceId(SNAP_IDS.submitButton);

    // L'authentification peut prendre plus d'une minute côté serveur.
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 10_000));
      const xml = await this.dumpUi();
      if (this.findElementByResourceId(xml, SNAP_IDS.usernameField)) continue; // toujours le formulaire
      if (/Save password|Not now/i.test(xml)) {
        await this.tapByText("Not now").catch(() => undefined);
      }
      // Formulaire disparu : soit connecté, soit écran intermédiaire.
      await new Promise((r) => setTimeout(r, 5000));
      return { loggedIn: true, detail: "Formulaire de connexion quitté : session en cours d'ouverture (vérifiez l'écran du device)." };
    }
    return {
      loggedIn: false,
      detail: "Le formulaire reste affiché sans message d'erreur : refus silencieux probable (émulateur signalé, ou identifiants). Une seule tentative par session — n'insistez pas.",
    };
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

    // Start the long press immediately: the phone microphone records during
    // this swipe, and the release at its end sends the note.
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

  async getMedia(_params: GetMediaParams): Promise<MediaContent> {
    throw new Error(
      "Le backend ADB ne remonte pas encore les médias reçus : utilisez Telegram pour lire les images reçues.",
    );
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
