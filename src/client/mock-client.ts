/**
 * SnapMCP — Mock Snapchat Client
 *
 * In-memory mock implementation of the SnapchatClient interface.
 * Simulates a realistic Snapchat backend with fake data, delays, and
 * state transitions. Designed so you can swap in a real client
 * (browser-automation, reverse-engineered API, or ADB-based) without
 * changing any MCP tool code.
 *
 * Voice calls are simulated as a state machine:
 *   idle → ringing_outgoing → in_progress → ended
 *
 * The mock pre-populates data so the MCP tools return meaningful
 * results immediately.
 */

import type {
  Conversation,
  Message,
  Friend,
  VoiceCall,
  SnapchatClient,
  SendMessageParams,
  SendSnapParams,
  SendVoiceNoteParams,
  VoiceCallParams,
} from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────────

let nextId = 100;
function uid(prefix: string): string {
  return `${prefix}_${++nextId}_${Date.now()}`;
}

function now(): string {
  return new Date().toISOString();
}

/** Simulate network latency (50–200ms) */
async function delay(): Promise<void> {
  const ms = 50 + Math.random() * 150;
  return new Promise((r) => setTimeout(r, ms));
}

// ── Pre-populated Data ──────────────────────────────────────────────

const mockFriends: Friend[] = [
  {
    id: "friend_1",
    displayName: "Emma Dubois",
    username: "emma.dubois",
    bitmojiUrl: "https://bitmoji.api.snapchat.com/avatar/emma.png",
    status: "connected",
    hasStory: true,
    lastActive: new Date(Date.now() - 120_000).toISOString(),
  },
  {
    id: "friend_2",
    displayName: "Léo Martin",
    username: "leo.martin",
    bitmojiUrl: "https://bitmoji.api.snapchat.com/avatar/leo.png",
    status: "connected",
    hasStory: false,
    lastActive: new Date(Date.now() - 600_000).toISOString(),
  },
  {
    id: "friend_3",
    displayName: "Camille Petit",
    username: "camille.petit",
    status: "connected",
    hasStory: true,
    lastActive: new Date(Date.now() - 3600_000).toISOString(),
  },
  {
    id: "friend_4",
    displayName: "Alex Roux",
    username: "alex.roux",
    status: "pending",
    hasStory: false,
  },
  {
    id: "friend_5",
    displayName: "Groupe Famille",
    username: "",
    status: "connected",
    hasStory: false,
    lastActive: new Date(Date.now() - 300_000).toISOString(),
  },
];

const mockMessages: Message[] = [
  {
    id: "msg_1",
    conversationId: "conv_1",
    senderId: "friend_1",
    type: "text",
    text: "Salut ! Ça va ? 😊",
    timestamp: new Date(Date.now() - 300_000).toISOString(),
    status: "opened",
    saved: true,
  },
  {
    id: "msg_2",
    conversationId: "conv_1",
    senderId: "me",
    type: "text",
    text: "Oui super et toi ?",
    timestamp: new Date(Date.now() - 250_000).toISOString(),
    status: "opened",
    saved: true,
  },
  {
    id: "msg_3",
    conversationId: "conv_1",
    senderId: "friend_1",
    type: "image",
    mediaUrl: "https://picsum.photos/400/600",
    timestamp: new Date(Date.now() - 120_000).toISOString(),
    status: "delivered",
    saved: false,
  },
  {
    id: "msg_4",
    conversationId: "conv_2",
    senderId: "friend_2",
    type: "text",
    text: "On se voit demain ?",
    timestamp: new Date(Date.now() - 7200_000).toISOString(),
    status: "opened",
    saved: true,
  },
  {
    id: "msg_5",
    conversationId: "conv_2",
    senderId: "me",
    type: "text",
    text: "Oui 14h !",
    timestamp: new Date(Date.now() - 7100_000).toISOString(),
    status: "opened",
    saved: true,
  },
  {
    id: "msg_6",
    conversationId: "conv_3",
    senderId: "friend_3",
    type: "video",
    mediaUrl: "https://sample-videos.com/video321/mp4/240/big_buck_bunny_240p_1mb.mp4",
    duration: 10,
    timestamp: new Date(Date.now() - 86_400_000).toISOString(),
    status: "opened",
    saved: false,
  },
];

const mockConversations: Conversation[] = [
  {
    id: "conv_1",
    type: "individual",
    displayName: "Emma Dubois",
    participants: ["me", "friend_1"],
    lastMessage: mockMessages[2],
    lastActivity: mockMessages[2].timestamp,
    unreadCount: 1,
  },
  {
    id: "conv_2",
    type: "individual",
    displayName: "Léo Martin",
    participants: ["me", "friend_2"],
    lastMessage: mockMessages[4],
    lastActivity: mockMessages[4].timestamp,
    unreadCount: 0,
  },
  {
    id: "conv_3",
    type: "individual",
    displayName: "Camille Petit",
    participants: ["me", "friend_3"],
    lastMessage: mockMessages[5],
    lastActivity: mockMessages[5].timestamp,
    unreadCount: 0,
  },
  {
    id: "conv_5",
    type: "group",
    displayName: "Groupe Famille",
    groupName: "Groupe Famille",
    participants: ["me", "friend_1", "friend_5"],
    lastActivity: new Date(Date.now() - 300_000).toISOString(),
    unreadCount: 0,
  },
];

// ── Implementation ──────────────────────────────────────────────────

export class MockSnapchatClient implements SnapchatClient {
  private conversations: Conversation[] = [...mockConversations];
  private messages: Message[] = [...mockMessages];
  private friends: Friend[] = [...mockFriends];
  private activeCall: VoiceCall | null = null;
  private callHistory: VoiceCall[] = [];

