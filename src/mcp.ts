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

import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Config } from "./config.js";
import { ContactStore } from "./store.js";
import { Policy, withinActiveHours } from "./policy.js";
import { QrLoginFlow, botLoginAndSave } from "./telegram/login.js";
import { effectiveSessionFile } from "./telegram/session.js";

/** Parcours de connexion QR en cours, par identifiant. */
const loginFlows = new Map<string, QrLoginFlow>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Identifiants Telegram lus dans la configuration, ou un message d'erreur. */
function telegramCredentials(cfg: Config):
  | { apiId: number; apiHash: string }
  | { error: string } {
  const apiId = cfg.num("transport.telegram_api_id");
  const apiHash = cfg.str("transport.telegram_api_hash").trim();
  if (!apiId || !apiHash) {
    return {
      error:
        "api_id et api_hash ne sont pas configurés. Renseignez-les dans les réglages de l'extension (groupe Canal), puis réessayez.",
    };
  }
  return { apiId, apiHash };
}

function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function ago(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} j`;
}

export async function runMcpServer(): Promise<void> {
  const server = new Server(
    { name: "snap-astreinte", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "snap_status",
        description:
          "État du persona : canal configuré, garde-fous actifs, plage horaire, nombre de conversations, escalades en attente.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "snap_list_contacts",
        description:
          "Liste les interlocuteurs et l'état de leur conversation (dernier échange, nombre de tours, escalade en cours).",
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
        description:
          "Rend la main à l'assistant sur une conversation escaladée : il recommencera à répondre à cette personne.",
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
        description:
          "Efface définitivement le contexte d'un interlocuteur. La conversation repart de zéro à son prochain message.",
        inputSchema: {
          type: "object",
          properties: {
            contact_id: { type: "string" },
          },
          required: ["contact_id"],
        },
      },
      {
        name: "telegram_login_qr",
        description:
          "Démarre la connexion Telegram par QR code (compte personnel). Renvoie un lien à ouvrir dans Telegram sur un téléphone pour confirmer la connexion. Vérifiez ensuite telegram_login_status jusqu'à ce que la phase soit « done ».",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "telegram_login_status",
        description:
          "État d'une connexion Telegram en cours (waiting, password, done, error), avec le lien QR courant.",
        inputSchema: {
          type: "object",
          properties: {
            login_id: { type: "string", description: "Identifiant renvoyé par telegram_login_qr." },
          },
          required: ["login_id"],
        },
      },
      {
        name: "telegram_login_password",
        description:
          "Fournit le mot de passe 2FA quand la connexion Telegram est en phase « password ». Demandez-le à l'utilisateur d'abord.",
        inputSchema: {
          type: "object",
          properties: {
            login_id: { type: "string" },
            password: { type: "string" },
          },
          required: ["login_id", "password"],
        },
      },
      {
        name: "telegram_login_bot",
        description:
          "Connecte un bot Telegram avec son jeton (de @BotFather) et enregistre la session : aucune étape de plus. Renvoie le nom du bot et l'emplacement de la session.",
        inputSchema: {
          type: "object",
          properties: {
            bot_token: { type: "string", description: "Jeton 123456:ABC... obtenu auprès de @BotFather." },
          },
          required: ["bot_token"],
        },
      },
      {
        name: "telegram_login_cancel",
        description: "Annule une connexion Telegram par QR en cours.",
        inputSchema: {
          type: "object",
          properties: {
            login_id: { type: "string" },
          },
          required: ["login_id"],
        },
      },
      {
        name: "snap_get_config",
        description:
          "Configuration courante, avec le schéma qui la décrit. Les secrets sont masqués.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "snap_set_config",
        description:
          "Modifie un ou plusieurs réglages. Les clés inconnues sont refusées et signalées.",
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
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

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
          image: cfg.str("image.mode"),
          moteur_image: cfg.str("image.engine"),
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
        if (!ctx) return text(`Aucune conversation pour « ${id} ».`);
        const lines = [
          `Contact : ${ctx.contactName ?? ctx.contactId} (${ctx.contactId})`,
          `Tours : ${ctx.turnCount}${ctx.escalated ? ` — escaladé : ${ctx.escalatedReason}` : ""}`,
          "",
        ];
        if (ctx.summary) lines.push(`Résumé des échanges anciens :\n${ctx.summary}`, "");
        for (const t of ctx.turns) {
          lines.push(`${t.role === "user" ? "Lui" : "Assistant"} : ${t.content}`);
        }
        if (ctx.pendingText) lines.push("", `En attente : ${ctx.pendingText}`);
        return text(lines.join("\n"));
      }

      case "snap_resume": {
        const id = String(args.contact_id ?? "");
        const ctx = store.read(id);
        if (!ctx.escalated) return text(`« ${id} » n'est pas en escalade.`);
        store.reset(ctx);
        await store.withContact(id, ctx.contactName, () => undefined);
        return text(`L'assistant reprend la main sur « ${ctx.contactName ?? id} ».`);
      }

      case "snap_forget": {
        const id = String(args.contact_id ?? "");
        return text(
          store.forget(id)
            ? `Contexte de « ${id} » effacé.`
            : `Aucun contexte à effacer pour « ${id} ».`,
        );
      }

      case "telegram_login_qr": {
        const creds = telegramCredentials(cfg);
        if ("error" in creds) return text({ erreur: creds.error });
        const sessionFile = effectiveSessionFile(cfg.str("transport.telegram_session_file"));
        const loginId = randomUUID();
        const flow = new QrLoginFlow({ sessionFile });
        loginFlows.set(loginId, flow);
        void flow.begin(creds.apiId, creds.apiHash);

        // Attend quelques secondes le premier QR pour renvoyer directement le
        // lien ; sinon l'appelant pourra le lire via telegram_login_status.
        const first = await Promise.race<Awaited<typeof flow.firstQr> | undefined>([
          flow.firstQr,
          sleep(8000).then(() => undefined),
        ]);
        return text({
          login_id: loginId,
          phase: flow.status.phase,
          web_url: first?.webUrl ?? flow.status.webUrl ?? null,
          hint: first
            ? "Demandez à l'utilisateur d'ouvrir ce lien dans Telegram sur son téléphone (ou de scanner le QR)."
            : "En attente du QR — appelez telegram_login_status avec cet identifiant.",
        });
      }

      case "telegram_login_status": {
        const flow = loginFlows.get(String(args.login_id ?? ""));
        if (!flow) {
          return text({
            erreur: "Connexion inconnue ou expirée (le serveur a peut-être redémarré). Relancez telegram_login_qr.",
          });
        }
        return text({ login_id: args.login_id, ...flow.status });
      }

      case "telegram_login_password": {
        const flow = loginFlows.get(String(args.login_id ?? ""));
        if (!flow) return text({ erreur: "Connexion inconnue. Relancez telegram_login_qr." });
        if (flow.status.phase !== "password") {
          return text({ erreur: "Aucun mot de passe attendu pour cette connexion." });
        }
        flow.submitPassword(String(args.password ?? ""));
        return text({ login_id: args.login_id, ...flow.status });
      }

      case "telegram_login_bot": {
        const creds = telegramCredentials(cfg);
        if ("error" in creds) return text({ erreur: creds.error });
        const token = String(args.bot_token ?? "").trim();
        if (!token) return text({ erreur: "Jeton de bot manquant." });
        try {
          const sessionFile = effectiveSessionFile(cfg.str("transport.telegram_session_file"));
          const { user, savedTo } = await botLoginAndSave(
            creds.apiId,
            creds.apiHash,
            token,
            sessionFile,
          );
          return text({ connecté: user, session: savedTo });
        } catch (e) {
          return text({ erreur: (e as Error).message });
        }
      }

      case "telegram_login_cancel": {
        const flow = loginFlows.get(String(args.login_id ?? ""));
        if (!flow) return text({ erreur: "Connexion inconnue." });
        flow.cancel();
        return text({ login_id: args.login_id, ...flow.status });
      }

      case "snap_get_config": {
        const values = cfg.all();
        for (const [key, field] of Object.entries(cfg.schema)) {
          if (field.type === "secret" && values[key]) values[key] = "••••••";
        }
        return text({ schema: cfg.schema, values });
      }

      case "snap_set_config": {
        const patch = (args.values ?? {}) as Record<string, unknown>;
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
