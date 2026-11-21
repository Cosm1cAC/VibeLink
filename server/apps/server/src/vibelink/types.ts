import * as Schema from "effect/Schema";

export class VibeLinkError extends Schema.TaggedError<VibeLinkError>()("VibeLinkError", {
  message: Schema.String,
}) {}

export type VlAccountKind = "human" | "bot";

export type VlPresence = "online" | "idle" | "working" | "offline" | "error";

export type VlRoomKind = "dm" | "group";

export type VlMemberRole = "owner" | "admin" | "member";

export type VlMessageType =
  | "text"
  | "bot_markdown"
  | "bot_tool_call"
  | "bot_diff_checkpoint"
  | "bot_approval"
  | "system";

export type VlSendMode = "auto" | "queue" | "steer";

export type VlApprovalStatus = "pending" | "approved" | "rejected";

export interface VlAccount {
  readonly id: string;
  readonly kind: VlAccountKind;
  readonly slug: string;
  readonly handle: string;
  readonly displayName: string;
  readonly avatar: string;
  readonly roleTitle: string;
  readonly department: string;
  readonly presence: VlPresence;
  readonly statusText: string;
  readonly provider: string;
  readonly model: string;
  readonly cwd: string;
  readonly isolationMode: string;
  readonly approvalMode: string;
  readonly description: string;
  readonly pinned: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface VlRoom {
  readonly id: string;
  readonly kind: VlRoomKind;
  readonly name: string;
  readonly notice: string;
  readonly avatar: string;
  readonly muted: boolean;
  readonly pinned: boolean;
  readonly cwd: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface VlRoomMember {
  readonly roomId: string;
  readonly accountId: string;
  readonly role: VlMemberRole;
  readonly muted: boolean;
  readonly joinedAt: number;
}

export interface VlMessage {
  readonly id: string;
  readonly roomId: string;
  readonly senderId: string;
  readonly msgType: VlMessageType;
  readonly content: string;
  readonly metadata: Record<string, unknown>;
  readonly replyToId: string | null;
  readonly handoffChainId: string | null;
  readonly handoffDepth: number;
  readonly recalledAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface VlRoomSummary extends VlRoom {
  readonly members: ReadonlyArray<VlRoomMember>;
  readonly memberCount: number;
  readonly onlineCount: number;
  readonly unreadCount: number;
  readonly lastMessage: VlMessage | null;
}

export interface VlAttachment {
  readonly id: string;
  readonly roomId: string;
  readonly uploaderId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly storagePath: string;
  readonly createdAt: number;
}

export interface VlEvent {
  readonly seq: number;
  readonly eventType: string;
  readonly roomId: string | null;
  readonly payload: Record<string, unknown>;
  readonly createdAt: number;
}

export interface VlRoomBotThread {
  readonly roomId: string;
  readonly botId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly worktreePath: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface VlApproval {
  readonly id: string;
  readonly roomId: string;
  readonly messageId: string;
  readonly botId: string;
  readonly threadId: string | null;
  readonly requestId: string | null;
  readonly title: string;
  readonly detail: string;
  readonly status: VlApprovalStatus;
  readonly decision: string | null;
  readonly createdAt: number;
  readonly resolvedAt: number | null;
}

export interface VlBotConfigJson {
  readonly id: string;
  readonly slug: string;
  readonly handle: string;
  readonly displayName: string;
  readonly avatar: string;
  readonly roleTitle: string;
  readonly department: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingEffort: string;
  readonly cwd: string;
  readonly isolationMode: string;
  readonly approvalMode: string;
  readonly manageOtherBots: boolean;
  readonly dailyCheckIns: boolean;
  readonly disabledTools: ReadonlyArray<string>;
  readonly exampleRequests: ReadonlyArray<string>;
  readonly description: string;
  readonly section: string;
  readonly pinned: boolean;
}

export interface VlBotFileEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: "file" | "dir";
  readonly sizeBytes: number;
  readonly updatedAt: number;
}

export interface VlBootstrapPayload {
  readonly me: VlAccount;
  readonly accounts: ReadonlyArray<VlAccount>;
  readonly rooms: ReadonlyArray<VlRoomSummary>;
  readonly messagesByRoom: Record<string, ReadonlyArray<VlMessage>>;
  readonly latestSeq: number;
  readonly mockBots: boolean;
}
