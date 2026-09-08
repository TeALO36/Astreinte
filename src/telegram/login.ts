/**
 * Connexion Telegram — QR code (compte personnel) et jeton de bot.
 *
 * Trois consommateurs partagent ce module : la CLI (`telegram-login.mjs`),
 * le banc de test (`test-bench-app.mjs`) et le serveur MCP de supervision
 * (`mcp.ts`), pour que « se connecter » se fasse de la même façon partout.
 *
 * Le parcours QR est interactif : le jeton change toutes les ~30 secondes,
 * et un compte avec 2FA demande un mot de passe en cours de route. La classe
 * `QrLoginFlow` garde l'état (phase, lien, mot de passe en attente) et permet
 * à l'appelant de suivre ou de piloter le parcours — le MCP expose l'état via
 * un outil, la CLI affiche le lien dans le terminal, le banc le dessine.
 */

import QRCode from "qrcode";
import { TelegramClient, sessions } from "telegram";
import { saveSessionString } from "./session.js";

const { StringSession } = sessions;

/** Payload du QR : lien profond pour le téléphone, lien web de repli. */
export interface QrPayload {
  /** `tg://login?token=...` — ce que Telegram scanne. */
  url: string;
  /** `https://t.me/login/...` — ouvrable sur le téléphone pour confirmer. */
  webUrl: string;
  token: string;
}

export type LoginPhase = "waiting" | "password" | "done" | "error";

export interface LoginStatus {
  phase: LoginPhase;
  webUrl?: string;
  /** QR en PNG (data URL), quand un générateur est disponible. */
  qrDataUrl?: string;
  passwordHint?: string;
  user?: string;
  savedTo?: string;
  error?: string;
}

/** Convertit le jeton binaire de GramJS en liens standard de Telegram. */
export function qrPayload(token: Buffer | Uint8Array): QrPayload {
  const base64url = Buffer.from(token).toString("base64url");
  return {
    url: `tg://login?token=${base64url}`,
    webUrl: `https://t.me/login/${base64url}`,
    token: base64url,
  };
}

/** Petit nom lisible pour un compte ou un bot. */
export function displayName(user: unknown): string {
  const u = user as {
    username?: string;
    firstName?: string;
    lastName?: string;
  } | null;
  if (!u) return "compte Telegram";
  if (u.username) return `@${u.username}`;
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ");
  return full || "compte Telegram";
}

/**
 * Le sous-ensemble de GramJS utilisé ici, pour pouvoir injecter un faux
 * client dans les tests.
 */
export interface TelegramLoginClient {
  connect(): Promise<unknown>;
  signInUserWithQrCode(
    credentials: { apiId: number; apiHash: string },
    params: {
      qrCode?: (qr: { token: Buffer; expires: number }) => Promise<void>;
      password?: (hint?: string) => Promise<string>;
      onError: (err: Error) => Promise<boolean> | void;
    },
  ): Promise<unknown>;
  signInBot(
    credentials: { apiId: number; apiHash: string },
    authParams: { botAuthToken: string | (() => string) },
  ): Promise<unknown>;
  getMe(): Promise<unknown>;
  session: { save(): unknown };
  disconnect(): Promise<unknown>;
}

function realClient(apiId: number, apiHash: string): TelegramLoginClient {
  return new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });
}

async function qrToDataUrl(url: string): Promise<string> {
  return QRCode.toDataURL(url, { width: 240, margin: 1 });
}

export interface QrLoginOptions {
  /** Où écrire la session une fois la connexion acceptée. */
  sessionFile: string;
  /** Appelé à chaque nouveau jeton QR (~30 s). */
  onQr?: (payload: QrPayload) => void | Promise<void>;
  /** Appelé sur une erreur non fatale pendant le parcours. */
  onError?: (message: string) => void;
  /**
   * Fourni par la CLI : le mot de passe est demandé en direct. Absent côté
   * MCP : la phase passe à « password » et `submitPassword` le fournit.
   */
  password?: (hint: string) => Promise<string> | string;
  /** Pour les tests. */
  clientFactory?: (apiId: number, apiHash: string) => TelegramLoginClient;
  /** Pour les tests (évite la dépendance au rendu QR). */
  qrToDataUrl?: (url: string) => Promise<string>;
}

