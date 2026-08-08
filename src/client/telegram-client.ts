/**
 * SnapMCP — Telegram client (MTProto user account)
 *
 * Uses GramJS to control a personal Telegram account. The account appears as a
 * normal user. Authentication is completed by scripts/telegram-login.mjs so
 * the MCP stdio transport never waits for a phone code.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Api, TelegramClient as GramJsTelegramClient, helpers, sessions } from "telegram";
import { CustomFile } from "telegram/client/uploads.js";
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
import { toOpus } from "../audio/opus.js";
import {
  loadSessionString,
  resolveTelegramSession,
  type ResolvedTelegramSession,
} from "../telegram/session.js";

const { StringSession } = sessions;

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

const TELEGRAM_VIEW_ONCE_TTL = 0x7fffffff;

export class TelegramSnapchatClient implements SnapchatClient {
  private readonly session: ResolvedTelegramSession;
  private readonly connectionRetries: number;
  private client: GramJsTelegramClient | null = null;

  constructor(config: TelegramClientConfig = {}) {
    this.session = resolveTelegramSession(config);
    this.connectionRetries = config.connectionRetries ?? 5;
  }

  private loadSession(): string {
    return loadSessionString(this.session);
  }

  private async ensureClient(): Promise<GramJsTelegramClient> {
    if (this.client) return this.client;
    const client = new GramJsTelegramClient(
      new StringSession(this.loadSession()),
      this.session.apiId,
      this.session.apiHash,
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
    return entity?.id ? String(entity.id) : undefined;
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
      timestamp: item.date ? new Date(item.date * 1000).toISOString() : new Date().toISOString(),
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

  private async uploadForRawMedia(source: string): Promise<CustomFile> {
    if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source);
      if (!response.ok) throw new Error(`Téléchargement média refusé (${response.status}).`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) throw new Error("Le média téléchargé est vide.");
      return new CustomFile("snapmcp-photo.jpg", buffer.length, "", buffer);
    }
    if (!existsSync(source)) throw new Error(`Fichier média introuvable : ${source}`);
    const buffer = readFileSync(source);
    return new CustomFile(path.basename(source), statSync(source).size, "", buffer);
  }

  private async sendEphemeralPhoto(
    client: GramJsTelegramClient,
    conversationId: string,
    mediaUrl: string,
    caption: string | undefined,
    ttlSeconds: number,
  ): Promise<unknown> {
    const entity = (await client.getEntity(conversationId)) as TelegramEntity;
    if (entity.className !== "User") {
      throw new Error("Telegram ne permet les photos éphémères que dans une conversation privée.");
    }
    const peer = await client.getInputEntity(conversationId);
    const uploaded = await client.uploadFile({
      file: await this.uploadForRawMedia(mediaUrl),
      workers: 1,
    });
    const media = new Api.InputMediaUploadedPhoto({ file: uploaded, ttlSeconds });
    const request = new Api.messages.SendMedia({
      peer,
      media,
      message: caption ?? "",
      randomId: helpers.readBigIntFromBuffer(randomBytes(8)),
    });
    const response = await client.invoke(request);
    return client._getResponseMessage(request, response, peer);
  }

  async sendSnap(params: SendSnapParams): Promise<Message> {
    const visibility = params.visibility ?? "saved";
    if (visibility === "view_once_replay") {
      throw new Error(
        "Telegram MTProto expose le mode conservé, 10 secondes et vue unique. Le mode « revoir une fois » n'est pas représenté par son API actuelle.",
      );
    }
    if (visibility !== "saved" && params.type !== "image") {
      throw new Error("Les modes éphémères Telegram sont limités aux photos, pas aux vidéos.");
    }

    const client = await this.ensureClient();
    let sent: unknown;
    if (visibility === "timed_10s" || visibility === "view_once") {
      sent = await this.sendEphemeralPhoto(
        client,
        params.conversationId,
        params.mediaUrl,
        params.caption,
        visibility === "timed_10s" ? 10 : TELEGRAM_VIEW_ONCE_TTL,
      );
    } else {
      const entity = await this.resolve(client, params.conversationId);
      sent = await client.sendFile(entity, {
        file: params.mediaUrl,
        caption: params.caption,
        supportsStreaming: params.type === "video",
      });
    }
    return this.mapMessage(sent, params.conversationId);
  }

  private async prepareVoiceFile(source: string): Promise<string | CustomFile> {
    if (/\.(?:ogg|opus)$/i.test(source)) return source;
    if (!existsSync(source)) throw new Error(`Fichier vocal introuvable : ${source}`);
    const input = readFileSync(source);
    if (input.length === 0) throw new Error("Le fichier vocal est vide.");
    const converted = await toOpus(input);
    const name = `${path.basename(source, path.extname(source))}.ogg`;
    return new CustomFile(name, converted.length, "", converted);
  }

  async sendVoiceNote(params: SendVoiceNoteParams): Promise<Message> {
    const audioPath = params.audioPath;
    if (!audioPath) {
      throw new Error(
        "Telegram voice notes require audioPath. Generate or record an audio file first; text is optional caption/transcript only.",
      );
    }
    const client = await this.ensureClient();
    const entity = await this.resolve(client, params.conversationId);
    const sent = await client.sendFile(entity, {
      file: await this.prepareVoiceFile(audioPath),
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
