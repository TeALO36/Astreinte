/**
 * SnapMCP — MCP Server
 *
 * Registers shared Snapchat/Telegram chat-control tools over MCP. The client
 * is injected so mock, Snapchat and Telegram use one contract.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { SnapchatClient } from "./client/types.js";

const EmptySchema = z.object({});
const ConversationIdSchema = z.object({
  conversationId: z.string().describe("ID of the conversation"),
});

const SendMessageSchema = z.object({
  conversationId: z.string().describe("ID of the conversation"),
  text: z.string().min(1).max(1000).describe("Message text to send"),
  saveInChat: z.boolean().optional().default(true).describe("Whether to save the message in chat"),
});

const SendVoiceNoteSchema = z
  .object({
    conversationId: z.string().describe("ID of the conversation"),
    audioPath: z.string().optional().describe("Local path or URL of an audio file"),
    text: z.string().min(1).optional().describe("Optional transcript or caption"),
    language: z.string().optional().default("fr-FR").describe("Language metadata"),
  })
  .refine(({ audioPath, text }) => Boolean(audioPath || text), {
    message: "Provide either audioPath or text",
  });

const SendSnapSchema = z.object({
  conversationId: z.string().describe("ID of the conversation"),
  mediaUrl: z.string().min(1).describe("Local path or URL of the image or video"),
  type: z.enum(["image", "video"]).describe("Type of media"),
  duration: z.number().min(1).max(60).optional().describe("Video duration in seconds"),
  caption: z.string().optional().describe("Optional caption"),
  visibility: z
    .enum(["saved", "timed_10s", "view_once", "view_once_replay"])
    .optional()
    .default("saved")
    .describe("Media lifetime; Telegram supports saved, 10 seconds, or view once"),
});

const LimitSchema = z.object({
  limit: z.number().min(1).max(100).optional().default(20).describe("Maximum number of items"),
});
const MessagesSchema = ConversationIdSchema.merge(LimitSchema);
const CallIdSchema = z.object({ callId: z.string().describe("ID of the voice call") });
const FriendIdSchema = z.object({ friendId: z.string().describe("ID of the friend") });

export function createSnapMcpServer(client: SnapchatClient): McpServer {
  const server = new McpServer({
    name: "snapmcp",
    version: "1.0.0",
    description: "SnapMCP — contrôle Snapchat ou Telegram via MCP : messages, médias, notes vocales, appels et conversations.",
  });

  server.registerTool(
    "open_web_login",
    {
      title: "Open Snapchat Web Login",
      description: "Open a visible Chromium window on Snapchat Web so the user can scan the QR code.",
      inputSchema: EmptySchema,
    },
    async () => {
      if (!client.openLogin) {
        throw new Error("Le parcours QR est disponible uniquement avec le backend Snapchat Web.");
      }
      const status = await client.openLogin();
      return {
        content: [{ type: "text", text: status.detail }],
        structuredContent: { status },
      };
    },
  );

  server.registerTool(
    "web_session_status",
    {
      title: "Verify Snapchat Web Session",
      description: "Verify the active Snapchat Web session and persist it after successful login.",
      inputSchema: EmptySchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      if (!client.getSessionStatus) {
        throw new Error("La vérification de session est disponible uniquement avec le backend Snapchat Web.");
      }
      const status = await client.getSessionStatus();
      return {
        content: [{ type: "text", text: status.detail }],
        structuredContent: { status },
      };
    },
  );

  server.registerTool(
    "get_conversations",
    {
      title: "Get Conversations",
      description: "List recent conversations from the selected Snapchat or Telegram backend.",
      inputSchema: LimitSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ limit }) => {
      const conversations = await client.getConversations(limit);
      return { content: [{ type: "text", text: JSON.stringify(conversations, null, 2) }], structuredContent: { conversations } };
    },
  );

  server.registerTool(
    "get_conversation",
    {
      title: "Get Conversation Details",
      description: "Get one conversation by ID.",
      inputSchema: ConversationIdSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ conversationId }) => {
      const conversation = await client.getConversation(conversationId);
      return { content: [{ type: "text", text: JSON.stringify(conversation, null, 2) }], structuredContent: { conversation } };
    },
  );

  server.registerTool(
    "get_messages",
    {
      title: "Get Messages",
      description: "Retrieve recent messages from a conversation.",
      inputSchema: MessagesSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ conversationId, limit }) => {
      const messages = await client.getMessages(conversationId, limit);
      return { content: [{ type: "text", text: JSON.stringify(messages, null, 2) }], structuredContent: { messages } };
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
      return { content: [{ type: "text", text: `Conversation ${conversationId} marked as read.` }] };
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Send Message",
      description: "Send a text message through the selected backend.",
      inputSchema: SendMessageSchema,
    },
    async ({ conversationId, text, saveInChat }) => {
      const message = await client.sendMessage({ conversationId, text, saveInChat });
      return {
        content: [{ type: "text", text: `Message sent to ${conversationId}: "${text}"` }],
        structuredContent: { message },
      };
    },
  );

  server.registerTool(
    "send_snap",
    {
      title: "Send Snap",
      description:
        "Send an image or video. Telegram can send a private-chat photo saved normally, self-destructing after 10 seconds, or view once. Replay-once is exposed for capability testing but rejected when the backend cannot represent it.",
      inputSchema: SendSnapSchema,
    },
    async ({ conversationId, mediaUrl, type, duration, caption, visibility }) => {
      const message = await client.sendSnap({ conversationId, mediaUrl, type, duration, caption, visibility });
      const lifetime = visibility === "saved" ? "saved" : visibility.replaceAll("_", " ");
      return {
        content: [{ type: "text", text: `${type === "image" ? "Photo" : "Video"} sent to ${conversationId} (${lifetime}).` }],
        structuredContent: { message },
      };
    },
  );

  server.registerTool(
    "send_voice_note",
    {
      title: "Send Voice Note",
      description: "Send a real audio file as a Telegram voice note, or use live phone microphone capture with ADB.",
      inputSchema: SendVoiceNoteSchema,
    },
    async ({ conversationId, audioPath, text, language }) => {
      const message = await client.sendVoiceNote({ conversationId, audioPath, text, language });
      return {
        content: [{ type: "text", text: `Voice note sent to ${conversationId} (${message.duration ?? "?"}s).` }],
        structuredContent: { message },
      };
    },
  );

  server.registerTool(
    "list_friends",
    {
      title: "List Friends",
      description: "List contacts from the selected backend.",
      inputSchema: LimitSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ limit }) => {
      const friends = (await client.listFriends()).slice(0, limit);
      return { content: [{ type: "text", text: JSON.stringify(friends, null, 2) }], structuredContent: { friends } };
    },
  );

  server.registerTool(
    "get_friend",
    {
      title: "Get Friend Profile",
      description: "Get profile information for a contact.",
      inputSchema: FriendIdSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ friendId }) => {
      const friend = await client.getFriend(friendId);
      return { content: [{ type: "text", text: JSON.stringify(friend, null, 2) }], structuredContent: { friend } };
    },
  );

  server.registerTool(
    "voice_call",
    {
      title: "Start Voice Call",
      description: "Initiate a live voice call when supported by the backend.",
      inputSchema: ConversationIdSchema,
    },
    async ({ conversationId }) => {
      const call = await client.startVoiceCall({ conversationId });
      return { content: [{ type: "text", text: `Voice call initiated to ${conversationId}. Call ID: ${call.callId}. State: ${call.state}` }], structuredContent: { call } };
    },
  );

  server.registerTool(
    "end_call",
    {
      title: "End Voice Call",
      description: "End an active voice call.",
      inputSchema: CallIdSchema,
    },
    async ({ callId }) => {
      const call = await client.endVoiceCall(callId);
      return { content: [{ type: "text", text: `Call ${callId} ended. Duration: ${call.duration ?? "unknown"}s.` }], structuredContent: { call } };
    },
  );

  server.registerTool(
    "call_status",
    {
      title: "Check Call Status",
      description: "Check the state of a voice call.",
      inputSchema: CallIdSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ callId }) => {
      const call = await client.getCallStatus(callId);
      return { content: [{ type: "text", text: `Call ${callId}: state=${call.state}, duration=${call.duration ?? "N/A"}s` }], structuredContent: { call } };
    },
  );

  server.registerTool(
    "active_call",
    {
      title: "Get Active Call",
      description: "Get the active voice call, if any.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      const call = await client.getActiveCall();
      return {
        content: [{ type: "text", text: call ? `Active call: ${call.callId}, state=${call.state}` : "No active call." }],
        structuredContent: { call },
      };
    },
  );

  return server;
}
