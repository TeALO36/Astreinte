/**
 * Notes vocales.
 *
 * Deux moteurs, parce qu'aucun n'est universel :
 *
 *  - **http** : un serveur exposant `/v1/audio/speech` (convention OpenAI, que
 *    la plupart des serveurs TTS locaux reprennent). Le clonage de voix passe
 *    par le champ `voice`, dont la signification dépend du serveur.
 *  - **command** : une ligne de commande locale. C'est la voie pour les moteurs
 *    qui clonent à partir d'un échantillon (XTTS, Qwen3-TTS, OpenVoice) et qui
 *    n'exposent pas d'API HTTP. `{ref}` reçoit le fichier de référence.
 *
 * Aucun des deux n'est supposé présent : si la synthèse échoue, l'appelant
 * bascule en texte plutôt que de laisser tomber le message.
 */
import type { Config } from "./config.js";
export declare class TtsError extends Error {
}
export interface VoiceClip {
    audio: Buffer;
    /** Type MIME réel, pour que le transport choisisse le bon envoi. */
    mimeType: string;
}
/** Découpe une ligne de commande en respectant les guillemets. */
export declare function splitCommand(line: string): string[];
export declare class Tts {
    private cfg;
    constructor(cfg: Config);
    get mode(): string;
    get available(): boolean;
    /** Le texte est-il synthétisable au vu des limites configurées ? */
    fits(text: string): boolean;
    synthesize(text: string): Promise<VoiceClip>;
    private viaHttp;
    private viaCommand;
}
/**
 * L'interlocuteur demande-t-il explicitement un vocal ?
 *
 * Volontairement conservateur : le coût d'un faux positif (un vocal non
 * souhaité) est plus élevé que celui d'un faux négatif (du texte alors qu'on
 * voulait de la voix, et il suffit de redemander).
 */
export declare function asksForVoice(text: string): boolean;
