/**
 * SnapMCP — Web Client (Playwright)
 *
 * Real client that drives Snapchat Web (web.snapchat.com, which redirects to
 * www.snapchat.com/web) in a browser via Playwright.
 *
 * Login model (verified against the live site, 09/2026):
 *   - Snapchat blocks *anonymous* headless visits (« Navigateur non pris en
 *     charge ») but accepts headless navigation with a valid storageState.
 *   - So: one headed credential login (SNAPCHAT_EMAIL / SNAPCHAT_PASSWORD from
 *     the environment or `.env`), session persisted to disk, headless after.
 *   - When a saved session stops working, `ensurePage` automatically retries
 *     the headed credential flow once (single-flight: concurrent callers share
 *     the same recovery), then resumes headless. Captcha/2FA leave the window
 *     open for the user; without credentials the error says so truthfully.
 *
 * Manual path: `openLogin()` shows a visible Chromium window (QR or manual
 * login) when credentials are refused or absent.
 */

import { chromium, type Browser, type Locator, type Page } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
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
  WebSessionStatus,
} from "./types.js";

// Surchageable pour les tests (faux Snapchat Web local, zéro trafic réel) :
// SNAPCHAT_WEB_URL. Par défaut : le vrai site, inchangé.
const WEB_URL = process.env.SNAPCHAT_WEB_URL?.trim() || "https://web.snapchat.com";
/** Desktop Chrome récent : Snapchat rejette sinon (« Navigateur non pris en charge »). */
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

const DATA_ROOT = process.env.SNAP_ASTREINTE_HOME?.trim()
  ? path.resolve(process.env.SNAP_ASTREINTE_HOME)
  : path.join(homedir(), ".snap-astreinte");
const STATE_FILE = path.join(DATA_ROOT, ".snapmcp", "state.json");

export interface WebClientConfig {
  headless?: boolean;
  stateFile?: string;
  timeoutMs?: number;
}

/**
 * Sélecteurs vérifiés sur le site réel (fr-FR).
 * Auth : la home marketing embarque le formulaire de connexion.
 * Chat  : liste = role=listitem (titres résolus via aria-labelledby), saisie =
 * contenteditable « Envoyer un Chat ».
 */
const AUTH = {
  /** Champ e-mail/nom d'utilisateur : le seul input text sans placeholder « Rechercher ». */
  usernameInput: 'input[type="text"]:not([placeholder="Rechercher"])',
  passwordInput: 'input[name="password"]',
  passwordSubmit: '[data-testid="password-submit-button"]',
} as const;

const SUBMIT_BUTTONS = ["Connexion", "Log In", "Se connecter", "Log in"];

const CHAT = {
  chatFeed: '[role="listitem"], [data-testid="chat-feed"]',
  /**
   * Messages d'une conversation ouverte. Exclut les lignes de la liste de
   * conversations (role=listitem porteuses d'un aria-labelledby « title-* »),
   * sinon on lit les noms des contacts comme des messages.
   */
  messageNode: '[data-testid="message"], [role="listitem"]:not([aria-labelledby*="title-"])',
  messageInput: '[contenteditable="true"], textarea[placeholder*="message" i]',
  callButton: '[aria-label*="call" i], [aria-label*="appel" i]',
  hangUpButton: '[aria-label*="hang up" i], [aria-label*="raccrocher" i], [aria-label*="end call" i]',
  dismissDialog: 'button:has-text("Pas maintenant"), button:has-text("Not now")',
} as const;

export class WebSnapchatClient implements SnapchatClient {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private readonly headless: boolean;
  private readonly stateFile: string;
  private readonly timeoutMs: number;
  private browserVisible = false;
  private inProgressCall: VoiceCall | null = null;
  /** Anti-doublon : un seul lancement / une seule reconnexion à la fois. */
  private launchPromise: Promise<Page> | null = null;
  private ensurePromise: Promise<Page> | null = null;

