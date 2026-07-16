# VibeLink Android Capability Matrix / VibeLink Android 能力矩阵

Status as audited on 2026-07-14.  审计日期：2026-07-14。

| Capability | Implementation | Existing automation | Audit result |
| --- | --- | --- | --- |
| Bridge URL and legacy token login | `LoginRouteScreen`, `ApiClient.login` | Bootstrapper unit tests plus device regression | Repaired: token field is masked and success navigation is forced onto the main thread. |
| QR/deep-link pairing | Pairing session create/poll/claim, CameraX QR scanner, `vibelink://pair` intent filter | Device regression added | Repaired: the single-top activity processes new pairing intents while already running. |
| Saved device-token restore | `SettingsStore`, `ApiClientConnectionBootstrapper` | JVM coverage | Implemented. |
| Logout | Session-list menu and `SettingsStore.clearSession` | Device regression added | Repaired: persisted and in-memory tokens are cleared before main-thread navigation. |
| System share into composer | ACTION_SEND filters and prompt construction | Message formatting and device regressions | Repaired: shared content waits for authentication and is consumed once; running-app intents are handled through the single-top activity. |
| Session list/search/archive/pin/rename/fork | `SessionListScreen`, `SessionListViewModel`, thread APIs | Loader/error/route unit tests plus visible real-bridge smoke | Implemented; mutation actions still lack device-level regression coverage. |
| New/continue/stop Agent task | `MessageListScreen`, `MessageListViewModel`, task/SSE APIs | Reducer and approval handoff unit tests | Implemented; no real bridge E2E. Product still lacks queue/concurrency/retry administration. |
| Codex Desktop Remote | Status/focus/send/retry/clear APIs and transcript rendering | Send-policy and reducer unit tests | Implemented within documented UI-automation limitations; no stable protocol-level completion guarantee. |
| Composer attachments and message actions | Upload, shared content, edit/delete/regenerate, Markdown/code/file links | Content/reducer/layout unit tests | Implemented; no device-level keyboard/rotation/large-content coverage. |
| Workspace files | Tree, preview, create/edit/rename/delete | Diff/approval unit tests plus visible real-bridge read smoke | Implemented; product lacks large-file paging, rich binary preview, and mature batch/conflict handling. |
| Workspace Git/worktrees | Status/diff/file actions/branch/stash/worktree/common remote actions | Diff splitting unit test | Implemented common flows; product lacks PR review and complete worktree management. |
| Workspace test/command/PTY | Command and terminal-session APIs, approval handoff | Approval handoff unit tests | Implemented; test output remains generic and lacks Jest/Pytest/Vitest adapters and single-test rerun. |
| Settings/security/devices | Status, doctor, MCP, import/export, push, device revoke, audit | Section-target unit test plus visible real-bridge load smoke | Implemented; save/revoke/import mutations still lack device-level regression coverage. |
| Approvals | Pending list, approve/deny, task and terminal handoff | JVM handoff tests | Implemented; tool-call continuation semantics remain a documented product P0 gap. |
| Tool events/SSE/recovery | Task/tool SSE, catch-up, polling policies | Reducer/resilience unit tests | Implemented; no long-running disconnect/reconnect instrumentation test. |
| Live Call | Session restore, events, ASR selection/checkpoints, pause/resume, mic service, local PCM list/delete, QA cards | QA reducer/resilience unit tests plus visible real-bridge smoke | UI/client implemented; real ASR and long-duration PCM stability/quality validation remain incomplete. |
| Notifications | Android 13+ permission policy and native token registration | JVM policy test | Implemented; no device-level permission regression. |
| Localization | Chinese/English string provider and setting | JVM string-selection test | Partial: several operational/status strings remain hard-coded Chinese. |
| Accessibility and UI automation | Compose semantics inherited from controls | Six Compose instrumentation regressions on API 36 | Critical auth/intent boundary is covered; broader keyboard, rotation, TalkBack, and screen-navigation coverage remains missing. |
| Browser control and test traces | None in Android | None | Missing product capability by design/status. |
| Plugins/Hooks/Automations/Subagents/AGENTS/config UI | None | None | Missing product capability. |
| Global command palette/full-text search/tags/favorites | Limited prompt command catalog and session search | Prompt catalog unit tests | Partial/missing product capability. |

## Repair Scope For This Audit / 本次审计修复范围

1. Make logout actually clear both persisted and in-memory authentication state.
2. Prevent shared content from bypassing login and process new VIEW/SEND intents while the activity remains alive.
3. Mask the pairing-token field.
4. Add repeatable device-level smoke automation for the login and intent-routing boundary.

The larger product gaps above require separate feature work and are not represented as completed by this audit.

## Automated Verification / 自动化验证

- JVM tests and debug APK build passed.
- Six Compose instrumentation tests passed on the visible `Codex_API_36` emulator.
- Temporary deep-link pairing against the real local bridge succeeded.
- Session list, Workspace, Live Call, and fully loaded Settings rendered without blank pages or incoherent overlap.
- Filtered runtime logs contained no VibeLink fatal exception or ANR.
- All temporary audit devices were revoked after the smoke run.

## 中文审计摘要 / Chinese Audit Summary

| 能力 | 审计结论 |
| --- | --- |
| Bridge 地址、旧 Token 登录 | 已修复：Token 字段掩码，登录后在主线程导航。 |
| QR 与深链配对 | 已修复：singleTop Activity 可处理运行中的新配对 Intent。 |
| 设备 Token 恢复、退出登录 | 已实现；退出时清除持久化和内存认证。 |
| 系统分享与消息编辑器 | 已修复：未登录不跳转，登录后恢复分享内容。 |
| 会话列表、搜索、归档、置顶、重命名、分叉 | 基础流程已实现，变更操作仍缺设备回归。 |
| Agent 任务 | 基础流程已实现，但仍缺任务队列、并发、重试管理，本次未做真实 Bridge E2E。 |
| Codex Desktop 远程 | 在已文档的 UI 自动化限制内已实现，缺稳定协议级完成保证。 |
| 编辑器附件与消息操作 | 已实现，缺键盘、旋转、大内容设备覆盖。 |
| Workspace 文件 | 基础读写与预览已实现，缺大文件分页、丰富二进制预览、批量与冲突处理。 |
| Workspace Git 与 Worktree | 常用流程已实现，缺 PR 审查与完整 Worktree 管理。 |
| Workspace 测试、命令、PTY | 已实现，但输出通用化，缺 Jest/Pytest/Vitest 适配器与单测试重跑。 |
| 设置、安全、设备 | 加载已经真实 Bridge 验证，保存、撤销、导入变更仍缺设备回归。 |
| 审批 | 已实现，工具调用续接语义仍是 P0 产品缺口。 |
| SSE、工具事件、恢复 | 已实现，缺长时断线/重连仪器测试。 |
| Live Call | UI 与客户端已实现，本地 PCM 列表/删除已有；真实 ASR 与长时稳定性仍未完成验证。 |
| 通知 | 已实现，缺 Android 权限设备回归。 |
| 本地化 | 部分实现，部分运行时状态文案仍硬编码为中文。 |
| 无障碍与 UI 自动化 | 关键认证/意图边界已覆盖，键盘、旋转、TalkBack 与更广导航仍缺覆盖。 |
| 浏览器控制与测试追踪 | Android 端尚缺失。 |
| 插件、Hook、自动化、Subagent、AGENTS 与配置 UI | Android 端尚缺失。 |
| 全局命令面板、全文搜索、标签、收藏 | 只有有限命令目录与会话搜索，整体仍属部分/缺失。 |
