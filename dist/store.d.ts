/**
 * Contextes par interlocuteur.
 *
 * C'est la pièce qui fait que deux personnes écrivant en même temps ne se
 * mélangent jamais. Deux garanties :
 *
 *  1. **Isolation** — un fichier et un contexte par contact, jamais d'historique
 *     partagé. La clé est l'identifiant que le canal donne à l'interlocuteur.
 *  2. **Sérialisation par contact** — un verrou par contact met en file les
 *     traitements d'un même interlocuteur. Sans lui, deux messages rapprochés
 *     de la même personne liraient tous deux le contexte avant que l'un ait
 *     écrit le sien, et le premier tour serait perdu. Node est mono-thread mais
 *     chaque `await` est un point d'entrelacement, donc le risque est réel.
 *
 * Les contacts différents ne se bloquent pas entre eux : deux demandes
 * simultanées de deux personnes sont traitées en parallèle.
 */
import type { ContactContext, Turn } from "./types.js";
export declare class ContactStore {
    private maxTurns;
    /** Une chaîne de promesses par contact : le verrou. */
    private locks;
    private cache;
    constructor(maxTurns: number);
    /**
     * Exécute `fn` avec un accès exclusif au contexte de ce contact, et persiste
     * ce que `fn` a modifié. Les appels concurrents sur le MÊME contact
     * s'exécutent l'un après l'autre ; sur des contacts différents, en parallèle.
     */
    withContact<T>(contactId: string, contactName: string | undefined, fn: (ctx: ContactContext) => Promise<T> | T): Promise<T>;
    read(contactId: string, contactName?: string): ContactContext;
    private write;
    /**
     * Garde les `maxTurns` derniers tours. Les plus anciens sont repliés dans un
     * résumé textuel plutôt que jetés, pour qu'un dépannage long garde sa trace.
     */
    private trim;
    addTurn(ctx: ContactContext, role: Turn["role"], content: string): void;
    /** Remet le compteur de tours et lève l'escalade : nouvelle demande. */
    reset(ctx: ContactContext): void;
    list(): ContactContext[];
    forget(contactId: string): boolean;
    /** Supprime les contextes inactifs depuis plus de `days` jours. 0 = jamais. */
    purge(days: number): number;
}