  constructor(config: WebClientConfig = {}) {
    this.headless = config.headless ?? true;
    this.stateFile = config.stateFile ?? STATE_FILE;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  // ── Cycle de vie du navigateur ─────────────────────────────────

  private async launchPage(forceVisible = false): Promise<Page> {
    if (this.page && !this.page.isClosed()) {
      if (forceVisible && !this.browserVisible) {
        await this.close();
      } else {
        return this.page;
      }
    }
    if (!this.launchPromise) {
      this.launchPromise = this.launch(forceVisible).finally(() => {
        this.launchPromise = null;
      });
    }
    return this.launchPromise;
  }

  private async launch(forceVisible: boolean): Promise<Page> {
    const hasSavedSession = existsSync(this.stateFile);
    this.browserVisible = forceVisible || !hasSavedSession;
    this.browser = await chromium.launch({
      // Premier login et reconnexion : fenêtre visible pour le formulaire.
      headless: this.browserVisible ? false : this.headless,
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    });

    // Un state.json corrompu (écriture partielle…) ne doit pas bloquer la
    // reconnexion : on retente comme s'il n'y avait pas de session.
    let context;
    try {
      context = await this.browser.newContext({
        locale: "fr-FR",
        userAgent: DESKTOP_UA,
        permissions: ["microphone", "camera", "notifications"],
        storageState: hasSavedSession ? this.stateFile : undefined,
      });
    } catch {
      context = await this.browser.newContext({
        locale: "fr-FR",
        userAgent: DESKTOP_UA,
        permissions: ["microphone", "camera", "notifications"],
      });
    }
    this.page = await context.newPage();
    await this.page.goto(WEB_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // La redirection marketing prend quelques secondes côté site.
    await this.page.waitForTimeout(2_000);
    return this.page;
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    this.browserVisible = false;
    await browser?.close().catch(() => undefined);
  }

  private hasCredentials(): boolean {
    return Boolean(process.env.SNAPCHAT_EMAIL?.trim() && process.env.SNAPCHAT_PASSWORD);
  }

  // ── État de session ────────────────────────────────────────────

  private async isConnected(page: Page): Promise<boolean> {
    const url = page.url();
    if (/accounts\.snapchat\.com|\/login|\/auth/i.test(url)) return false;
    return (await page.locator(CHAT.chatFeed).count()) > 0;
  }

  private async status(detailWhenDisconnected: string): Promise<WebSessionStatus> {
    const page = this.page;
    const connected = page && !page.isClosed() ? await this.isConnected(page) : false;
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

  /** Persist browser session so subsequent runs skip the login. */
  async saveSession(): Promise<void> {
    if (!this.page || this.page.isClosed()) return;
    mkdirSync(path.dirname(this.stateFile), { recursive: true });
    writeFileSync(
      this.stateFile,
      JSON.stringify(await this.page.context().storageState(), null, 2),
    );
  }

  /**
   * Page connectée garantie. Une session morte ou absente déclenche UNE
   * reconnexion par identifiants (fenêtre visible, single-flight) ; en cas
   * d'échec l'erreur dit ce qui manque au lieu d'envoyer l'utilisateur vers
   * une fenêtre qui n'existe pas.
   */
  private async ensurePage(): Promise<Page> {
    if (!this.ensurePromise) {
      this.ensurePromise = this.ensureConnected().finally(() => {
        this.ensurePromise = null;
      });
    }
    return this.ensurePromise;
  }

  private async ensureConnected(): Promise<Page> {
    const page = await this.launchPage();
    if (await this.isConnected(page)) {
      await this.saveSession();
      return page;
    }

    // Session expirée (ou première utilisation) : reconnexion par identifiants.
    if (this.hasCredentials()) {
      const result = await this.openAndLogin();
      if (result.connected && this.page && !this.page.isClosed()) {
        return this.page;
      }
      await this.close();
      throw new Error(
        `Session Snapchat Web expirée et reconnexion automatique échouée (${result.url}). ` +
          "Vérifiez SNAPCHAT_EMAIL/SNAPCHAT_PASSWORD, puis relancez « npm run snapchat:login ».",
      );
    }

    await this.close();
    throw new Error(
      "Session Snapchat Web absente ou expirée, et SNAPCHAT_EMAIL/SNAPCHAT_PASSWORD ne sont pas définis " +
        "(variables d'environnement ou .env à la racine de l'extension). " +
        "Connectez-vous une fois via « npm run snapchat:login ».",
    );
  }

  // ── Connexion par identifiants ─────────────────────────────────

  /** Soumet le formulaire e-mail puis mot de passe (formulaire embarqué de la home). */
  private async submitCredentials(page: Page, email: string, password: string): Promise<void> {
    const user = page.locator(AUTH.usernameInput).first();
    await user.waitFor({ state: "visible", timeout: this.timeoutMs });
    await user.click();
    await user.fill(email);

    for (const name of SUBMIT_BUTTONS) {
      const button = page.getByRole("button", { name });
      if (await button.count()) {
        await button.first().click();
        break;
      }
    }
    await page.waitForTimeout(3_000);

    const pass = page.locator(AUTH.passwordInput).first();
    await pass.waitFor({ state: "visible", timeout: this.timeoutMs });
    await pass.fill(password);
    await page.locator(AUTH.passwordSubmit).first().click();
    // L'authentification redirige vers /web et monte l'interface.
    await page.waitForTimeout(8_000);
  }

  /** Ferme les boîtes de dialogue (notifications…) qui masquent l'interface. */
  private async dismissDialogs(page: Page): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const dismiss = page.locator(CHAT.dismissDialog).first();
      if (!(await dismiss.count())) return;
      try {
        await dismiss.click({ timeout: 3_000 });
      } catch {
        return;
      }
      await page.waitForTimeout(1_500);
    }
  }

  /**
   * Parcours d'onboarding « Bienvenue sur Snapchat pour le web » : on avance
   * bouton par bouton jusqu'à atteindre la liste de conversations.
   */
  private async completeOnboarding(page: Page): Promise<void> {
    for (let i = 0; i < 6; i++) {
      if (await this.isConnected(page)) break;
      const next = page
        .getByRole("button", { name: /^(Suivant|Next|Commencer|Get started|OK|J'ai compris|Continuer)/i })
        .first();
      if (!(await next.count())) break;
      try {
        await next.click({ timeout: 5_000 });
      } catch {
        break;
      }
      await page.waitForTimeout(3_000);
    }
  }

  /**
   * Ouvre une fenêtre visible et tente la connexion par identifiants :
   * formulaire e-mail + mot de passe (ou poursuite d'une session partielle),
   * puis onboarding, puis sauvegarde de session. Ne jette pas : renvoie
   * toujours un statut, connecté ou non (captcha, 2FA, mot de passe refusé).
   */
  private async openAndLogin(): Promise<WebSessionStatus> {
    const email = process.env.SNAPCHAT_EMAIL?.trim();
    const password = process.env.SNAPCHAT_PASSWORD;
    if (!email || !password) {
      const page = await this.launchPage(true);
      await page.waitForTimeout(6_000);
      return this.status(
        "Identifiants Snapchat absents (SNAPCHAT_EMAIL/SNAPCHAT_PASSWORD). Chromium est ouvert : " +
          "connecte-toi (QR ou à la main), puis relance « npm run snapchat:login ».",
      );
    }

    try {
      const page = await this.launchPage(true);
      await page.waitForTimeout(6_000);

      if (!(await this.isConnected(page))) {
        if (/accounts\.snapchat\.com/.test(page.url())) {
          // Déjà sur le formulaire mot de passe (session partielle) : on complète.
          const pass = page.locator(AUTH.passwordInput).first();
          if (await pass.count()) {
            await pass.fill(password);
            await page.locator(AUTH.passwordSubmit).first().click();
            await page.waitForTimeout(8_000);
          }
        } else {
          await this.submitCredentials(page, email, password);
        }
      }

      if (await this.isConnected(page)) {
        await this.dismissDialogs(page);
        await this.completeOnboarding(page);
        await this.saveSession();
        return this.status("Connexion Snapchat Web réussie avec les identifiants fournis.");
      }
    } catch {
      // Identifiants refusés ou étape inattendue : la fenêtre reste pour le QR.
    }

    return this.status(
      "La connexion automatique n'a pas abouti (captcha, 2FA ou mot de passe refusé ?). " +
        "La fenêtre Chromium reste ouverte : termine la connexion à la main, puis relance « npm run snapchat:login ».",
    );
  }

  /** Connexion automatisée par identifiants (CLI `npm run snapchat:login`). */
  async loginWithCredentials(): Promise<WebSessionStatus> {
    return this.openAndLogin();
  }

  /**
   * Ouvre une fenêtre visible sans exiger d'identifiants : si les identifiants
   * sont présents la connexion est tentée automatiquement, sinon (ou en cas de
   * refus) la fenêtre reste ouverte pour un QR code ou une saisie manuelle.
   */
  async openLogin(): Promise<WebSessionStatus> {
    const result = await this.openAndLogin();
    if (result.connected) return result;
    return {
      ...result,
      detail:
        "Connexion automatique non aboutie. La fenêtre Chromium est ouverte : scanne le QR code " +
        "ou connecte-toi, puis relance « npm run snapchat:login ».",
    };
  }

  /** Verify the current browser/session and persist storageState after success. */
  async getSessionStatus(): Promise<WebSessionStatus> {
    const page = await this.launchPage();
    if (await this.isConnected(page)) {
      await this.saveSession();
      return this.status("Session Snapchat Web vérifiée. La session est enregistrée pour les prochains démarrages.");
    }
    // Un dialogue de notifications peut masquer la liste.
    await this.dismissDialogs(page);
    if (await this.isConnected(page)) {
      await this.saveSession();
      return this.status("Session Snapchat Web vérifiée. La session est enregistrée pour les prochains démarrages.");
    }
    return this.status(
      `Connexion Snapchat Web non détectée (${page.url()}). ` +
        (this.hasCredentials()
          ? "Relancez « npm run snapchat:login » pour vous reconnecter."
          : "Ouvrez le bouton QR ou lancez « npm run snapchat:login »."),
    );
  }

  // ── Lecture des conversations ──────────────────────────────────

  /** Nom d'affichage d'une ligne : aria-labelledby → élément « title-* ». */
  private async itemTitle(item: Locator): Promise<string> {
    return item.evaluate((el: any) => {
      // Pas de lib DOM dans tsconfig : on passe par globalThis.
      const doc = (globalThis as unknown as { document?: any }).document;
      const labelled = el.querySelector("[aria-labelledby]") ?? el;
      const ids = (labelled.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
      const title = ids.map((id: string) => doc?.getElementById(id)).find((n: any) => n && /^title-/i.test(n.id));
      return title?.textContent?.trim() ?? "";
    });
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
    await this.dismissDialogs(page);

    // L'app web monte par vagues (conteneur, puis lignes, puis titres) :
    // on relit jusqu'à obtenir au moins un nom résolu (8 essais × 2 s max).
    let conversations: Conversation[] = [];
    for (let attempt = 0; attempt < 8 && conversations.length === 0; attempt++) {
      if (attempt > 0) await page.waitForTimeout(2_000);
      conversations = [];
      const seen = new Set<string>();
      const items = await page.locator(CHAT.chatFeed).all();
      for (const item of items) {
        const name = (await this.itemTitle(item)).trim();
        if (name && !seen.has(name)) {
          seen.add(name);
          conversations.push(this.makeConversation(name, name));
        }
        if (conversations.length >= limit) break;
      }
    }
    await this.saveSession();
    return conversations;
  }

  async getConversation(conversationId: string): Promise<Conversation> {
    return this.makeConversation(conversationId, conversationId);
  }

  // ── Ouverture d'une conversation ───────────────────────────────

  private async openChat(conversationId: string): Promise<void> {
    const page = await this.ensurePage();
    await this.dismissDialogs(page);
    await page.waitForTimeout(2_000);

    // Clic sur la ligne dont le titre résolu correspond exactement — le
    // premier élément de chatFeed peut être le conteneur, pas une ligne.
    for (const item of await page.locator(CHAT.chatFeed).all()) {
      if ((await this.itemTitle(item)) === conversationId) {
        await item.click({ timeout: this.timeoutMs });
        await page.waitForTimeout(1_200);
        return;
      }
    }
    // Repli : correspondance textuelle (identifiant approximatif).
    const fallback = page.locator(CHAT.chatFeed).filter({ hasText: conversationId }).first();
    if (await fallback.count()) {
      await fallback.click({ timeout: this.timeoutMs });
      await page.waitForTimeout(1_200);
      return;
    }
    throw new Error(`Conversation « ${conversationId} » introuvable à l'écran.`);
  }

  // ── Messages ───────────────────────────────────────────────────

  async getMessages(conversationId: string, limit = 50): Promise<Message[]> {
    await this.openChat(conversationId);
    const page = await this.ensurePage();
    const nodes = await page.locator(CHAT.messageNode).all();
    const messages: Message[] = [];
    const visible = nodes.slice(-limit);
    let i = 0;
    for (const node of visible) {
      const text = (await node.textContent())?.trim();
      if (text) {
        messages.push({
          id: `web_msg_${i}`,
          conversationId,
          senderId: "unknown",
          type: "text",
          text,
          timestamp: new Date().toISOString(),
          status: "opened",
          saved: true,
        });
      }
      i++;
    }
    return messages;
  }

  async sendMessage(params: SendMessageParams): Promise<Message> {
    await this.openChat(params.conversationId);
    const page = await this.ensurePage();
    await page.locator(CHAT.messageInput).first().click();
    await page.keyboard.type(params.text, { delay: 25 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
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
    if ((await input.count()) === 0) {
      throw new Error("Media upload input not found — selectors may need updating");
    }
    await input.first().setInputFiles(params.mediaUrl);
    await page.waitForTimeout(1_500);
    await page.keyboard.press("Enter");
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

  async getMedia(_params: GetMediaParams): Promise<MediaContent> {
    throw new Error(
      "Le backend Snapchat Web ne remonte pas encore les médias reçus : utilisez Telegram pour lire les images reçues.",
    );
  }

  // ── Amis ───────────────────────────────────────────────────────

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

  // ── Appels vocaux ──────────────────────────────────────────────

  async startVoiceCall(params: VoiceCallParams): Promise<VoiceCall> {
    await this.openChat(params.conversationId);
    const page = await this.ensurePage();
    await page.locator(CHAT.callButton).first().click({ timeout: this.timeoutMs });
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
    if (!this.inProgressCall || this.inProgressCall.callId !== callId) {
      throw new Error(
        this.inProgressCall
          ? `Call ${callId} inconnu (appel en cours : ${this.inProgressCall.callId}).`
          : `Aucun appel en cours : impossible de raccrocher ${callId}.`,
      );
    }
    const call = this.inProgressCall;
    const page = await this.ensurePage();
    await page.locator(CHAT.hangUpButton).first().click({ timeout: this.timeoutMs });
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
