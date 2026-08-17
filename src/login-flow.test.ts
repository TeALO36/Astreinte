/**
 * Tests du flux de connexion Telegram (QR, bot) et de la résolution du
 * fichier de session.
 *
 *   node --test dist/login-flow.test.js
 *
 * GramJS n'est pas appelé : un faux client conforme au sous-ensemble utilisé
 * (`TelegramLoginClient`) est injecté via `clientFactory`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Doit être posé avant le premier import qui lit la configuration.
const home = mkdtempSync(join(tmpdir(), "snap-astreinte-login-test-"));
process.env.SNAP_ASTREINTE_HOME = home;

const { effectiveSessionFile, saveSessionString } = await import("./telegram/session.js");
const { QrLoginFlow, botLoginAndSave, qrPayload } = await import("./telegram/login.js");
import type { TelegramLoginClient } from "./telegram/login.js";

process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const waitFor = async (fn: () => boolean, ms = 3000) => {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > ms) throw new Error("délai dépassé");
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** Faux client : parcours pilotable (QR, 2FA, session). */
function fakeClient(opts: {
  passwordNeeded?: boolean;
  fail?: boolean;
} = {}): TelegramLoginClient {
  return {
    connect: async () => undefined,
    signInUserWithQrCode: async (_creds, params) => {
      if (opts.fail) throw new Error("identifiants refusés (AUTH_KEY_UNREGISTERED)");
      await params.qrCode?.({ token: Buffer.from("jeton-qr"), expires: 30 });
      if (opts.passwordNeeded) {
        const pwd = await params.password?.("indice: le chat");
        if (!pwd) throw new Error("Password is empty");
      }
      return { id: 42 };
    },
    signInBot: async (_creds, auth) => {
      if (typeof auth.botAuthToken === "function") auth.botAuthToken();
      return { id: 7, username: "mon_bot" };
    },
    getMe: async () => ({ username: "utilisateur_test" }),
    session: { save: () => "session-secrete" },
    disconnect: async () => undefined,
  };
}

// ---------------------------------------------------------------------------
// Fichier de session
// ---------------------------------------------------------------------------

test("effectiveSessionFile : relatif sous SNAP_ASTREINTE_HOME, absolu tel quel", () => {
  assert.equal(
    effectiveSessionFile(".telegram/session.txt"),
    join(home, ".telegram", "session.txt"),
  );
  assert.equal(effectiveSessionFile(""), join(home, ".telegram", "session.txt"));
  const abs = join(tmpdir(), "ailleurs", "s.txt");
  assert.equal(effectiveSessionFile(abs), abs);
});

test("loadSessionString lit la session à l'emplacement effectif", async () => {
  const { loadSessionString, resolveTelegramSession } = await import("./telegram/session.js");
  // Le fichier est écrit au chemin effectif (relatif au home de test)…
  const rel = ".telegram/session.txt";
  saveSessionString(effectiveSessionFile(rel), "session-ecrite-au-bon-endroit");
  // …et relu par le même chemin relatif, quel que soit le répertoire courant.
  const r = resolveTelegramSession({ apiId: 1, apiHash: "h", sessionFile: rel });
  assert.equal(loadSessionString(r), "session-ecrite-au-bon-endroit");
});

// ---------------------------------------------------------------------------
// QR code
// ---------------------------------------------------------------------------

test("qrPayload produit les liens standard de Telegram", () => {
  const p = qrPayload(Buffer.from("jeton-qr"));
  assert.equal(p.url, `tg://login?token=${Buffer.from("jeton-qr").toString("base64url")}`);
  assert.ok(p.webUrl.startsWith("https://t.me/login/"));
});

test("QrLoginFlow : le QR arrive, la session est écrite au scan", async () => {
  const sessionFile = join(home, "qr-session.txt");
  const seenQr: string[] = [];
  const flow = new QrLoginFlow({
    sessionFile,
    onQr: (payload) => {
      seenQr.push(payload.webUrl);
    },
    clientFactory: () => fakeClient(),
    qrToDataUrl: async () => "data:image/png;base64,xxx",
  });

  const done = flow.begin(1, "hash");
  const first = await flow.firstQr;
  assert.ok(first.webUrl.startsWith("https://t.me/login/"));
  assert.equal(seenQr.length, 1);
  assert.equal(flow.status.phase, "waiting");
  assert.equal(flow.status.qrDataUrl, "data:image/png;base64,xxx");

  await done;
  assert.equal(flow.status.phase, "done");
  assert.equal(flow.status.user, "@utilisateur_test");
  assert.equal(flow.status.savedTo, sessionFile);
  assert.equal(readFileSync(sessionFile, "utf8"), "session-secrete");
});

test("QrLoginFlow : la 2FA passe par la phase « password » et submitPassword", async () => {
  const sessionFile = join(home, "qr-2fa.txt");
  const flow = new QrLoginFlow({
    sessionFile,
    clientFactory: () => fakeClient({ passwordNeeded: true }),
  });

  const done = flow.begin(1, "hash");
  await flow.firstQr;
  await waitFor(() => flow.status.phase === "password");
  assert.equal(flow.status.passwordHint, "indice: le chat");

  flow.submitPassword("secret");
  await done;
  assert.equal(flow.status.phase, "done");
  assert.equal(readFileSync(sessionFile, "utf8"), "session-secrete");
});

test("QrLoginFlow : une erreur d'authentification passe en phase « error »", async () => {
  const flow = new QrLoginFlow({
    sessionFile: join(home, "qr-ko.txt"),
    clientFactory: () => fakeClient({ fail: true }),
  });

  await flow.begin(1, "hash");
  assert.equal(flow.status.phase, "error");
  assert.match(flow.status.error ?? "", /AUTH_KEY_UNREGISTERED/);
});

test("QrLoginFlow : cancel interrompt le parcours", async () => {
  const flow = new QrLoginFlow({
    sessionFile: join(home, "qr-cancel.txt"),
    clientFactory: () => fakeClient({ passwordNeeded: true }),
  });

  const done = flow.begin(1, "hash");
  await flow.firstQr;
  await waitFor(() => flow.status.phase === "password");
  flow.cancel();
  await done;
  assert.equal(flow.status.phase, "error");
  assert.match(flow.status.error ?? "", /annul/i);
  assert.equal(existsSync(join(home, "qr-cancel.txt")), false, "aucune session écrite");
});

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

test("botLoginAndSave : le jeton suffit, la session est écrite", async () => {
  const sessionFile = join(home, "bot-session.txt");
  const { user, savedTo } = await botLoginAndSave(1, "hash", "123:abc", sessionFile, () =>
    fakeClient(),
  );
  assert.equal(user, "@mon_bot");
  assert.equal(savedTo, sessionFile);
  assert.equal(readFileSync(sessionFile, "utf8"), "session-secrete");
});


