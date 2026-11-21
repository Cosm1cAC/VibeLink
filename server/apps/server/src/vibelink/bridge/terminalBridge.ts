// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import type { TerminalAttachStreamEvent } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type * as TerminalManager from "../../terminal/Manager.ts";
import type { VibeLinkDatabase } from "../db.ts";
import { VibeLinkError } from "../types.ts";

export interface VlTerminalSessionInfo {
  readonly sessionId: string;
  readonly threadId: string;
  readonly terminalId: string;
  readonly roomId: string | null;
  readonly botId: string | null;
  readonly cwd: string;
  readonly createdAt: number;
}

export class VibeLinkTerminalBridge {
  private readonly db: VibeLinkDatabase;
  private readonly terminalManager: TerminalManager.TerminalManager["Service"] | null;
  private readonly sessions = new Map<string, VlTerminalSessionInfo>();

  constructor(
    db: VibeLinkDatabase,
    terminalManager: TerminalManager.TerminalManager["Service"] | null,
  ) {
    this.db = db;
    this.terminalManager = terminalManager;
  }

  listSessions(roomId?: string | null): ReadonlyArray<VlTerminalSessionInfo> {
    const all = [...this.sessions.values()];
    return roomId ? all.filter((s) => s.roomId === roomId) : all;
  }

  getSession(sessionId: string): VlTerminalSessionInfo | null {
    return this.sessions.get(sessionId) ?? null;
  }

  private resolveSafeCwd(requested?: string | null): string {
    const candidate = requested?.trim();
    if (candidate && NodeFS.existsSync(candidate) && NodeFS.statSync(candidate).isDirectory()) {
      return candidate;
    }
    return process.cwd();
  }

  openSession(input: {
    readonly roomId?: string | null;
    readonly botId?: string | null;
    readonly cwd?: string | null;
    readonly cols?: number;
    readonly rows?: number;
  }): Effect.Effect<VlTerminalSessionInfo, VibeLinkError> {
    const bridge = this;
    return Effect.gen(function* () {
      const room = input.roomId ? bridge.db.getRoom(input.roomId) : null;
      const bot = input.botId ? bridge.db.getAccount(input.botId) : null;
      const binding =
        input.roomId && input.botId
          ? bridge.db.getRoomBotThread(input.roomId, input.botId)
          : input.roomId
            ? bridge.db.listRoomBotThreads(input.roomId)[0] ?? null
            : null;
      const cwd = bridge.resolveSafeCwd(
        input.cwd ?? binding?.worktreePath ?? bot?.cwd ?? room?.cwd,
      );
      const sessionId = `vlterm_${NodeCrypto.randomUUID().slice(0, 12)}`;
      const threadId = binding?.threadId ?? (input.roomId ? `vl_room:${input.roomId}` : sessionId);
      const terminalId = sessionId;

      if (bridge.terminalManager) {
        yield* bridge.terminalManager
          .open({
            threadId,
            terminalId,
            cwd,
            worktreePath: binding?.worktreePath ?? null,
            cols: input.cols ?? 100,
            rows: input.rows ?? 30,
          })
          .pipe(Effect.mapError((cause) => new VibeLinkError({ message: String(cause) })));
      }

      const info: VlTerminalSessionInfo = {
        sessionId,
        threadId,
        terminalId,
        roomId: input.roomId ?? null,
        botId: input.botId ?? null,
        cwd,
        createdAt: yield* Clock.currentTimeMillis,
      };
      bridge.sessions.set(sessionId, info);
      bridge.db.appendEvent("terminal.opened", info.roomId, { session: info });
      return info;
    });
  }

  attachSession(
    sessionId: string,
    viewerId: string,
    onEvent: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
  ): Effect.Effect<() => void, VibeLinkError> {
    const info = this.sessions.get(sessionId);
    if (!info) {
      return Effect.fail(new VibeLinkError({ message: `Terminal session not found: ${sessionId}` }));
    }
    if (!this.terminalManager) {
      return Effect.sync(() => () => undefined);
    }
    return this.terminalManager
      .attachStream(
        {
          threadId: info.threadId,
          terminalId: info.terminalId,
          cwd: info.cwd,
          resume: true,
        },
        onEvent,
        undefined,
        viewerId,
      )
      .pipe(Effect.mapError((cause) => new VibeLinkError({ message: String(cause) })));
  }

  write(sessionId: string, data: string, viewerId?: string): Effect.Effect<void, VibeLinkError> {
    const info = this.sessions.get(sessionId);
    if (!info) {
      return Effect.fail(new VibeLinkError({ message: `Terminal session not found: ${sessionId}` }));
    }
    if (!this.terminalManager || data.length === 0) {
      return Effect.void;
    }
    return this.terminalManager
      .write({ threadId: info.threadId, terminalId: info.terminalId, data }, viewerId)
      .pipe(Effect.mapError((cause) => new VibeLinkError({ message: String(cause) })));
  }

  resize(
    sessionId: string,
    cols: number,
    rows: number,
    viewerId?: string,
  ): Effect.Effect<void, VibeLinkError> {
    const info = this.sessions.get(sessionId);
    if (!info) {
      return Effect.fail(new VibeLinkError({ message: `Terminal session not found: ${sessionId}` }));
    }
    if (!this.terminalManager) {
      return Effect.void;
    }
    return this.terminalManager
      .resize(
        {
          threadId: info.threadId,
          terminalId: info.terminalId,
          cols: Math.max(10, Math.min(1000, Math.round(cols))),
          rows: Math.max(4, Math.min(500, Math.round(rows))),
        },
        viewerId,
      )
      .pipe(Effect.mapError((cause) => new VibeLinkError({ message: String(cause) })));
  }

  clear(sessionId: string): Effect.Effect<void, VibeLinkError> {
    const info = this.sessions.get(sessionId);
    if (!info) {
      return Effect.fail(new VibeLinkError({ message: `Terminal session not found: ${sessionId}` }));
    }
    if (!this.terminalManager) {
      return Effect.void;
    }
    return this.terminalManager
      .clear({ threadId: info.threadId, terminalId: info.terminalId })
      .pipe(Effect.mapError((cause) => new VibeLinkError({ message: String(cause) })));
  }

  closeSession(sessionId: string): Effect.Effect<boolean, VibeLinkError> {
    const info = this.sessions.get(sessionId);
    if (!info) {
      return Effect.succeed(false);
    }
    this.sessions.delete(sessionId);
    const bridge = this;
    return Effect.gen(function* () {
      if (bridge.terminalManager) {
        yield* bridge.terminalManager
          .close({ threadId: info.threadId, terminalId: info.terminalId })
          .pipe(Effect.ignore);
      }
      bridge.db.appendEvent("terminal.closed", info.roomId, { sessionId });
      return true;
    });
  }
}
