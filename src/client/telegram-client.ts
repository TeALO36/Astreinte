/**
 * SnapMCP — Telegram client (MTProto user account)
 *
 * Uses GramJS to control a personal Telegram account. Unlike the Bot API,
 * MTProto can access the user's own dialogs and send real voice notes.
 * Authentication is deliberately completed by scripts/telegram-login.mjs so
 * the MCP stdio transport is never blocked waiting for a phone code.
 */

import { TelegramClient as GramJsTelegramClient, sessions } from "telegram";

const { StringSession } = sessions;
import { existsSync, readFileSync } from "node:fs";
import type {
  Conversation,
  Friend,
  Message,
  SendMessageParams,
  SendSnapParams,
  SendVoiceNoteParams,
  SnapchatClient,
  VoiceCall,
  VoiceCallParams,
} from "./types.js";

const DEFAULT_SESSION_FILE = ".telegram/session.txt";

type TelegramEntity = {
  className?: string;
  id?: { toString(): string } | string | number;
  username?: string;
  firstName?: string;
  lastName?: string;
  title?: string;
};

type TelegramDialog = {
  id?: { toString(): string } | string | number;
  name?: string;
  title?: string;
  isUser?: boolean;
  isGroup?: boolean;
  isChannel?: boolean;
  entity?: TelegramEntity;
  message?: unknown;
  unreadCount?: number;
};

type TelegramMessage = {
  id?: number;
  message?: string;
  text?: string;
  date?: number;
  out?: boolean;
  senderId?: { toString(): string } | string | number;
  media?: {
    className?: string;
    document?: {
      mimeType?: string;
      attributes?: Array<{
        className?: string;
        voice?: boolean;
        duration?: number;
      }>;
    };
  };
};

export interface TelegramClientConfig {
  apiId?: number;
  apiHash?: string;
  sessionString?: string;
  sessionFile?: string;
  connectionRetries?: number;
}

export class TelegramSnapchatClient implements SnapchatClient {
  private readonly apiId: number;
  private readonly apiHash: string;
  private readonly sessionString?: string;
  private readonly sessionFile: string;
  private readonly connectionRetries: number;
  private client: GramJsTelegramClient | null = null;

  constructor(config: TelegramClientConfig = {}) {
    const apiId = config.apiId ?? Number(process.env.TELEGRAM_API_ID ?? "");
    const apiHash = config.apiHash ?? process.env.TELEGRAM_API_HASH;
    if (!Number.isInteger(apiId) || apiId <= 0) {
      throw new Error(
        "TELEGRAM_API_ID is required for a Telegram user account. Create it at my.telegram.org.",
      );
    }
    if (!apiHash) {
      throw new Error(
        "TELEGRAM_API_HASH is required for a Telegram user account. Create it at my.telegram.org.",
      );
    }

    this.apiId = apiId;
    this.apiHash = apiHash;
    this.sessionString = config.sessionString ?? process.env.TELEGRAM_SESSION_STRING;
    this.sessionFile = config.sessionFile ?? process.env.TELEGRAM_SESSION_FILE ?? DEFAULT_SESSION_FILE;
    this.connectionRetries = config.connectionRetries ?? 5;
  }

  private loadSession(): string {
    if (this.sessionString) return this.sessionString.trim();
    if (existsSync(this.sessionFile)) return readFileSync(this.sessionFile, "utf8").trim();
    throw new Error(
      `No Telegram session found. Run \"npm run telegram:login\" once, then start the MCP server again. ` +
        `The session is stored in ${this.sessionFile} and must never be committed.`,
    );
  }

  private async ensureClient(): Promise<GramJsTelegramClient> {
    if (this.client) return this.client;

    const client = new GramJsTelegramClient(
      new StringSession(this.loadSession()),
      this.apiId,
      this.apiHash,
      { connectionRetries: this.connectionRetries },
    );
    await client.connect();
    if (!(await client.checkAuthorization())) {
      throw new Error(
        "The Telegram session is not authorized. Run npm run telegram:login to create a fresh session.",
      );
    }
    this.client = client;
    return client;
  }

  private entityName(entity?: TelegramEntity, fallback = "Telegram chat"): string {
    if (!entity) return fallback;
    if (entity.title) return entity.title;
    const fullName = [entity.firstName, entity.lastName].filter(Boolean).join(" ");
    return fullName || (entity.username ? `@${entity.username}` : fallback);
  }

  private entityId(entity?: TelegramEntity): string | undefined {
    if (!entity?.id) return undefined;
    return String(entity.id);
  }

  private conversationId(dialog: TelegramDialog): string {
    return dialog.entity?.username
      ?? (dialog.id ? String(dialog.id) : undefined)
      ?? dialog.name
      ?? dialog.title
      ?? "unknown";
  }

