/**
 * Contrat Morph (intégration Locaryn).
 *
 * Trois garanties, chacune liée à un morceau précis de la chaîne :
 *
 *  1. `mcp/mcp.json` ne déclare que des variables que Locaryn sait substituer
 *     (`loader.rs` ne connaît que `${LOCARYN_PLUGIN_ROOT}`) — sinon le serveur
 *     MCP du Morph ne démarre pas dans l'application.
 *  2. Le fichier que l'application écrit (`.data/config.json`, cf.
 *     `services/daemon/src/routes/extensions.rs`) est exactement celui que
 *     `Config.load()` lit : un réglage changé dans l'app atteint le persona.
 *  3. Le formulaire de l'app est construit sur `config.schema` du manifeste —
 *     les champs persona doivent y être déclarés.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "./config.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));

describe("contrat Morph (intégration Locaryn)", () => {
  it("le manifeste MCP n'utilise que des variables que Locaryn substitue", () => {
    const mcpPath = join(moduleDir, "..", "mcp", "mcp.json");
    assert.ok(existsSync(mcpPath), "mcp/mcp.json doit exister à côté du manifeste");
    const mcp = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers?: Record<string, { args?: string[]; env?: Record<string, string> }>;
    };
    const server = mcp.mcpServers?.["snap-astreinte"];
    assert.ok(server, "le serveur MCP snap-astreinte doit être déclaré");

    for (const candidate of [server.args?.join(" ") ?? "", ...Object.values(server.env ?? {})]) {
      assert.ok(
        !candidate.includes("MORPH_ROOT"),
        `${candidate} : MORPH_ROOT n'est pas substitué par Locaryn, le serveur ne démarrerait pas`,
      );
    }
    assert.equal(
      server.args?.[0],
      "${LOCARYN_PLUGIN_ROOT}/dist/index.js",
      "l'entrée du serveur doit pointer sur le binaire compilé via la variable supportée",
    );
    assert.match(
      server.env?.SNAP_ASTREINTE_HOME ?? "",
      /\$\{LOCARYN_PLUGIN_ROOT\}\/\.data$/,
      "les données doivent vivre dans .data du Morph — c'est là que l'app écrit les réglages",
    );
  });

  it("l'app écrit .data/config.json, l'extension le lit — même fichier, mêmes valeurs", () => {
    const home = mkdtempSync(join(tmpdir(), "morph-config-"));
    // Format exact de set_extension_config côté daemon : une map clé → chaîne.
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ "persona.name": "Chloé", "limits.max_reply_chars": "1200" }),
      "utf8",
    );
    process.env.SNAP_ASTREINTE_HOME = home;
    const cfg = Config.load();
    assert.equal(cfg.str("persona.name"), "Chloé");
    // L'app écrit une chaîne ; le schéma la re-coerçit en nombre borné.
    assert.equal(cfg.num("limits.max_reply_chars"), 1200);
  });

  it("le formulaire de l'app se construit sur config.schema — les champs persona y sont", () => {
    const manifest = JSON.parse(readFileSync(join(moduleDir, "..", "plugin.json"), "utf8")) as {
      config?: { schema?: Record<string, unknown> };
    };
    const schema = manifest.config?.schema ?? {};
    for (const key of ["persona.name", "persona.style", "persona.language", "limits.enabled"]) {
      assert.ok(schema[key], `config.schema doit déclarer ${key}`);
    }
  });
});
