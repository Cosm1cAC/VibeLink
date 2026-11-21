# VibeLink v3

个人自用的「QQ 风格即时通讯 + Bot 代理与多 Bot 群协作」一体化桌面与移动端系统：

- **单 Bot = QQ 好友**：独立 `Bot Home` 目录（`bot.json` / `SOUL.md` / `MEMORY.md` / `skills/` / `tools.json`）、流式对话、模型与引擎切换、Chat ⇄ 原始 CLI 终端（PTY）无损切换、Run Checkpoint 一键 Diff/回滚。
- **Bot 协作 = QQ 群**：真人与多 Bot 同处一群，配备吸顶群公告、右侧「群公告须知 + 在线成员实时状态栏」、Markdown AST `@Bot` 接力防死循环、标准 HTTP MCP 编排（`delegate_task` + `ContextHandoff`）以及 Git Worktree 隔离。
- **真 IM 通讯**：个人多设备及受邀好友共享统一 SQLite `Room / Message / ReadCursor` 模型，支持文本、富媒体、截图（含隐藏当前窗口）、文件、引用、撤回、已读与增量断线重连。

## 目录结构

| 目录 | 说明 |
| --- | --- |
| `client/` | 桌面与移动端前端（二开自 `HuLaSpark/HuLa`，Tauri 2 + Vue 3 + Naive UI） |
| `server/` | 统一控制面与 Bot/协作后端（二开自 `pingdotgg/t3code`，融合 `stablyai/orca` Bot 底层） |
| `seeds/` | 预置 Bot 车队与默认群聊种子配置（`bots_fleet.seed.json`） |
| `docs/` | 架构设计、上游参考与版本记录 |
| `scripts/` | 本地一键启停与验证脚本 |

> 本机运行态目录 `wproxy/`、`opencode-mesh/`、`rshell/`、`keys/` 原地保留并由 `.gitignore` 忽略，与新版应用解耦运行。