  private messageType(message: TelegramMessage): Message["type"] {
    const mimeType = message.media?.document?.mimeType ?? "";
    if (mimeType.startsWith("audio/")) return "audio";
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("video/")) return "video";
    return "text";
  }

  private messageDuration(message: TelegramMessage): number | undefined {
    const attribute = message.media?.document?.attributes?.find(
      (item) => item.className === "DocumentAttributeAudio" || item.voice,
    );
    return attribute?.duration;
  }

  private mapMessage(message: unknown, conversationId: string): Message {
    const item = (message ?? {}) as TelegramMessage;
    const type = this.messageType(item);
    const id = item.id ?? Date.now();
    const text = item.message ?? item.text;
    return {
      id: `telegram_msg_${id}`,
      conversationId,
      senderId: item.out ? "me" : String(item.senderId ?? "unknown"),
      type,
      text: text || undefined,
      mediaUrl: type === "text" ? undefined : `telegram://message/${id}`,
      duration: this.messageDuration(item),
      timestamp: item.date
        ? new Date(item.date * 1000).toISOString()
        : new Date().toISOString(),
      status: item.out ? "sent" : "opened",
      saved: true,
    };
  }

  private mapConversation(dialog: TelegramDialog): Conversation {
    const id = this.conversationId(dialog);
    return {
      id,
      type: dialog.isUser ? "individual" : "group",
      displayName: dialog.name ?? dialog.title ?? this.entityName(dialog.entity),
      participants: ["me", id],
      lastMessage: dialog.message ? this.mapMessage(dialog.message, id) : undefined,
      lastActivity: new Date().toISOString(),
      unreadCount: dialog.unreadCount ?? 0,
    };
  }

  private async resolve(client: GramJsTelegramClient, conversationId: string): Promise<string> {
    // A username, marked ID, or a cached dialog ID are all accepted by GramJS.
    await client.getInputEntity(conversationId);
    return conversationId;
  }

  async getConversations(limit = 20): Promise<Conversation[]> {
    const client = await this.ensureClient();
    const result: Conversation[] = [];
    for await (const dialog of client.iterDialogs({ limit })) {
      result.push(this.mapConversation(dialog as TelegramDialog));
    }
    return result;
  }

  async getConversation(conversationId: string): Promise<Conversation> {
    const conversations = await this.getConversations(100);
    const known = conversations.find((item) => item.id === conversationId);
    if (known) return known;

    const client = await this.ensureClient();
    const entity = (await client.getEntity(conversationId)) as TelegramEntity;
    return {
      id: conversationId,
      type: entity.className === "User" ? "individual" : "group",
      displayName: this.entityName(entity, conversationId),
      participants: ["me", conversationId],
      lastActivity: new Date().toISOString(),
      unreadCount: 0,
    };
  }

  async getMessages(conversationId: string, limit = 50): Promise<Message[]> {
    const client = await this.ensureClient();
    const entity = await this.resolve(client, conversationId);
    const messages: Message[] = [];
    for await (const message of client.iterMessages(entity, { limit })) {
      messages.push(this.mapMessage(message, conversationId));
    }
    return messages;
  }

  async sendMessage(params: SendMessageParams): Promise<Message> {
    const client = await this.ensureClient();
    const entity = await this.resolve(client, params.conversationId);
    const sent = await client.sendMessage(entity, { message: params.text });
    return this.mapMessage(sent, params.conversationId);
  }

  async sendSnap(params: SendSnapParams): Promise<Message> {
    const client = await this.ensureClient();
    const entity = await this.resolve(client, params.conversationId);
    const sent = await client.sendFile(entity, {
      file: params.mediaUrl,
      caption: params.caption,
      supportsStreaming: params.type === "video",
    });
    return this.mapMessage(sent, params.conversationId);
  }

  async sendVoiceNote(params: SendVoiceNoteParams): Promise<Message> {
    if (!params.audioPath) {
      throw new Error(
        "Telegram voice notes require audioPath. Generate or record an audio file first; text is optional caption/transcript only.",
      );
    }
    const client = await this.ensureClient();
    const entity = await this.resolve(client, params.conversationId);
    const sent = await client.sendFile(entity, {
      file: params.audioPath,
      voiceNote: true,
      caption: params.text,
    });
    return this.mapMessage(sent, params.conversationId);
  }

  async markAsRead(conversationId: string): Promise<void> {
    const client = await this.ensureClient();
    const entity = await this.resolve(client, conversationId);
    await client.markAsRead(entity);
  }

  async listFriends(): Promise<Friend[]> {
    const conversations = await this.getConversations(100);
    return conversations.map((conversation) => ({
      id: conversation.id,
      displayName: conversation.displayName,
      username: conversation.id.startsWith("@") ? conversation.id.slice(1) : conversation.id,
      status: "connected" as const,
      hasStory: false,
      lastActive: conversation.lastActivity,
    }));
  }

  async getFriend(friendId: string): Promise<Friend> {
    const client = await this.ensureClient();
    const entity = (await client.getEntity(friendId)) as TelegramEntity;
    const id = this.entityId(entity) ?? friendId;
    return {
      id,
      displayName: this.entityName(entity, friendId),
      username: entity.username ?? friendId.replace(/^@/, ""),
      status: "connected",
      hasStory: false,
    };
  }

  async startVoiceCall(_params: VoiceCallParams): Promise<VoiceCall> {
    throw new Error("Live voice calls are not implemented by the Telegram adapter yet.");
  }

  async endVoiceCall(_callId: string): Promise<VoiceCall> {
    throw new Error("Live voice calls are not implemented by the Telegram adapter yet.");
  }

  async getActiveCall(): Promise<VoiceCall | null> {
    return null;
  }

  async getCallStatus(_callId: string): Promise<VoiceCall> {
    throw new Error("Live voice calls are not implemented by the Telegram adapter yet.");
  }
}
