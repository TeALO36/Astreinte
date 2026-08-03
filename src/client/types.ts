/**
 * SnapMCP — Core Types
 *
 * Defines the shared data structures for Snapchat/Telegram conversations,
 * messages, friends, and voice calls. The SnapchatClient interface is kept
 * as the stable chat-client contract for all backends.
 */

// ── Conversation ────────────────────────────────────────────────────

export interface Conversation {
  id: string;
  type: "individual" | "group";
  displayName: string;
  participants: string[];
  lastMessage?: Message;
  lastActivity: string; // ISO 8601
  unreadCount: number;
  /** Group conversations only */
  groupName?: string;
}

// ── Message ─────────────────────────────────────────────────────────

export type MessageType = "text" | "image" | "video" | "audio" | "sticker";

export type MessageStatus = "sending" | "sent" | "delivered" | "opened" | "failed";

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  type: MessageType;
  /** Text content (for text messages) */
  text?: string;
  /** Media URL (for image/video/audio messages) */
  mediaUrl?: string;
  /** Duration in seconds (for video/audio) */
  duration?: number;
  timestamp: string; // ISO 8601
  status: MessageStatus;
  /** Whether the message was saved in chat */
  saved: boolean;
}

// ── Friend ──────────────────────────────────────────────────────────

export type FriendStatus = "connected" | "pending" | "blocked";

export interface Friend {
  id: string;
  displayName: string;
  username: string;
  bitmojiUrl?: string;
  status: FriendStatus;
  /** Whether friend has a current Story */
  hasStory: boolean;
  lastActive?: string; // ISO 8601
}

// ── Voice Call ──────────────────────────────────────────────────────

export type CallState =
  | "idle"
  | "ringing_outgoing"
  | "ringing_incoming"
  | "in_progress"
  | "ended";

export type CallEndReason = "hung_up" | "declined" | "missed" | "failed" | "busy";

export interface VoiceCall {
  callId: string;
  conversationId: string;
  participants: string[];
  state: CallState;
  startedAt?: string; // ISO 8601
  endedAt?: string; // ISO 8601
  endReason?: CallEndReason;
  /** Whether this is an outgoing call (caller perspective) */
  outgoing: boolean;
  /** Duration in seconds */
  duration?: number;
}

// ── Client Interface ────────────────────────────────────────────────

export interface SendMessageParams {
  conversationId: string;
  text: string;
  /** Auto-save in chat */
  saveInChat?: boolean;
}

export interface SendSnapParams {
  conversationId: string;
  mediaUrl: string;
  type: "image" | "video";
  duration?: number; // seconds, for video
  caption?: string;
}

export interface SendVoiceNoteParams {
  conversationId: string;
  /** Local path or URL of the audio file (mp3, m4a, ogg/opus, wav) */
  audioPath?: string;
  /** Optional caption/transcript. Real clients may require audioPath for an actual voice note. */
  text?: string;
  /** Optional language metadata for a future TTS/audio pipeline (e.g. "fr-FR"). */
  language?: string;
}

export interface VoiceCallParams {
  conversationId: string;
}

export interface SnapchatClient {
  /** Shared chat-control contract used by Snapchat, Telegram, and mock backends. */
  // Conversations
  getConversations(limit?: number): Promise<Conversation[]>;
  getConversation(conversationId: string): Promise<Conversation>;
  getMessages(conversationId: string, limit?: number): Promise<Message[]>;

  // Messaging
  sendMessage(params: SendMessageParams): Promise<Message>;
  sendSnap(params: SendSnapParams): Promise<Message>;
  sendVoiceNote(params: SendVoiceNoteParams): Promise<Message>;
  markAsRead(conversationId: string): Promise<void>;

  // Friends
  listFriends(): Promise<Friend[]>;
  getFriend(friendId: string): Promise<Friend>;

  // Voice calls
  startVoiceCall(params: VoiceCallParams): Promise<VoiceCall>;
  endVoiceCall(callId: string): Promise<VoiceCall>;
  getActiveCall(): Promise<VoiceCall | null>;
  getCallStatus(callId: string): Promise<VoiceCall>;
}
