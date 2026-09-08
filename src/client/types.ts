/**
 * SnapMCP — Core Types
 *
 * Defines the shared data structures for Snapchat/Telegram conversations,
 * messages, friends, and voice calls. The SnapchatClient interface is kept
 * as the stable chat-client contract for all backends.
 */

export interface Conversation {
  id: string;
  type: "individual" | "group";
  displayName: string;
  participants: string[];
  lastMessage?: Message;
  lastActivity: string;
  unreadCount: number;
  groupName?: string;
}

export type MessageType = "text" | "image" | "video" | "audio" | "sticker";
export type MessageStatus = "sending" | "sent" | "delivered" | "opened" | "failed";

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  type: MessageType;
  text?: string;
  mediaUrl?: string;
  duration?: number;
  timestamp: string;
  status: MessageStatus;
  saved: boolean;
}

export interface Friend {
  id: string;
  displayName: string;
  username: string;
  bitmojiUrl?: string;
  status: "connected" | "pending" | "blocked";
  hasStory: boolean;
  lastActive?: string;
}

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
  startedAt?: string;
  endedAt?: string;
  endReason?: CallEndReason;
  outgoing: boolean;
  duration?: number;
}

/** Explicit media lifetime requested by the test bench or an MCP caller. */
export type MediaVisibility =
  | "saved"
  | "timed_10s"
  | "view_once"
  | "view_once_replay";

export interface SendMessageParams {
  conversationId: string;
  text: string;
  saveInChat?: boolean;
}

export interface SendSnapParams {
  conversationId: string;
  mediaUrl: string;
  type: "image" | "video";
  duration?: number;
  caption?: string;
  /** Telegram supports saved, 10-second, and view-once photos. */
  visibility?: MediaVisibility;
}

export interface SendVoiceNoteParams {
  conversationId: string;
  audioPath?: string;
  text?: string;
  language?: string;
}

export interface VoiceCallParams {
  conversationId: string;
}

export interface WebSessionStatus {
  connected: boolean;
  sessionSaved: boolean;
  browserVisible: boolean;
  stateFile: string;
  url: string;
  detail: string;
}

/** Contenu binaire d'un média reçu, prêt à afficher (data URL) ou à sauver. */
export interface MediaContent {
  mimeType: string;
  base64: string;
}

export interface GetMediaParams {
  conversationId: string;
  /** Identifiant du message tel que renvoyé par `getMessages`. */
  messageId: string;
}

export interface SnapchatClient {
  getConversations(limit?: number): Promise<Conversation[]>;
  getConversation(conversationId: string): Promise<Conversation>;
  getMessages(conversationId: string, limit?: number): Promise<Message[]>;
  sendMessage(params: SendMessageParams): Promise<Message>;
  sendSnap(params: SendSnapParams): Promise<Message>;
  sendVoiceNote(params: SendVoiceNoteParams): Promise<Message>;
  /** Télécharge le média (image, vidéo, audio) attaché à un message reçu. */
  getMedia(params: GetMediaParams): Promise<MediaContent>;
  markAsRead(conversationId: string): Promise<void>;
  listFriends(): Promise<Friend[]>;
  getFriend(friendId: string): Promise<Friend>;
  startVoiceCall(params: VoiceCallParams): Promise<VoiceCall>;
  endVoiceCall(callId: string): Promise<VoiceCall>;
  getActiveCall(): Promise<VoiceCall | null>;
  getCallStatus(callId: string): Promise<VoiceCall>;
  /** Available for the Snapchat Web backend; absent on other backends. */
  openLogin?: () => Promise<WebSessionStatus>;
  getSessionStatus?: () => Promise<WebSessionStatus>;
  /** Available for the ADB backend (Android app): automated credential login. */
  login?: () => Promise<{ loggedIn: boolean; detail: string }>;
}