/** Un parcours de connexion par QR code, suivi par l'appelant. */
export class QrLoginFlow {
  private state: LoginStatus = { phase: "waiting" };
  private passwordResolver: ((p: string) => void) | null = null;
  private client: TelegramLoginClient | null = null;
  private finished = false;
  private firstQrResolve: ((p: QrPayload) => void) | null = null;

  /** Se résout dès que le premier QR est disponible. */
  readonly firstQr: Promise<QrPayload> = new Promise((resolve) => {
    this.firstQrResolve = resolve;
  });

  constructor(private opts: QrLoginOptions) {}

  get status(): LoginStatus {
    return { ...this.state };
  }

  /**
   * Lance le parcours en arrière-plan. Ne bloque pas sur le scan et ne
   * rejette jamais : tout échec (constructeur, connexion, authentification)
   * finit en phase « error » pour que l'appelant qui fait juste `void
   * begin(...)` voie l'erreur dans `status` au lieu d'une promesse rejetée
   * hors de son contrôle.
   */
  async begin(apiId: number, apiHash: string): Promise<void> {
    let client: TelegramLoginClient;
    try {
      client = this.opts.clientFactory
        ? this.opts.clientFactory(apiId, apiHash)
        : realClient(apiId, apiHash);
    } catch (e) {
      this.finished = true;
      this.state.phase = "error";
      this.state.error = (e as Error).message;
      return;
    }
    this.client = client;

    try {
      await client.connect();
      await client.signInUserWithQrCode(
        { apiId, apiHash },
        {
          qrCode: async ({ token }) => {
            const payload = qrPayload(token);
            this.state.webUrl = payload.webUrl;
            if (this.opts.qrToDataUrl) {
              this.state.qrDataUrl = await this.opts.qrToDataUrl(payload.webUrl);
            } else {
              this.state.qrDataUrl = await qrToDataUrl(payload.webUrl);
            }
            this.firstQrResolve?.(payload);
            this.firstQrResolve = null;
            await this.opts.onQr?.(payload);
          },
          password: async (hint) => {
            if (this.opts.password) return this.opts.password(hint ?? "");
            this.state.phase = "password";
            this.state.passwordHint = hint ?? undefined;
            return new Promise<string>((resolve) => {
              this.passwordResolver = resolve;
            });
          },
          onError: (err) => {
            if (!this.finished) {
              this.state.phase = "error";
              this.state.error = err.message;
            }
            this.opts.onError?.(err.message);
          },
        },
      );

      const me = await client.getMe();
      const session = String(client.session.save() ?? "");
      if (session) saveSessionString(this.opts.sessionFile, session);
      this.state.phase = "done";
      this.state.user = displayName(me);
      this.state.savedTo = this.opts.sessionFile;
    } catch (e) {
      if (!this.finished) {
        this.state.phase = "error";
        this.state.error = (e as Error).message;
      }
    } finally {
      this.finished = true;
      client.disconnect().catch(() => undefined);
    }
  }

  /** Fournit le mot de passe 2FA demandé (phase « password »). */
  submitPassword(password: string): void {
    this.passwordResolver?.(password);
    this.passwordResolver = null;
    if (this.state.phase === "password") this.state.phase = "waiting";
  }

  /** Abandonne le parcours. */
  cancel(): void {
    this.finished = true;
    this.passwordResolver?.("");
    this.passwordResolver = null;
    this.client?.disconnect().catch(() => undefined);
    if (this.state.phase !== "done") {
      this.state.phase = "error";
      this.state.error = "Connexion annulée.";
    }
  }
}

/** Connexion d'un bot avec son jeton : écrit la session, puis déconnecte. */
export async function botLoginAndSave(
  apiId: number,
  apiHash: string,
  botToken: string,
  sessionFile: string,
  clientFactory?: (apiId: number, apiHash: string) => TelegramLoginClient,
): Promise<{ user: string; savedTo: string }> {
  const client = clientFactory
    ? clientFactory(apiId, apiHash)
    : realClient(apiId, apiHash);
  try {
    await client.connect();
    const user = await client.signInBot({ apiId, apiHash }, { botAuthToken: botToken });
    const session = String(client.session.save() ?? "");
    if (session) saveSessionString(sessionFile, session);
    return { user: displayName(user), savedTo: sessionFile };
  } finally {
    client.disconnect().catch(() => undefined);
  }
}
