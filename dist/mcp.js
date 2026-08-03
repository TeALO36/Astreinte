/**
 * Serveur MCP : la face « supervision » de l'extension.
 *
 * Le démon répond tout seul ; ce serveur-là existe pour que vous puissiez
 * regarder ce qu'il fait et reprendre la main depuis Lochor, Claude Code ou
 * Gemini CLI, sans arrêter quoi que ce soit. Il lit et écrit les mêmes fichiers
 * que le démon, donc les deux peuvent tourner en même temps.
 *
 * Les outils sont volontairement peu nombreux : lister les conversations, en
 * lire une, reprendre la main sur une escalade, oublier un contact, consulter
 * et modifier la configuration.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { Config } from "./config.js";
import { ContactStore } from "./store.js";
import { Policy, withinActiveHours } from "./policy.js";
function text(value) {
    return {
        content: [
            {
                type: "text",
                text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
            },
        ],
    };
}
function ago(ms) {
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 60)
        return `${s} s`;
    if (s < 3600)
        return `${Math.floor(s / 60)} min`;
    if (s < 86400)
        return `${Math.floor(s / 3600)} h`;
    return `${Math.floor(s / 86400)} j`;
}
export async function runMcpServer() {
    const server = new Server({ name: "snap-astreinte", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "snap_status",
                description: "État de la permanence : canal configuré, garde-fous actifs, plage horaire, nombre de conversations, escalades en attente.",
                inputSchema: { type: "object", properties: {} },
            },
            {
                name: "snap_list_contacts",
                description: "Liste les interlocuteurs et l'état de leur conversation (dernier échange, nombre de tours, escalade en cours).",
                inputSchema: {
                    type: "object",
                    properties: {
                        escalated_only: {
                            type: "boolean",
                            description: "Ne montrer que les conversations passées à l'humain.",
                        },
                    },
                },
            },
            {
                name: "snap_read_conversation",
                description: "Historique complet d'un interlocuteur donné.",
                inputSchema: {
                    type: "object",
                    properties: {
                        contact_id: { type: "string", description: "Identifiant du contact." },
                    },
                    required: ["contact_id"],
                },
            },
            {
                name: "snap_resume",
                description: "Rend la main à l'assistant sur une conversation escaladée : il recommencera à répondre à cette personne.",
                inputSchema: {
                    type: "object",
                    properties: {
                        contact_id: { type: "string" },
                    },
                    required: ["contact_id"],
                },
            },
            {
                name: "snap_forget",
                description: "Efface définitivement le contexte d'un interlocuteur. La conversation repart de zéro à son prochain message.",
                inputSchema: {
                    type: "object",
                    properties: {
                        contact_id: { type: "string" },
                    },
                    required: ["contact_id"],
                },
            },
            {
                name: "snap_get_config",
                description: "Configuration courante, avec le schéma qui la décrit. Les secrets sont masqués.",
                inputSchema: { type: "object", properties: {} },
            },
            {
                name: "snap_set_config",
                description: "Modifie un ou plusieurs réglages. Les clés inconnues sont refusées et signalées.",
                inputSchema: {
                    type: "object",
                    properties: {
                        values: {
                            type: "object",
                            description: 'Couples clé/valeur, par exemple {"persona.language": "fr"}.',
                        },
                    },
                    required: ["values"],
                },
            },
        ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        // Rechargée à chaque appel : le démon ou l'application ont pu la changer
        // entre-temps, et servir une copie périmée serait trompeur.
        const cfg = Config.load();
        const store = new ContactStore(cfg.num("context.max_history_turns") || 20);
        const args = (request.params.arguments ?? {});
        switch (request.params.name) {
            case "snap_status": {
                const contacts = store.list();
                const policy = new Policy(cfg);
                return text({
                    canal: cfg.str("transport.driver"),
                    garde_fous: policy.enabled ? "actifs" : "désactivés (mode autonome sans limite)",
                    plage_horaire: cfg.str("limits.active_hours") || "toute heure",
                    dans_la_plage: withinActiveHours(cfg.str("limits.active_hours")),
                    voix: cfg.str("voice.mode"),
                    moteur_tts: cfg.str("voice.tts_mode"),
                    modele: `${cfg.str("llm.model")} @ ${cfg.str("llm.base_url")}`,
                    conversations: contacts.length,
                    escalades_en_attente: contacts.filter((c) => c.escalated).length,
                    messages_en_attente: contacts.filter((c) => c.pendingText).length,
                });
            }
            case "snap_list_contacts": {
                const only = args.escalated_only === true;
                const rows = store
                    .list()
                    .filter((c) => !only || c.escalated)
                    .map((c) => ({
                    contact_id: c.contactId,
                    nom: c.contactName ?? "—",
                    dernier_echange: `il y a ${ago(c.lastSeenAt)}`,
                    tours: c.turnCount,
                    escalade: c.escalated ? (c.escalatedReason ?? true) : false,
                    en_attente: !!c.pendingText,
                }));
                return text(rows.length ? rows : "Aucune conversation.");
            }
            case "snap_read_conversation": {
                const id = String(args.contact_id ?? "");
                const ctx = store.list().find((c) => c.contactId === id);
                if (!ctx)
                    return text(`Aucune conversation pour « ${id} ».`);
                const lines = [
                    `Contact : ${ctx.contactName ?? ctx.contactId} (${ctx.contactId})`,
                    `Tours : ${ctx.turnCount}${ctx.escalated ? ` — escaladé : ${ctx.escalatedReason}` : ""}`,
                    "",
                ];
                if (ctx.summary)
                    lines.push(`Résumé des échanges anciens :\n${ctx.summary}`, "");
                for (const t of ctx.turns) {
                    lines.push(`${t.role === "user" ? "Lui" : "Assistant"} : ${t.content}`);
                }
                if (ctx.pendingText)
                    lines.push("", `En attente : ${ctx.pendingText}`);
                return text(lines.join("\n"));
            }
            case "snap_resume": {
                const id = String(args.contact_id ?? "");
                const ctx = store.read(id);
                if (!ctx.escalated)
                    return text(`« ${id} » n'est pas en escalade.`);
                store.reset(ctx);
                await store.withContact(id, ctx.contactName, () => undefined);
                return text(`L'assistant reprend la main sur « ${ctx.contactName ?? id} ».`);
            }
            case "snap_forget": {
                const id = String(args.contact_id ?? "");
                return text(store.forget(id)
                    ? `Contexte de « ${id} » effacé.`
                    : `Aucun contexte à effacer pour « ${id} ».`);
            }
            case "snap_get_config": {
                const values = cfg.all();
                for (const [key, field] of Object.entries(cfg.schema)) {
                    if (field.type === "secret" && values[key])
                        values[key] = "••••••";
                }
                return text({ schema: cfg.schema, values });
            }
            case "snap_set_config": {
                const patch = (args.values ?? {});
                const { unknownKeys } = cfg.update(patch);
                const applied = Object.keys(patch).filter((k) => !unknownKeys.includes(k));
                return text({
                    appliqués: applied,
                    refusés: unknownKeys,
                    note: unknownKeys.length
                        ? "Les clés refusées n'existent pas dans le schéma de l'extension."
                        : "Le démon prend les nouvelles valeurs au prochain message reçu.",
                });
            }
            default:
                return text(`Outil inconnu : ${request.params.name}`);
        }
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[snap-astreinte] serveur MCP prêt (stdio)");
}
//# sourceMappingURL=mcp.js.map