/**
 * SnapMCP — MCP Server
 *
 * Registers the shared Snapchat/Telegram chat-control tools as MCP tools
 * using the @modelcontextprotocol/server v2 SDK. The client is injected so
 * you can swap mock ↔ Snapchat ↔ Telegram without touching tool definitions.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { SnapchatClient } from "./client/types.js";

// ── Zod Schemas ─────────────────────────────────────────────────────

const ConversationIdSchema = z.object({
  conversationId: z.string().describe("ID of the conversation"),
});

const SendMessageSchema = z.object({
  conversationId: z.string().describe("ID of the conversation"),
  text: z.string().min(1).max(1000).describe("Message text to send"),
  saveInChat: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to save the message in chat"),
});

const SendVoiceNoteSchema = z
  .object({
    conversationId: z.string().describe("ID of the conversation"),
    audioPath: z
      .string()
      .optional()
      .describe("Local path or URL of the audio file (mp3, m4a, ogg/opus, wav)"),
    text: z
      .string()
      .min(1)
      .optional()
      .describe("Optional transcript used to estimate recording duration"),
    language: z
      .string()
      .optional()
      .default("fr-FR")
      .describe("Language metadata for a future TTS integration, e.g. fr-FR"),
  })
  .refine(({ audioPath, text }) => Boolean(audioPath || text), {
    message: "Provide either audioPath or text",
  });

const SendSnapSchema = z.object({
  conversationId: z.string().describe("ID of the conversation"),
  mediaUrl: z.string().url().describe("URL of the image or video"),
  type: z
    .enum(["image", "video"])
    .describe("Type of media (image or video)"),
  duration: z
    .number()
    .min(1)
    .max(60)
    .optional()
    .describe("Duration in seconds (for video snaps)"),
  caption: z.string().optional().describe("Optional caption on the snap"),
});

const LimitSchema = z.object({
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe("Maximum number of items to return"),
});

const MessagesSchema = ConversationIdSchema.merge(LimitSchema);

const CallIdSchema = z.object({
  callId: z.string().describe("ID of the voice call"),
});

const FriendIdSchema = z.object({
  friendId: z.string().describe("ID of the friend"),
});

// ── Tool Registration ───────────────────────────────────────────────

export function createSnapMcpServer(
  client: SnapchatClient,
): McpServer {
  const server = new McpServer({
    name: "snapmcp",
    version: "1.0.0",      description:
        "SnapMCP — contrôle Snapchat ou Telegram via MCP : messages, notes vocales, appels et conversations.",
  });

  // ── Conversations ──────────────────────────────────────────────

  server.registerTool(
    "get_conversations",
    {
      title: "Get Conversations",
      description:
        "List recent conversations from the selected Snapchat or Telegram backend, ordered by most recent activity.",
      inputSchema: LimitSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ limit }) => {
      const conversations = await client.getConversations(limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(conversations, null, 2),
          },
        ],
        structuredContent: { conversations },
      };
    },
  );

  server.registerTool(
    "get_conversation",
    {
      title: "Get Conversation Details",
      description:
        "Get details of a selected-backend conversation by ID, including participants, last message, and unread count.",
      inputSchema: ConversationIdSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ conversationId }) => {
      const conversation = await client.getConversation(conversationId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(conversation, null, 2),
          },
        ],
        structuredContent: { conversation },
      };
    },
  );

  server.registerTool(
    "get_messages",
    {
      title: "Get Messages",
      description:
        "Retrieve messages from a specific conversation. Returns the most recent messages first.",
      inputSchema: MessagesSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ conversationId, limit }) => {
      const messages = await client.getMessages(conversationId, limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(messages, null, 2),
          },
        ],
        structuredContent: { messages },
      };
    },
  );

  server.registerTool(
    "mark_as_read",
    {
      title: "Mark Conversation as Read",
      description: "Mark all messages in a conversation as read.",
      inputSchema: ConversationIdSchema,
    },
    async ({ conversationId }) => {
      await client.markAsRead(conversationId);
      return {
        content: [
          {
            type: "text",
            text: `Conversation ${conversationId} marked as read.`,
          },
        ],
      };
    },
  );

  // ── Messaging ──────────────────────────────────────────────────

  server.registerTool(
    "send_message",
    {
      title: "Send Message",
      description:
        "Send a text message through the selected Snapchat or Telegram backend. The message is sent immediately and saved by the platform.",
      inputSchema: SendMessageSchema,
    },
    async ({ conversationId, text, saveInChat }) => {
      const message = await client.sendMessage({
        conversationId,
        text,
        saveInChat,
      });
      return {
        content: [
          {
            type: "text",
            text: `Message sent to ${conversationId}: "${text}"`,
          },
        ],
        structuredContent: { message },
      };
    },
  );

  server.registerTool(
    "send_snap",
    {
      title: "Send Snap",
      description:
        "Send a photo or video through the selected backend. Snapchat treats it as a snap; Telegram sends it as media. Provide the media URL and type.",
      inputSchema: SendSnapSchema,
    },
    async ({ conversationId, mediaUrl, type, duration, caption }) => {
      const message = await client.sendSnap({
        conversationId,
        mediaUrl,
        type,
        duration,
        caption,
      });
      return {
        content: [
          {
            type: "text",
            text: `${type === "image" ? "Photo" : "Video"} snap sent to ${conversationId}${caption ? ` with caption: "${caption}"` : ""}`,
          },
        ],
        structuredContent: { message },
      };
    },
  );

  server.registerTool(
    "send_voice_note",
    {
      title: "Send Voice Note",
      description:
        "Send a voice note (audio message). Telegram mode sends a real audio file as a voice note; Snapchat web does not support voice notes and Snapchat ADB requires live phone audio. Provide audioPath for a real Telegram voice note; text is an optional caption/transcript. Mock mode is simulated.",
      inputSchema: SendVoiceNoteSchema,
    },
    async ({ conversationId, audioPath, text, language }) => {
      const message = await client.sendVoiceNote({
        conversationId,
        audioPath,
        text,
        language,
      });
      return {
        content: [
          {
            type: "text",
            text: `Voice note sent to ${conversationId} (${message.duration ?? "?"}s)${text ? `: "${text}"` : ""}`,
          },
        ],
        structuredContent: { message },
      };
    },
  );

  // ── Friends ────────────────────────────────────────────────────

  server.registerTool(
    "list_friends",
    {
      title: "List Friends",
      description: "List contacts/friends from the selected Snapchat or Telegram backend with display names and usernames.",
      inputSchema: LimitSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ limit }) => {
      const friends = await client.listFriends();
      const result = friends.slice(0, limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
        structuredContent: { friends: result },
      };
    },
  );

  server.registerTool(
    "get_friend",
    {
      title: "Get Friend Profile",
      description: "Get detailed profile information for a specific friend.",
      inputSchema: FriendIdSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ friendId }) => {
      const friend = await client.getFriend(friendId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(friend, null, 2),
          },
        ],
        structuredContent: { friend },
      };
    },
  );

  // ── Voice Calls ────────────────────────────────────────────────

  server.registerTool(
    "voice_call",
    {
      title: "Start Voice Call",
      description:
        "Initiate a live voice call when supported by the selected backend. Mock, Snapchat, and Telegram adapters may expose different capabilities; check errors and call_status.",
      inputSchema: ConversationIdSchema,
    },
    async ({ conversationId }) => {
      const call = await client.startVoiceCall({ conversationId });
      return {
        content: [
          {
            type: "text",
            text: `Voice call initiated to ${conversationId}. Call ID: ${call.callId}. State: ${call.state}`,
          },
        ],
        structuredContent: { call },
      };
    },
  );

  server.registerTool(
    "end_call",
    {
      title: "End Voice Call",
      description:
        "End an active voice call by its call ID. Returns the final call details including duration.",
      inputSchema: CallIdSchema,
    },
    async ({ callId }) => {
      const call = await client.endVoiceCall(callId);
      return {
        content: [
          {
            type: "text",
            text: `Call ${callId} ended. Duration: ${call.duration ?? "unknown"}s. Reason: ${call.endReason}`,
          },
        ],
        structuredContent: { call },
      };
    },
  );

  server.registerTool(
    "call_status",
    {
      title: "Check Call Status",
      description:
        "Check the current status of a voice call. Returns the call state (ringing, in_progress, ended) and duration.",
      inputSchema: CallIdSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ callId }) => {
      const call = await client.getCallStatus(callId);
      return {
        content: [
          {
            type: "text",
            text: `Call ${callId}: state=${call.state}, duration=${call.duration ?? "N/A"}s`,
          },
        ],
        structuredContent: { call },
      };
    },
  );

  server.registerTool(
    "active_call",
    {
      title: "Get Active Call",
      description:
        "Get the currently active voice call, if any. Returns null if no call is in progress.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      const call = await client.getActiveCall();
      return {
        content: [
          {
            type: "text",
            text: call
              ? `Active call: ${call.callId}, state=${call.state}, with ${call.conversationId}`
              : "No active call.",
          },
        ],
        structuredContent: { call },
      };
    },
  );

  return server;
}