  // ── Conversations ───────────────────────────────────────────────

  async getConversations(limit = 20): Promise<Conversation[]> {
    await delay();
    return this.conversations.slice(0, limit);
  }

  async getConversation(conversationId: string): Promise<Conversation> {
    await delay();
    const conv = this.conversations.find((c) => c.id === conversationId);
    if (!conv) throw new Error(`Conversation ${conversationId} not found`);
    return { ...conv };
  }

  async getMessages(conversationId: string, limit = 50): Promise<Message[]> {
    await delay();
    return this.messages
      .filter((m) => m.conversationId === conversationId)
      .slice(0, limit);
  }

  // ── Messaging ───────────────────────────────────────────────────

  async sendMessage(params: SendMessageParams): Promise<Message> {
    await delay();
    const conv = this.conversations.find(
      (c) => c.id === params.conversationId,
    );
    if (!conv) throw new Error(`Conversation ${params.conversationId} not found`);

    const msg: Message = {
      id: uid("msg"),
      conversationId: params.conversationId,
      senderId: "me",
      type: "text",
      text: params.text,
      timestamp: now(),
      status: "sent",
      saved: params.saveInChat ?? true,
    };

    this.messages.push(msg);
    conv.lastMessage = msg;
    conv.lastActivity = msg.timestamp;
    return msg;
  }

  async sendSnap(params: SendSnapParams): Promise<Message> {
    await delay();
    const conv = this.conversations.find(
      (c) => c.id === params.conversationId,
    );
    if (!conv) throw new Error(`Conversation ${params.conversationId} not found`);

    const msg: Message = {
      id: uid("snap"),
      conversationId: params.conversationId,
      senderId: "me",
      type: params.type,
      mediaUrl: params.mediaUrl,
      duration: params.duration,
      text: params.caption,
      timestamp: now(),
      status: "sent",
      saved: false,
    };

    this.messages.push(msg);
    conv.lastMessage = msg;
    conv.lastActivity = msg.timestamp;
    return msg;
  }

  async sendVoiceNote(params: SendVoiceNoteParams): Promise<Message> {
    await delay();
    const conv = this.conversations.find(
      (c) => c.id === params.conversationId,
    );
    if (!conv) throw new Error(`Conversation ${params.conversationId} not found`);
    if (!params.audioPath && !params.text) {
      throw new Error("Provide either audioPath or text to send a voice note");
    }

    // Simulated duration: 2s per ~5 words of text, or a fixed 5s for files
    const duration = params.text
      ? Math.max(1, Math.round(params.text.split(/\s+/).length / 5))
      : 5;

    const msg: Message = {
      id: uid("vn"),
      conversationId: params.conversationId,
      senderId: "me",
      type: "audio",
      mediaUrl: params.audioPath ?? `tts://${params.language ?? "fr-FR"}/${encodeURIComponent(params.text ?? "")}`,
      duration,
      text: params.text,
      timestamp: now(),
      status: "sent",
      saved: true,
    };

    this.messages.push(msg);
    conv.lastMessage = msg;
    conv.lastActivity = msg.timestamp;
    return msg;
  }

  async markAsRead(conversationId: string): Promise<void> {
    await delay();
    const conv = this.conversations.find((c) => c.id === conversationId);
    if (conv) conv.unreadCount = 0;
  }

  // ── Friends ─────────────────────────────────────────────────────

  async listFriends(): Promise<Friend[]> {
    await delay();
    return this.friends.filter((f) => f.status === "connected");
  }

  async getFriend(friendId: string): Promise<Friend> {
    await delay();
    const friend = this.friends.find((f) => f.id === friendId);
    if (!friend) throw new Error(`Friend ${friendId} not found`);
    return { ...friend };
  }

  // ── Voice Calls (simulated state machine) ───────────────────────

  async startVoiceCall(params: VoiceCallParams): Promise<VoiceCall> {
    await delay();
    if (this.activeCall) {
      throw new Error("A call is already in progress");
    }

    const conv = this.conversations.find(
      (c) => c.id === params.conversationId,
    );
    if (!conv) throw new Error(`Conversation ${params.conversationId} not found`);

    const call: VoiceCall = {
      callId: uid("call"),
      conversationId: params.conversationId,
      participants: conv.participants,
      state: "ringing_outgoing",
      startedAt: now(),
      outgoing: true,
    };

    this.activeCall = call;

    // Simulate the call being picked up after a short delay
    setTimeout(() => {
      if (this.activeCall?.callId === call.callId) {
        this.activeCall.state = "in_progress";
      }
    }, 2000 + Math.random() * 3000);

    return call;
  }

  async endVoiceCall(callId: string): Promise<VoiceCall> {
    await delay();
    const call =
      this.activeCall?.callId === callId
        ? this.activeCall
        : this.callHistory.find((c) => c.callId === callId);

    if (!call) throw new Error(`Call ${callId} not found`);

    call.state = "ended";
    call.endedAt = now();
    call.endReason = "hung_up";
    if (call.startedAt) {
      call.duration = Math.round(
        (new Date(call.endedAt).getTime() -
          new Date(call.startedAt).getTime()) /
          1000,
      );
    }

    this.callHistory.push(call);
    this.activeCall = null;
    return call;
  }

  async getActiveCall(): Promise<VoiceCall | null> {
    await delay();
    return this.activeCall ? { ...this.activeCall } : null;
  }

  async getCallStatus(callId: string): Promise<VoiceCall> {
    await delay();
    const call =
      this.activeCall?.callId === callId
        ? this.activeCall
        : this.callHistory.find((c) => c.callId === callId);

    if (!call) throw new Error(`Call ${callId} not found`);
    return { ...call };
  }
}
