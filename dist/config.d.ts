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
export type FieldType = "string" | "text" | "number" | "boolean" | "select" | "list" | "path" | "secret";
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
/** Racine des données : config, contextes, journal. */
export declare function astreinteHome(): string;
export declare function configPath(): string;
/** Lit le schéma depuis `plugin.json`, à côté du paquet installé. */
export declare function loadSchema(): ConfigSchema;
export declare class Config {
    readonly schema: ConfigSchema;
    private values;
    private constructor();
    static load(): Config;
    get<T = unknown>(key: string): T;
    str(key: string): string;
    num(key: string): number;
    bool(key: string): boolean;
    list(key: string): string[];
    all(): ConfigValues;
    /** Applique un patch partiel et le persiste. Renvoie les clés inconnues. */
    update(patch: ConfigValues): {
        unknownKeys: string[];
    };
    save(): void;
}
