/**
 * Tests du chargeur `.env` : valeurs vides, guillemets, `export`, lignes
 * malformées, précédence (l'environnement existant gagne), idempotence.
 * `loadDotEnv` ne lit qu'une fois par processus : les tests qui l'appellent
 * avec succès sont donc un seul flux, dans l'ordre.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnv, parseDotEnv } from "./env.js";

describe("parseDotEnv", () => {
  it("ignore les lignes vides, commentaires et malformées", () => {
    const parsed = parseDotEnv("# commentaire\n\n  \npas_de_valeur\nKEY=ok\n");
    assert.deepEqual(parsed, { KEY: "ok" });
  });

  it("retire les guillemets englobants et garde les = internes", () => {
    assert.deepEqual(parseDotEnv('A="x=y"\nB=\'c d\'\nC=plain\n'), {
      A: "x=y",
      B: "c d",
      C: "plain",
    });
  });

  it("accepte la forme `export` et les valeurs vides", () => {
    assert.deepEqual(parseDotEnv("export A=1\nB=\n"), { A: "1", B: "" });
  });

  it("ne garde que la dernière occurrence d'une clé", () => {
    assert.deepEqual(parseDotEnv("A=1\nA=2\n"), { A: "2" });
  });
});

describe("loadDotEnv", () => {
  const ORIGINAL = { ...process.env };
  const KEY = "SNAP_TEST_DOTENV";
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dotenv-test-"));
    delete process.env[KEY];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...ORIGINAL };
  });

  // Contrat documenté : le chemin explicite est le premier candidat — s'il
  // est absent, le chargeur retombe sur cwd puis la racine du paquet (comme
  // un appel sans argument). Le tester exigerais une instance de module
  // fraîche (drapeau « une seule lecture ») pour une ligne de code.

  it("injection, précédence de l'hôte, puis idempotence (un seul flux)", () => {
    // Une variable déjà posée par l'hôte reste gagnante ; l'autre est injectée.
    process.env[KEY] = "hote";
    writeFileSync(join(dir, ".env"), `${KEY}=fichier\nAUTRE=1\n`);
    assert.equal(loadDotEnv(join(dir, ".env")), join(dir, ".env"));
    assert.equal(process.env[KEY], "hote");
    assert.equal(process.env.AUTRE, "1");

    // Deuxième appel : pas de relecture — les ajouts du fichier sont ignorés.
    delete process.env.AUTRE;
    writeFileSync(join(dir, ".env"), `${KEY}=v2\nNOUVELLE=1\n`);
    assert.equal(loadDotEnv(join(dir, ".env")), null);
    assert.equal(process.env.AUTRE, undefined);
    assert.equal(process.env.NOUVELLE, undefined);
  });
});
