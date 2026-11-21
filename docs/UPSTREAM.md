# Upstream References & Attribution

VibeLink v3（仅个人使用，不商用）基于以下三个开源项目进行架构对标与二次开发：

1. **界面设计与即时通讯客户端外壳 — HuLa (`HuLaSpark/HuLa`)**
   - 仓库：https://github.com/HuLaSpark/HuLa
   - 许可证：Apache-2.0
   - 对标参考：`preview/img2-2.webp`（四栏 QQ NT 深色桌面交互、群公告须知与在线成员侧栏、截图隐藏窗口、拆分发送按钮、Tauri 2 + Vue 3 + Naive UI + Tauri Mobile 同源端架构）
   - 上游基座 Commit：`46b2945c7ac80d4affb2eac59802ea747d54def4`

2. **Bot 协作编排控制面 — T3 Code (`pingdotgg/t3code`)**
   - 仓库：https://github.com/pingdotgg/t3code
   - 许可证：MIT
   - 对标参考：`apps/server` Orchestration V2（SQLite 事件溯源 + Outbox、标准 HTTP MCP Server、Thread Lineage 与 `ContextHandoff`、Turn Checkpoint 回滚、多引擎 Provider 适配器、Remote/Tailscale 与 `node-pty` 终端）
   - 上游基座 Commit：`630f2e14440faa2a6a177cea1f280dae0a3ed9a8`

3. **Bot 底层设计参考 — Orca (`stablyai/orca`)**
   - 仓库：https://github.com/stablyai/orca
   - 许可证：MIT
   - 对标参考：`src/main/bots/` 目录即 Bot Home（`SOUL.md` / `MEMORY.md` / `skills/`）、记忆预算整理（`memory-tidy-up`）、零噪音定时巡检（`look-around`）、Markdown AST `@Name` 群交接与接力上限控制（`bot-group-mention-handoffs.ts`）、Hook 驱动的运行状态感知与 Chat/Terminal 互切。
