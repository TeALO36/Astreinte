/**
 * Configuration.
 *
 * Le schéma vit dans `plugin.json` et nulle part ailleurs : l'extension le lit
 * au démarrage pour connaître ses défauts, et l'application hôte le lit pour
 * construire son formulaire. Aucune des deux ne code en dur la liste des
 * réglages, donc aucune des deux ne peut dériver de l'autre.
 *
 * Priorité : variable d'environnement > fichier de config > défaut du schéma.
 * L'environnement passe en premier pour que les secrets puissent rester hors
 * du fichier, ce qui compte quand l'extension finit sur un dépôt public.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export type FieldType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "select"
  | "list"
  | "path"
  | "secret";

export interface FieldSchema {
  type: FieldType;
  title?: string;
  description?: string;
  default?: unknown;
  options?: string[];
  optionLabels?: string[];
  min?: number;
  max?: number;
  step?: number;
  group?: string;
}

export type ConfigSchema = Record<string, FieldSchema>;
export type ConfigValues = Record<string, unknown>;

/** Réglages lisibles depuis l'environnement, pour garder les secrets dehors. */
const ENV_OVERRIDES: Record<string, string> = {
  "transport.telegram_api_id": "SNAP_ASTREINTE_TELEGRAM_API_ID",
  "transport.telegram_api_hash": "SNAP_ASTREINTE_TELEGRAM_API_HASH",
  "transport.telegram_session_file": "SNAP_ASTREINTE_TELEGRAM_SESSION_FILE",
  "llm.api_key": "SNAP_ASTREINTE_LLM_API_KEY",
  "llm.base_url": "SNAP_ASTREINTE_LLM_BASE_URL",
  "llm.model": "SNAP_ASTREINTE_LLM_MODEL",
};

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** Racine des données : config, contextes, journal. */
export function astreinteHome(): string {
  const fromEnv = process.env.SNAP_ASTREINTE_HOME;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  return join(homedir(), ".snap-astreinte");
}

export function configPath(): string {
  return join(astreinteHome(), "config.json");
}

/** Lit le schéma depuis `plugin.json`, à côté du paquet installé. */
export function loadSchema(): ConfigSchema {
  const candidates = [
    join(moduleDir, "..", "plugin.json"),
    join(moduleDir, "..", "..", "plugin.json"),
    join(process.cwd(), "plugin.json"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const raw = JSON.parse(readFileSync(candidate, "utf8"));
      const schema = raw?.config?.schema;
      if (schema && typeof schema === "object") return schema as ConfigSchema;
    } catch {
      // Un manifeste illisible ne doit pas empêcher de démarrer : on tente le
      // suivant, et à défaut on tourne sur des valeurs vides.
    }
  }
  return {};
}

function coerce(value: unknown, field: FieldSchema): unknown {
  switch (field.type) {
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value).trim());
      if (Number.isNaN(n)) return field.default ?? 0;
      const lo = field.min ?? Number.NEGATIVE_INFINITY;
      const hi = field.max ?? Number.POSITIVE_INFINITY;
      return Math.min(hi, Math.max(lo, n));
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      const s = String(value).trim().toLowerCase();
      return s === "true" || s === "1" || s === "yes" || s === "on";
    }
    case "list": {
      if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
      return String(value)
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    case "select": {
      const s = String(value);
      // Une valeur hors liste retomberait silencieusement sur un comportement
      // que l'utilisateur n'a pas choisi : on préfère le défaut déclaré.
      if (field.options && !field.options.includes(s)) return field.default ?? field.options[0];
      return s;
    }
    default:
      return value == null ? "" : String(value);
  }
}

export class Config {
  private constructor(
    readonly schema: ConfigSchema,
    private values: ConfigValues,
  ) {}

  static load(): Config {
    const schema = loadSchema();
    const values: ConfigValues = {};

    for (const [key, field] of Object.entries(schema)) {
      values[key] = field.default ?? (field.type === "list" ? [] : field.type === "boolean" ? false : "");
    }

    const path = configPath();
    if (existsSync(path)) {
      try {
        const stored = JSON.parse(readFileSync(path, "utf8")) as ConfigValues;
        for (const [key, value] of Object.entries(stored)) {
          const field = schema[key];
          values[key] = field ? coerce(value, field) : value;
        }
      } catch (e) {
        console.error(`[snap-astreinte] config illisible (${path}) : ${(e as Error).message}`);
      }
    }

    for (const [key, envName] of Object.entries(ENV_OVERRIDES)) {
      const raw = process.env[envName];
      if (raw != null && raw !== "") {
        const field = schema[key];
        values[key] = field ? coerce(raw, field) : raw;
      }
    }

    return new Config(schema, values);
  }

  get<T = unknown>(key: string): T {
    return this.values[key] as T;
  }

  str(key: string): string {
    const v = this.values[key];
    return v == null ? "" : String(v);
  }

  num(key: string): number {
    const v = Number(this.values[key]);
    return Number.isFinite(v) ? v : 0;
  }

  bool(key: string): boolean {
    return this.values[key] === true;
  }

  list(key: string): string[] {
    const v = this.values[key];
    return Array.isArray(v) ? v.map(String) : [];
  }

  all(): ConfigValues {
    return { ...this.values };
  }

  /** Applique un patch partiel et le persiste. Renvoie les clés inconnues. */
  update(patch: ConfigValues): { unknownKeys: string[] } {
    const unknownKeys: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const field = this.schema[key];
      if (!field) {
        unknownKeys.push(key);
        continue;
      }
      this.values[key] = coerce(value, field);
    }
    this.save();
    return { unknownKeys };
  }

  save(): void {
    const path = configPath();
    mkdirSync(dirname(path), { recursive: true });
    // Les secrets fournis par l'environnement ne sont pas réécrits dans le
    // fichier : ils y resteraient en clair après avoir été sortis exprès.
    const toWrite: ConfigValues = { ...this.values };
    for (const [key, envName] of Object.entries(ENV_OVERRIDES)) {
      if (process.env[envName]) delete toWrite[key];
    }
    writeFileSync(path, JSON.stringify(toWrite, null, 2), "utf8");
  }
}
