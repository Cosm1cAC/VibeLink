// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";

import type {
  VlAccount,
  VlAccountKind,
  VlApproval,
  VlApprovalStatus,
  VlAttachment,
  VlBootstrapPayload,
  VlEvent,
  VlMemberRole,
  VlMessage,
  VlMessageType,
  VlPluginDbState,
  VlPresence,
  VlRoom,
  VlRoomBotThread,
  VlRoomKind,
  VlRoomMember,
  VlRoomSummary,
} from "./types.ts";

export function resolveVibeLinkHome(override?: string): string {
  const raw = override ?? process.env.VIBELINK_HOME ?? NodePath.join(NodeOS.homedir(), ".vibelink");
  return NodePath.resolve(raw);
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export type VlEventSubscriber = (event: VlEvent) => void;

export class VibeLinkDatabase {
  readonly homeDir: string;
  readonly dbPath: string;
  readonly attachmentsDir: string;
  readonly avatarsDir: string;
  readonly db: NodeSqlite.DatabaseSync;
  private readonly subscribers = new Set<VlEventSubscriber>();

  constructor(homeDirOverride?: string) {
    this.homeDir = resolveVibeLinkHome(homeDirOverride);
    this.dbPath = NodePath.join(this.homeDir, "vibelink.sqlite");
    this.attachmentsDir = NodePath.join(this.homeDir, "attachments");
    this.avatarsDir = NodePath.join(this.homeDir, "avatars");
    NodeFS.mkdirSync(this.homeDir, { recursive: true });
    NodeFS.mkdirSync(this.attachmentsDir, { recursive: true });
    NodeFS.mkdirSync(this.avatarsDir, { recursive: true });

    this.db = new NodeSqlite.DatabaseSync(this.dbPath);
    if (process.platform !== "win32") {
      try {
        NodeFS.chmodSync(this.dbPath, 0o600);
      } catch {
        // ignore chmod errors on restricted filesystems
      }
    }
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.subscribers.clear();
    this.db.close();
  }

  subscribe(listener: VlEventSubscriber): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vl_accounts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('human', 'bot')),
        slug TEXT NOT NULL UNIQUE,
        handle TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar TEXT NOT NULL DEFAULT '',
        role_title TEXT NOT NULL DEFAULT '',
        department TEXT NOT NULL DEFAULT '',
        presence TEXT NOT NULL DEFAULT 'idle',
        status_text TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL DEFAULT '',
        isolation_mode TEXT NOT NULL DEFAULT 'shared',
        approval_mode TEXT NOT NULL DEFAULT 'ask',
        description TEXT NOT NULL DEFAULT '',
        pinned INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'manual',
        plugin_id TEXT,
        external_id TEXT,
        visible INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS vl_plugins (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT NOT NULL DEFAULT '{}',
        last_sync_at INTEGER,
        last_error TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS vl_rooms (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('dm', 'group')),
        name TEXT NOT NULL,
        notice TEXT NOT NULL DEFAULT '',
        avatar TEXT NOT NULL DEFAULT '',
        muted INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        cwd TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS vl_room_members (
        room_id TEXT NOT NULL REFERENCES vl_rooms(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES vl_accounts(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
        muted INTEGER NOT NULL DEFAULT 0,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, account_id)
      );

      CREATE TABLE IF NOT EXISTS vl_messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES vl_rooms(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL REFERENCES vl_accounts(id) ON DELETE CASCADE,
        msg_type TEXT NOT NULL DEFAULT 'text',
        content TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        reply_to_id TEXT,
        handoff_chain_id TEXT,
        handoff_depth INTEGER NOT NULL DEFAULT 0,
        recalled_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_vl_messages_room_created
        ON vl_messages (room_id, created_at ASC, id ASC);

      CREATE TABLE IF NOT EXISTS vl_read_cursors (
        room_id TEXT NOT NULL REFERENCES vl_rooms(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES vl_accounts(id) ON DELETE CASCADE,
        last_read_at INTEGER NOT NULL DEFAULT 0,
        last_read_msg_id TEXT,
        PRIMARY KEY (room_id, account_id)
      );

      CREATE TABLE IF NOT EXISTS vl_attachments (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES vl_rooms(id) ON DELETE CASCADE,
        uploader_id TEXT NOT NULL REFERENCES vl_accounts(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS vl_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        room_id TEXT,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_vl_events_seq ON vl_events (seq ASC);

      CREATE TABLE IF NOT EXISTS vl_room_bot_threads (
        room_id TEXT NOT NULL REFERENCES vl_rooms(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES vl_accounts(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        worktree_path TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, bot_id)
      );

      CREATE TABLE IF NOT EXISTS vl_approvals (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES vl_rooms(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES vl_messages(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES vl_accounts(id) ON DELETE CASCADE,
        thread_id TEXT,
        request_id TEXT,
        title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        decision TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
    `);

    const cols = this.db.prepare("PRAGMA table_info(vl_accounts)").all() as Array<{ name?: string }>;
    const existingCols = new Set(cols.map((c) => String(c.name ?? "")));
    if (!existingCols.has("source")) {
      this.db.exec("ALTER TABLE vl_accounts ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';");
    }
    if (!existingCols.has("plugin_id")) {
      this.db.exec("ALTER TABLE vl_accounts ADD COLUMN plugin_id TEXT;");
    }
    if (!existingCols.has("external_id")) {
      this.db.exec("ALTER TABLE vl_accounts ADD COLUMN external_id TEXT;");
    }
    if (!existingCols.has("visible")) {
      this.db.exec("ALTER TABLE vl_accounts ADD COLUMN visible INTEGER NOT NULL DEFAULT 1;");
    }
  }

  private mapAccount(row: Record<string, unknown>): VlAccount {
    return {
      id: String(row.id),
      kind: String(row.kind) as VlAccountKind,
      slug: String(row.slug),
      handle: String(row.handle),
      displayName: String(row.display_name),
      avatar: String(row.avatar ?? ""),
      roleTitle: String(row.role_title ?? ""),
      department: String(row.department ?? ""),
      presence: String(row.presence ?? "idle") as VlPresence,
      statusText: String(row.status_text ?? ""),
      provider: String(row.provider ?? ""),
      model: String(row.model ?? ""),
      cwd: String(row.cwd ?? ""),
      isolationMode: String(row.isolation_mode ?? "shared"),
      approvalMode: String(row.approval_mode ?? "ask"),
      description: String(row.description ?? ""),
      pinned: Number(row.pinned ?? 0) === 1,
      source: String(row.source ?? "manual"),
      pluginId: row.plugin_id == null ? null : String(row.plugin_id),
      externalId: row.external_id == null ? null : String(row.external_id),
      visible: Number(row.visible ?? 1) === 1,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private mapRoom(row: Record<string, unknown>): VlRoom {
    return {
      id: String(row.id),
      kind: String(row.kind) as VlRoomKind,
      name: String(row.name),
      notice: String(row.notice ?? ""),
      avatar: String(row.avatar ?? ""),
      muted: Number(row.muted ?? 0) === 1,
      pinned: Number(row.pinned ?? 0) === 1,
      cwd: String(row.cwd ?? ""),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private mapMessage(row: Record<string, unknown>): VlMessage {
    return {
      id: String(row.id),
      roomId: String(row.room_id),
      senderId: String(row.sender_id),
      msgType: String(row.msg_type ?? "text") as VlMessageType,
      content: String(row.content ?? ""),
      metadata: parseJsonObject(row.metadata_json),
      replyToId: row.reply_to_id == null ? null : String(row.reply_to_id),
      handoffChainId: row.handoff_chain_id == null ? null : String(row.handoff_chain_id),
      handoffDepth: Number(row.handoff_depth ?? 0),
      recalledAt: row.recalled_at == null ? null : Number(row.recalled_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  appendEvent(
    eventType: string,
    roomId: string | null,
    payload: Record<string, unknown>,
  ): VlEvent {
    const createdAt = Date.now();
    const res = this.db
      .prepare(
        `INSERT INTO vl_events (event_type, room_id, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(eventType, roomId, JSON.stringify(payload), createdAt);
    const event: VlEvent = {
      seq: Number(res.lastInsertRowid),
      eventType,
      roomId,
      payload,
      createdAt,
    };
    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch {
        // Keep fan-out resilient to individual closed socket callbacks.
      }
    }
    return event;
  }

  getLatestSeq(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM vl_events").get() as
      | { max_seq?: number }
      | undefined;
    return Number(row?.max_seq ?? 0);
  }

  listEventsSince(sinceSeq: number, limit = 500): ReadonlyArray<VlEvent> {
    const rows = this.db
      .prepare("SELECT * FROM vl_events WHERE seq > ? ORDER BY seq ASC LIMIT ?")
      .all(sinceSeq, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      seq: Number(row.seq),
      eventType: String(row.event_type),
      roomId: row.room_id == null ? null : String(row.room_id),
      payload: parseJsonObject(row.payload_json),
      createdAt: Number(row.created_at),
    }));
  }

  listAccounts(
    kind?: VlAccountKind,
    options?: { readonly includeHidden?: boolean },
  ): ReadonlyArray<VlAccount> {
    const includeHidden = options?.includeHidden ?? false;
    const rows = (
      kind
        ? includeHidden
          ? this.db
              .prepare("SELECT * FROM vl_accounts WHERE kind = ? ORDER BY pinned DESC, created_at ASC")
              .all(kind)
          : this.db
              .prepare(
                "SELECT * FROM vl_accounts WHERE kind = ? AND visible = 1 ORDER BY pinned DESC, created_at ASC",
              )
              .all(kind)
        : includeHidden
          ? this.db
              .prepare("SELECT * FROM vl_accounts ORDER BY kind ASC, pinned DESC, created_at ASC")
              .all()
          : this.db
              .prepare(
                "SELECT * FROM vl_accounts WHERE visible = 1 ORDER BY kind ASC, pinned DESC, created_at ASC",
              )
              .all()
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapAccount(row));
  }

  getAccount(accountId: string): VlAccount | null {
    const row = this.db.prepare("SELECT * FROM vl_accounts WHERE id = ?").get(accountId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapAccount(row) : null;
  }

  getAccountBySlugOrHandle(identifier: string): VlAccount | null {
    const row = this.db
      .prepare(
        "SELECT * FROM vl_accounts WHERE id = ? OR lower(slug) = lower(?) OR lower(handle) = lower(?) OR lower(display_name) = lower(?) LIMIT 1",
      )
      .get(identifier, identifier, identifier, identifier) as Record<string, unknown> | undefined;
    return row ? this.mapAccount(row) : null;
  }

  findAccountByPluginExternalId(pluginId: string, externalId: string): VlAccount | null {
    const row = this.db
      .prepare(
        "SELECT * FROM vl_accounts WHERE plugin_id = ? AND lower(external_id) = lower(?) LIMIT 1",
      )
      .get(pluginId, externalId) as Record<string, unknown> | undefined;
    return row ? this.mapAccount(row) : null;
  }

  upsertAccount(
    account: Omit<VlAccount, "createdAt" | "updatedAt" | "source" | "pluginId" | "externalId" | "visible"> & {
      readonly source?: string;
      readonly pluginId?: string | null;
      readonly externalId?: string | null;
      readonly visible?: boolean;
      readonly createdAt?: number;
      readonly updatedAt?: number;
    },
  ): VlAccount {
    const existing = this.getAccount(account.id);
    const now = Date.now();
    const createdAt = existing?.createdAt ?? account.createdAt ?? now;
    const updatedAt = account.updatedAt ?? now;
    const source = account.source ?? existing?.source ?? "manual";
    const pluginId =
      account.pluginId !== undefined ? account.pluginId : (existing?.pluginId ?? null);
    const externalId =
      account.externalId !== undefined ? account.externalId : (existing?.externalId ?? null);
    const visible = account.visible !== undefined ? account.visible : (existing?.visible ?? true);
    this.db
      .prepare(
        `INSERT INTO vl_accounts (
           id, kind, slug, handle, display_name, avatar, role_title, department,
           presence, status_text, provider, model, cwd, isolation_mode, approval_mode,
           description, pinned, source, plugin_id, external_id, visible, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           slug = excluded.slug,
           handle = excluded.handle,
           display_name = excluded.display_name,
           avatar = excluded.avatar,
           role_title = excluded.role_title,
           department = excluded.department,
           presence = excluded.presence,
           status_text = excluded.status_text,
           provider = excluded.provider,
           model = excluded.model,
           cwd = excluded.cwd,
           isolation_mode = excluded.isolation_mode,
           approval_mode = excluded.approval_mode,
           description = excluded.description,
           pinned = excluded.pinned,
           source = excluded.source,
           plugin_id = excluded.plugin_id,
           external_id = excluded.external_id,
           visible = excluded.visible,
           updated_at = excluded.updated_at`,
      )
      .run(
        account.id,
        account.kind,
        account.slug,
        account.handle,
        account.displayName,
        account.avatar,
        account.roleTitle,
        account.department,
        account.presence,
        account.statusText,
        account.provider,
        account.model,
        account.cwd,
        account.isolationMode,
        account.approvalMode,
        account.description,
        account.pinned ? 1 : 0,
        source,
        pluginId,
        externalId,
        visible ? 1 : 0,
        createdAt,
        updatedAt,
      );
    return this.getAccount(account.id)!;
  }

  updateAccountFields(
    accountId: string,
    patch: Partial<{
      displayName: string;
      handle: string;
      avatar: string;
      roleTitle: string;
      department: string;
      presence: VlPresence;
      statusText: string;
      provider: string;
      model: string;
      cwd: string;
      isolationMode: string;
      approvalMode: string;
      description: string;
      pinned: boolean;
      source: string;
      pluginId: string | null;
      externalId: string | null;
      visible: boolean;
    }>,
    emitPresenceEvent = true,
  ): VlAccount | null {
    const current = this.getAccount(accountId);
    if (!current) return null;
    const updated = this.upsertAccount({
      ...current,
      ...patch,
      updatedAt: Date.now(),
    });
    if (emitPresenceEvent) {
      this.appendEvent("account.updated", null, { account: updated });
    }
    return updated;
  }

  getRoom(roomId: string): VlRoom | null {
    const row = this.db.prepare("SELECT * FROM vl_rooms WHERE id = ?").get(roomId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapRoom(row) : null;
  }

  upsertRoom(room: Omit<VlRoom, "createdAt" | "updatedAt"> & {
    readonly createdAt?: number;
    readonly updatedAt?: number;
  }): VlRoom {
    const existing = this.getRoom(room.id);
    const now = Date.now();
    const createdAt = existing?.createdAt ?? room.createdAt ?? now;
    const updatedAt = room.updatedAt ?? now;
    this.db
      .prepare(
        `INSERT INTO vl_rooms (
           id, kind, name, notice, avatar, muted, pinned, cwd, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           name = excluded.name,
           notice = excluded.notice,
           avatar = excluded.avatar,
           muted = excluded.muted,
           pinned = excluded.pinned,
           cwd = excluded.cwd,
           updated_at = excluded.updated_at`,
      )
      .run(
        room.id,
        room.kind,
        room.name,
        room.notice,
        room.avatar,
        room.muted ? 1 : 0,
        room.pinned ? 1 : 0,
        room.cwd,
        createdAt,
        updatedAt,
      );
    return this.getRoom(room.id)!;
  }

  updateRoom(
    roomId: string,
    patch: Partial<{ name: string; notice: string; avatar: string; muted: boolean; pinned: boolean; cwd: string }>,
  ): VlRoomSummary | null {
    const existing = this.getRoom(roomId);
    if (!existing) return null;
    this.upsertRoom({
      ...existing,
      ...patch,
      updatedAt: Date.now(),
    });
    const summary = this.getRoomSummary(roomId);
    if (summary) {
      this.appendEvent("room.updated", roomId, { room: summary });
    }
    return summary;
  }

  addRoomMember(roomId: string, accountId: string, role: VlMemberRole = "member"): void {
    this.db
      .prepare(
        `INSERT INTO vl_room_members (room_id, account_id, role, muted, joined_at)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(room_id, account_id) DO UPDATE SET role = excluded.role`,
      )
      .run(roomId, accountId, role, Date.now());
  }

  removeRoomMember(roomId: string, accountId: string): boolean {
    const res = this.db
      .prepare("DELETE FROM vl_room_members WHERE room_id = ? AND account_id = ?")
      .run(roomId, accountId);
    if (res.changes > 0) {
      const summary = this.getRoomSummary(roomId);
      if (summary) {
        this.appendEvent("room.updated", roomId, { room: summary });
      }
      return true;
    }
    return false;
  }

  listRoomMembers(roomId: string): ReadonlyArray<VlRoomMember> {
    const rows = this.db
      .prepare("SELECT * FROM vl_room_members WHERE room_id = ? ORDER BY joined_at ASC")
      .all(roomId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      roomId: String(row.room_id),
      accountId: String(row.account_id),
      role: String(row.role) as VlMemberRole,
      muted: Number(row.muted ?? 0) === 1,
      joinedAt: Number(row.joined_at),
    }));
  }

  getRoomBotAccounts(
    roomId: string,
    options?: { readonly includeHidden?: boolean },
  ): ReadonlyArray<VlAccount> {
    const includeHidden = options?.includeHidden ?? false;
    const rows = this.db
      .prepare(
        includeHidden
          ? `SELECT a.* FROM vl_accounts a
             INNER JOIN vl_room_members m ON m.account_id = a.id
             WHERE m.room_id = ? AND a.kind = 'bot'
             ORDER BY m.joined_at ASC`
          : `SELECT a.* FROM vl_accounts a
             INNER JOIN vl_room_members m ON m.account_id = a.id
             WHERE m.room_id = ? AND a.kind = 'bot' AND a.visible = 1
             ORDER BY m.joined_at ASC`,
      )
      .all(roomId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapAccount(row));
  }

  getReadCursor(roomId: string, accountId = "me"): number {
    const row = this.db
      .prepare("SELECT last_read_at FROM vl_read_cursors WHERE room_id = ? AND account_id = ?")
      .get(roomId, accountId) as { last_read_at?: number } | undefined;
    return Number(row?.last_read_at ?? 0);
  }

  markRoomRead(roomId: string, accountId = "me", lastReadMsgId?: string | null): number {
    const latestRow = this.db
      .prepare("SELECT COALESCE(MAX(created_at), 0) AS max_ts FROM vl_messages WHERE room_id = ?")
      .get(roomId) as { max_ts?: number } | undefined;
    const ts = Math.max(Date.now(), Number(latestRow?.max_ts ?? 0));
    this.db
      .prepare(
        `INSERT INTO vl_read_cursors (room_id, account_id, last_read_at, last_read_msg_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(room_id, account_id) DO UPDATE SET
           last_read_at = MAX(vl_read_cursors.last_read_at, excluded.last_read_at),
           last_read_msg_id = COALESCE(excluded.last_read_msg_id, vl_read_cursors.last_read_msg_id)`,
      )
      .run(roomId, accountId, ts, lastReadMsgId ?? null);
    this.appendEvent("room.read", roomId, { roomId, accountId, lastReadAt: ts });
    return ts;
  }

  getMessage(msgId: string): VlMessage | null {
    const row = this.db.prepare("SELECT * FROM vl_messages WHERE id = ?").get(msgId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapMessage(row) : null;
  }

  listMessages(roomId: string, options?: { limit?: number; before?: number }): ReadonlyArray<VlMessage> {
    const limit = Math.max(1, Math.min(options?.limit ?? 150, 500));
    const rows = (
      options?.before !== undefined
        ? this.db
            .prepare(
              `SELECT * FROM (
                 SELECT * FROM vl_messages WHERE room_id = ? AND created_at < ?
                 ORDER BY created_at DESC, id DESC LIMIT ?
               ) ORDER BY created_at ASC, id ASC`,
            )
            .all(roomId, options.before, limit)
        : this.db
            .prepare(
              `SELECT * FROM (
                 SELECT * FROM vl_messages WHERE room_id = ?
                 ORDER BY created_at DESC, id DESC LIMIT ?
               ) ORDER BY created_at ASC, id ASC`,
            )
            .all(roomId, limit)
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapMessage(row));
  }

  createMessage(input: {
    readonly id?: string;
    readonly roomId: string;
    readonly senderId: string;
    readonly msgType?: VlMessageType;
    readonly content: string;
    readonly metadata?: Record<string, unknown>;
    readonly replyToId?: string | null;
    readonly handoffChainId?: string | null;
    readonly handoffDepth?: number;
    readonly createdAt?: number;
    readonly emitEvent?: boolean;
  }): VlMessage {
    const id = input.id ?? `msg_${NodeCrypto.randomUUID()}`;
    const now = input.createdAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO vl_messages (
           id, room_id, sender_id, msg_type, content, metadata_json,
           reply_to_id, handoff_chain_id, handoff_depth, recalled_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        id,
        input.roomId,
        input.senderId,
        input.msgType ?? "text",
        input.content,
        JSON.stringify(input.metadata ?? {}),
        input.replyToId ?? null,
        input.handoffChainId ?? null,
        input.handoffDepth ?? 0,
        now,
        now,
      );
    this.db
      .prepare("UPDATE vl_rooms SET updated_at = MAX(updated_at, ?) WHERE id = ?")
      .run(now, input.roomId);
    const created = this.getMessage(id)!;
    if (input.emitEvent !== false) {
      this.appendEvent("message.created", input.roomId, { message: created });
    }
    return created;
  }

  updateMessageContent(
    msgId: string,
    patch: {
      readonly content?: string;
      readonly metadata?: Record<string, unknown>;
    },
  ): VlMessage | null {
    const existing = this.getMessage(msgId);
    if (!existing) return null;
    const nextContent = patch.content ?? existing.content;
    const nextMetadata = patch.metadata ? { ...existing.metadata, ...patch.metadata } : existing.metadata;
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE vl_messages SET content = ?, metadata_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(nextContent, JSON.stringify(nextMetadata), now, msgId);
    const updated = this.getMessage(msgId)!;
    this.appendEvent("message.updated", existing.roomId, { message: updated });
    return updated;
  }

  recallMessage(msgId: string): VlMessage | null {
    const existing = this.getMessage(msgId);
    if (!existing) return null;
    const now = Date.now();
    this.db
      .prepare("UPDATE vl_messages SET recalled_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, msgId);
    const updated = this.getMessage(msgId)!;
    this.appendEvent("message.recalled", existing.roomId, { message: updated });
    return updated;
  }

  getRoomSummary(
    roomId: string,
    viewerId = "me",
    options?: { readonly includeHidden?: boolean },
  ): VlRoomSummary | null {
    const room = this.getRoom(roomId);
    if (!room) return null;
    const includeHidden = options?.includeHidden ?? false;
    const rows = this.db
      .prepare(
        `SELECT m.room_id, m.account_id, m.role, m.muted, m.joined_at,
                a.kind AS account_kind, a.visible AS account_visible, a.presence AS account_presence
         FROM vl_room_members m
         INNER JOIN vl_accounts a ON a.id = m.account_id
         WHERE m.room_id = ?
         ORDER BY m.joined_at ASC`,
      )
      .all(roomId) as Array<Record<string, unknown>>;

    const visibleRows = includeHidden
      ? rows
      : rows.filter(
          (row) => String(row.account_kind) === "human" || Number(row.account_visible ?? 1) === 1,
        );

    const members: VlRoomMember[] = visibleRows.map((row) => ({
      roomId: String(row.room_id),
      accountId: String(row.account_id),
      role: String(row.role) as VlMemberRole,
      muted: Number(row.muted ?? 0) === 1,
      joinedAt: Number(row.joined_at),
    }));
    const onlineCount = visibleRows.filter(
      (row) => String(row.account_presence ?? "idle") !== "offline",
    ).length;

    const lastReadAt = this.getReadCursor(roomId, viewerId);
    const unreadRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM vl_messages
         WHERE room_id = ? AND sender_id != ? AND created_at > ? AND recalled_at IS NULL`,
      )
      .get(roomId, viewerId, lastReadAt) as { cnt?: number } | undefined;
    const lastRow = this.db
      .prepare(
        "SELECT * FROM vl_messages WHERE room_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(roomId) as Record<string, unknown> | undefined;
    return {
      ...room,
      members,
      memberCount: members.length,
      onlineCount,
      unreadCount: Number(unreadRow?.cnt ?? 0),
      lastMessage: lastRow ? this.mapMessage(lastRow) : null,
    };
  }

  listRoomSummaries(
    viewerId = "me",
    options?: { readonly includeHidden?: boolean },
  ): ReadonlyArray<VlRoomSummary> {
    const includeHidden = options?.includeHidden ?? false;
    const rows = this.db
      .prepare("SELECT id FROM vl_rooms ORDER BY pinned DESC, updated_at DESC, created_at ASC")
      .all() as Array<{ id: string }>;
    return rows
      .map((row) => this.getRoomSummary(String(row.id), viewerId, options))
      .filter((summary): summary is VlRoomSummary => {
        if (!summary) return false;
        if (!includeHidden && summary.kind === "dm") {
          const rawMembers = this.listRoomMembers(summary.id);
          const hasHiddenTarget = rawMembers.some((m) => {
            if (m.accountId === viewerId) return false;
            const acc = this.getAccount(m.accountId);
            return acc !== null && !acc.visible;
          });
          if (hasHiddenTarget) return false;
        }
        return true;
      });
  }

  getBootstrapPayload(viewerId = "me", messageLimit = 100): VlBootstrapPayload {
    const accounts = this.listAccounts();
    const me = accounts.find((acc) => acc.id === viewerId) ?? accounts[0]!;
    const rooms = this.listRoomSummaries(viewerId);
    const messagesByRoom: Record<string, ReadonlyArray<VlMessage>> = {};
    for (const room of rooms) {
      messagesByRoom[room.id] = this.listMessages(room.id, { limit: messageLimit });
    }
    return {
      me,
      accounts,
      rooms,
      messagesByRoom,
      latestSeq: this.getLatestSeq(),
      mockBots: process.env.VIBELINK_MOCK_BOTS === "1",
    };
  }

  getRoomBotThread(roomId: string, botId: string): VlRoomBotThread | null {
    const row = this.db
      .prepare("SELECT * FROM vl_room_bot_threads WHERE room_id = ? AND bot_id = ?")
      .get(roomId, botId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      roomId: String(row.room_id),
      botId: String(row.bot_id),
      projectId: String(row.project_id),
      threadId: String(row.thread_id),
      worktreePath: row.worktree_path == null ? null : String(row.worktree_path),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  findRoomBotThreadByThreadId(threadId: string): VlRoomBotThread | null {
    const row = this.db
      .prepare("SELECT * FROM vl_room_bot_threads WHERE thread_id = ? LIMIT 1")
      .get(threadId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      roomId: String(row.room_id),
      botId: String(row.bot_id),
      projectId: String(row.project_id),
      threadId: String(row.thread_id),
      worktreePath: row.worktree_path == null ? null : String(row.worktree_path),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  upsertRoomBotThread(binding: {
    readonly roomId: string;
    readonly botId: string;
    readonly projectId: string;
    readonly threadId: string;
    readonly worktreePath?: string | null;
  }): VlRoomBotThread {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO vl_room_bot_threads (
           room_id, bot_id, project_id, thread_id, worktree_path, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(room_id, bot_id) DO UPDATE SET
           project_id = excluded.project_id,
           thread_id = excluded.thread_id,
           worktree_path = excluded.worktree_path,
           updated_at = excluded.updated_at`,
      )
      .run(
        binding.roomId,
        binding.botId,
        binding.projectId,
        binding.threadId,
        binding.worktreePath ?? null,
        now,
        now,
      );
    return this.getRoomBotThread(binding.roomId, binding.botId)!;
  }

  listRoomBotThreads(roomId: string): ReadonlyArray<VlRoomBotThread> {
    const rows = this.db
      .prepare("SELECT * FROM vl_room_bot_threads WHERE room_id = ? ORDER BY updated_at DESC")
      .all(roomId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      roomId: String(row.room_id),
      botId: String(row.bot_id),
      projectId: String(row.project_id),
      threadId: String(row.thread_id),
      worktreePath: row.worktree_path == null ? null : String(row.worktree_path),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  createApproval(input: {
    readonly id?: string;
    readonly roomId: string;
    readonly messageId: string;
    readonly botId: string;
    readonly threadId?: string | null;
    readonly requestId?: string | null;
    readonly title: string;
    readonly detail: string;
  }): VlApproval {
    const id = input.id ?? `apr_${NodeCrypto.randomUUID()}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO vl_approvals (
           id, room_id, message_id, bot_id, thread_id, request_id,
           title, detail, status, decision, created_at, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
      )
      .run(
        id,
        input.roomId,
        input.messageId,
        input.botId,
        input.threadId ?? null,
        input.requestId ?? null,
        input.title,
        input.detail,
        now,
      );
    return this.getApproval(id)!;
  }

  getApproval(approvalId: string): VlApproval | null {
    const row = this.db.prepare("SELECT * FROM vl_approvals WHERE id = ?").get(approvalId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      roomId: String(row.room_id),
      messageId: String(row.message_id),
      botId: String(row.bot_id),
      threadId: row.thread_id == null ? null : String(row.thread_id),
      requestId: row.request_id == null ? null : String(row.request_id),
      title: String(row.title),
      detail: String(row.detail ?? ""),
      status: String(row.status) as VlApprovalStatus,
      decision: row.decision == null ? null : String(row.decision),
      createdAt: Number(row.created_at),
      resolvedAt: row.resolved_at == null ? null : Number(row.resolved_at),
    };
  }

  resolveApproval(approvalId: string, status: "approved" | "rejected", decision: string): VlApproval | null {
    const existing = this.getApproval(approvalId);
    if (!existing) return null;
    const now = Date.now();
    this.db
      .prepare("UPDATE vl_approvals SET status = ?, decision = ?, resolved_at = ? WHERE id = ?")
      .run(status, decision, now, approvalId);
    const updated = this.getApproval(approvalId)!;
    const msg = this.getMessage(existing.messageId);
    if (msg) {
      this.updateMessageContent(msg.id, {
        metadata: {
          ...msg.metadata,
          status,
          decision,
          resolvedAt: now,
        },
      });
    }
    this.appendEvent("approval.resolved", existing.roomId, { approval: updated });
    return updated;
  }

  saveAttachment(input: {
    readonly roomId: string;
    readonly uploaderId: string;
    readonly filename: string;
    readonly mimeType: string;
    readonly data: Uint8Array;
  }): VlAttachment {
    const id = `att_${NodeCrypto.randomUUID()}`;
    const safeName = input.filename.replace(/[^\w.\-()\u4e00-\u9fa5]/g, "_").slice(0, 120) || "file.bin";
    const storagePath = NodePath.join(this.attachmentsDir, `${id}_${safeName}`);
    NodeFS.writeFileSync(storagePath, input.data);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO vl_attachments (
           id, room_id, uploader_id, filename, mime_type, size_bytes, storage_path, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.roomId,
        input.uploaderId,
        safeName,
        input.mimeType || "application/octet-stream",
        input.data.byteLength,
        storagePath,
        now,
      );
    return this.getAttachment(id)!;
  }

  getAttachment(attachmentId: string): VlAttachment | null {
    const row = this.db.prepare("SELECT * FROM vl_attachments WHERE id = ?").get(attachmentId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      roomId: String(row.room_id),
      uploaderId: String(row.uploader_id),
      filename: String(row.filename),
      mimeType: String(row.mime_type),
      sizeBytes: Number(row.size_bytes),
      storagePath: String(row.storage_path),
      createdAt: Number(row.created_at),
    };
  }

  private mapPluginState(row: Record<string, unknown>): VlPluginDbState {
    return {
      id: String(row.id),
      enabled: Number(row.enabled ?? 1) === 1,
      config: parseJsonObject(row.config_json),
      lastSyncAt: row.last_sync_at == null ? null : Number(row.last_sync_at),
      lastError: row.last_error == null ? null : String(row.last_error),
      updatedAt: Number(row.updated_at),
    };
  }

  getPluginState(pluginId: string): VlPluginDbState | null {
    const row = this.db.prepare("SELECT * FROM vl_plugins WHERE id = ?").get(pluginId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapPluginState(row) : null;
  }

  listPluginStates(): ReadonlyArray<VlPluginDbState> {
    const rows = this.db.prepare("SELECT * FROM vl_plugins ORDER BY id ASC").all() as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => this.mapPluginState(row));
  }

  upsertPluginState(input: {
    readonly id: string;
    readonly enabled?: boolean;
    readonly config?: Record<string, unknown>;
    readonly lastSyncAt?: number | null;
    readonly lastError?: string | null;
  }): VlPluginDbState {
    const existing = this.getPluginState(input.id);
    const now = Date.now();
    const enabled = input.enabled !== undefined ? input.enabled : (existing?.enabled ?? true);
    const config = input.config !== undefined ? input.config : (existing?.config ?? {});
    const lastSyncAt =
      input.lastSyncAt !== undefined ? input.lastSyncAt : (existing?.lastSyncAt ?? null);
    const lastError =
      input.lastError !== undefined ? input.lastError : (existing?.lastError ?? null);
    this.db
      .prepare(
        `INSERT INTO vl_plugins (id, enabled, config_json, last_sync_at, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           last_sync_at = excluded.last_sync_at,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`,
      )
      .run(input.id, enabled ? 1 : 0, JSON.stringify(config), lastSyncAt, lastError, now);
    return this.getPluginState(input.id)!;
  }
}
