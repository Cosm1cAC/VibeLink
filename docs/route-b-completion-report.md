# Route B (VibeLink CLI Runtime) 完成度报告

> 基线：`reference/cli-analysis/`（Claude Code 泄露源码分析）
> 对齐计划：`docs/cli-capability-alignment-plan.md`
> 最后更新：2026-07-06

---

## 1. 基线概要

`reference/cli-analysis` 描述了一套完整六层本地 Agent 运行时：

```
CLI 引导层 → TUI/REPL 交互层 → Query/Agent 执行内核
  → Tool/Permission 层 → Memory/Persistence 层 → 扩展层（MCP/Remote/Swarm）
```

关键特征：
- 统一 Tool Runtime：工具注册表、schema、权限、进度、结果、UI 数据
- 结构化 Memory/Session：append-only transcript、metadata tail、sidechain、恢复
- 多层权限：命令/文件/网络/MCP/子 Agent 各有 allow/ask/deny
- 沙箱策略：workspace → 只读/可写/网络 → runtime config
- 上下文预算器：summary token、压缩、状态再注入
- 多 Agent：主 agent、子 agent、mailbox、权限桥接

VibeLink 的 **Route B** 定位是"自行起停 CLI Agent 子进程，管理和归档其事件流"——不是替代 Claude CLI/Codex CLI，而是与之并存、作为移动端的确定性运行时后端。

---

## 2. 能力对齐矩阵（逐项评估）

### 2.1 统一 Tool Runtime

| 参考模式 | VibeLink 状态 | 完成度 |
|---------|--------------|--------|
| 工具注册表 + schema + permission + progress/result/render | `src/toolRegistry.js` + `src/toolRuntime.js` 已落地，定义 `kind`、`permissionDomain`、`riskCategory`、`schema`、`uiLabel` | **P0 ✅ 完成** |
| tool created/started/progress/output/result/error 生命周期 | tool_events 表有 `lifecycle` 字段 (`created|started|completed|failed|cancelled|expired`) | **P0 ✅ 完成** |
| 所有调用走同一生命周期 | Shell/Git/GitFile/MCP probe/Doctor/Browser fetch/Desktop probe/Codex app-server probe 已接入 | **P0 ✅ 完成** |
| agent stream-json 工具调用自动映射 | `agentToolBridge.js` 从 stream-json 提取 `function_call`、`tool_use`、`tool_call`、`custom_tool_call`、`mcp_tool_call_end`、`patch_apply_end` 等，归类映射 | **P0 ✅ 完成** |
| 历史 JSONL 映射为 Tool Card | `historyToolBridge.js` 用确定性 id 幂等导入 | **P0 ✅ 完成** |

**未完成**：前端 tool card 渲染仍部分依赖文本推断；tool output 摘要和折叠策略需前端扩展。

### 2.2 持久化逐条审批

| 参考模式 | VibeLink 状态 | 完成度 |
|---------|--------------|--------|
| tool call 运行前创建审批请求 | `toolRuntime.js` 对所有网络/破坏性/特权命令创建 `approval_requests` | **P0 ✅ 完成** |
| 用户同意后继续原调用 | `/api/approvals/:id/decision` + 原 tool run 恢复执行 | **P0 ✅ 完成** |
| 拒绝后 tool run 标记 rejected | 已实现 | **P0 ✅ 完成** |
| SQLite `approval_requests` 表 | 已落地，含多设备决策 | **P0 ✅ 完成** |
| 审批过期同步 | expired tool event + tool run `expired` 状态 | **P0 ✅ 完成** |
| 服务重启后审批仍存在 | SQLite 持久化，重启后可恢复 | **P0 ✅ 完成** |
| Settings 面板 pending approvals | 前端 Settings 安全面板显示 | **P0 ✅ 完成** |

**未完成**：SSE/Push 通知推送、手机 approve/deny（需先有 push 通道）、审批批量操作。

### 2.3 命令执行与 PTY

| 参考模式 | VibeLink 状态 | 完成度 |
|---------|--------------|--------|
| 流式输出 stdout/stderr | workspace shell/test 已通过 spawn + tool_events 流式输出 | **P0 ✅ 完成** |
| 后台运行 + tool-run 级停止 | `/api/tool-runs/:id/stop` 支持 | **P0 ✅ 完成** |
| tool-run 完成回填 | 前端轮询兜底 | **P0 ✅ 完成** |
| 策略型沙箱权限分类 | `commandSafety.js` 分 `read-only`/`workspace-write`/`network`/`destructive`/`privileged` | **P0 ✅ 完成** |
| PTY 会话 | `terminalRuntime.js` + `/api/workspaces/:id/terminal-session` 已落地 | **P0 ✅ 完成** |
| PTY 降级 | `node-pty` 不可用时自动降级到 pipe-based spawn | **P0 ✅ 完成** |

**未完成**：
- 前端完整 xterm/ANSI 终端视图 ⬜
- `node-pty` 作为可选原生依赖打包 ⬜
- 跨平台更强沙箱后端（WSL/bwrap/Windows job object）⬜

### 2.4 沙箱与安全

| 参考模式 | VibeLink 状态 | 完成度 |
|---------|--------------|--------|
| 权限上下文 → FS/network runtime config | `resolveAllowedPath`、`allowedRoots`、`allowlist`、`securityPolicy` | **P0 ✅ 完成** |
| trusted workspace | `security.requireTrustedWorkspace` + 审批 | **P0 ✅ 完成** |
| doctor/诊断 | `/api/doctor` 聚合 Node、SQLite、凭据、模型 key、Git/gh、Desktop、沙箱 | **P0 ✅ 完成** |
| 策略型沙箱 vs 原生后端 | doctor 区分 policy-only 与 native-enforced | **P0 ✅ 完成** |
| 网络权限控制 | `commandSafety.js` 检测网络模式 → 审批或阻止 | **P0 ✅ 完成** |

**未完成**：Windows job object、WSL、bwrap、mac sandbox 等原生后端（当前为 policy-only）。

### 2.5 会话事件与恢复

| 参考模式 | VibeLink 状态 | 完成度 |
|---------|--------------|--------|
| append-only transcript | `task_events` 表 + `tool_events` 表 | **P0 ✅ 完成** |
| cursor + SSE 恢复 | tool_events cursor 查询 + SSE/SSE catch-up | **P0 ✅ 完成** |
| 历史 JSONL 导入 | `historyToolBridge.js` 幂等导入 | **P0 ✅ 完成** |
| Live Call 持久化 | `live_calls` + `live_call_events` 表 + `restoreLiveCallSessions()` | **P1 ✅ 完成 (本次)** |

**未完成**：
- turn/block/metadata/artifact/approval 分层合并到统一 session event log ⬜
- 恢复时校准 task 状态（重建 turn/block/tool_run 关系）⬜
- 标记 incomplete/orphaned 事件 ⬜

### 2.6 上下文预算与压缩

| 参考模式 | VibeLink 状态 | 完成度 |
|---------|--------------|--------|
| 预算器 | 未实现 | **P1 ⬜** |
| 自动 compact | 未实现 | **P1 ⬜** |
| summary 事件 | 未实现 | **P1 ⬜** |
| 状态再注入 | 未实现 | **P1 ⬜** |

### 2.7 Workspace / Git 工作流

| 参考模式 | VibeLink 状态 | 完成度 |
|---------|--------------|--------|
| 文件树/文件打开/只读限制 | workspace API + UI 文件树 | **✅ 基本** |
| Git status/diff/stage/commit/push/pull/PR | workspace git API 已落地 | **✅ 基本** |
| Git per-hunk stage/unstage | 只有文件级 stage，无 hunk 级 | **P1 ⬜** |
| branch/stash/worktree/冲突向导 | 未实现 | **P1 ⬜** |
| 文件编辑事件与审批接入 | 无文件编辑 API（只有 git 通道） | **P1 ⬜** |

### 2.8 MCP / Plugin / Skill 管理

| 参考模式 | VibeLink 状态 | 完成度 |
|---------|--------------|--------|
| MCP server 配置与连接 | `mcpRuntime.js` + Settings 配置 | **✅ 基本** |
| tools/list 探测 | stdio/http server 探测 | **✅ 基本** |
| 规范化为 VibeLink 工具名 | `mcp__server__tool` 命名 | **✅ 基本** |
| 健康检查/审计/doctor | 已接入 | **✅ 基本** |
| MCP 工具调用走 tool runtime | 通过 agentToolBridge 映射 | **✅ 基本** |

### 2.9 浏览器 Runtime

| 参考模式 | VibeLink 状态 | 完成度 |
|---------|--------------|--------|
| HTTP/HTTPS 页面抓取 | `browserRuntime.js` 已落地 | **P0 ✅ 完成** |
| 标题/描述/文本摘要 | 已实现 | **P0 ✅ 完成** |
| 大小/超时限制 | 已实现 | **P0 ✅ 完成** |
| 网络权限审批 | 已接入 | **P0 ✅ 完成** |
| Settings 手动抓取入口 | 已实现 | **P0 ✅ 完成** |

**未完成**：页面会话、点击/输入、截图、下载、cookie/登录态隔离、域名 allow/deny 策略 ⬜

### 2.10 多 Agent / 子任务

**状态**：**P2 ⬜ 未开始**

### 2.11 Memory / 项目知识

**状态**：**P2 ⬜ 未开始**

### 2.12 CLI 命令面板 / Slash Commands

**状态**：**P1 ⬜ 未系统化**（已有部分 slash commands，无统一注册表）

---

## 3. Phase 完成度统计

### Phase 0（运行时骨架）

| 子项 | 完成度 |
|------|--------|
| tool_runs / tool_events / approval 表 | **100%** |
| toolRuntime.js | **100%** |
| workspace shell/test 接入持久审批 | **100%** |
| 审批决策接口 + 过期 | **100%** |
| Git/GitFile 接入 tool_runs | **100%** |
| /api/approvals / /api/tool-runs / /api/tool-events | **100%** |
| toolRegistry.js | **100%** |
| Settings 审批面板 | **100%** |
| 前端 tool card（task/workspace/toolRun） | **100%** |
| agent stream-json 工具映射（agentToolBridge.js） | **100%** |
| 历史 JSONL 导入（historyToolBridge.js） | **100%** |
| tool_events 生命周期字段 | **100%** |
| tool event retention + prune | **100%** |
| /api/doctor | **100%** |
| Desktop/Codex probe 迁移到统一 runtime | **100%** |
| MCP runtime | **100%** |
| browser.fetch runtime | **100%** |
| **Phase 0 整体** | **~95%** |

### Phase 1（PTY 与沙箱策略）

| 子项 | 完成度 |
|------|--------|
| spawn 流式执行 + tool.output | **100%** |
| 后台运行 + tool-run 级停止 | **100%** |
| 单个 tool run 详情读取 | **100%** |
| 网络权限审批 | **100%** |
| trusted workspace 审批 | **100%** |
| 策略型 sandbox 权限分类 | **100%** |
| 沙箱 doctor | **100%** |
| 终端 runtime doctor | **100%** |
| task_events 同步写入 | **100%** |
| PTY terminal session API | **100%** |
| node-pty 降级 | **100%** |
| SQLite 持久化 + 重启恢复 | **100%** |
| **Phase 1 整体** | **~85%** |
| 待补：前端 xterm/ANSI 视图 | ⬜ |
| 待补：node-pty 可选依赖打包 | ⬜ |
| 待补：跨平台沙箱后端 | ⬜ |

### Phase 2（会话恢复与上下文预算）

| 子项 | 完成度 |
|------|--------|
| task_events / tool_events cursor + SSE | **100%** |
| Live Call 持久化 | **100%** (本日新增) |
| turn/block/tool_run 关系重建 | ⬜ |
| token budget 估算 | ⬜ |
| 自动 summary | ⬜ |
| 状态再注入 | ⬜ |
| **Phase 2 整体** | **~20%** |

### Phase 3–5

| Phase | 完成度 |
|-------|--------|
| 3: Workspace/Git/测试工作流 | ~40%（基础 Git 有，hunk/stash/冲突/测试历史无） |
| 4: CLI 生态能力 | ~40%（MCP/doctor 有，command registry/plugin 管理无） |
| 5: 多 Agent | **0%** |

---

## 4. 关键差距汇总

### 已完成（可投入产品化）

| 能力 | 对应文件 |
|------|---------|
| Tool Runtime 生命周期 | `src/toolRuntime.js`, `src/toolRegistry.js` |
| Agent tool 映射 | `src/agentToolBridge.js` |
| 历史 tool event 导入 | `src/historyToolBridge.js` |
| 持久审批 | SQLite `approval_requests` + `/api/approvals/:id/decision` |
| 策略型沙箱 + 权限分类 | `src/commandSafety.js` |
| 流式命令执行 + 停止 | workspace shell/test + `/api/tool-runs/:id/stop` |
| PTY 终端会话 | `src/terminalRuntime.js` |
| MCP 管理 | `src/mcpRuntime.js` |
| 浏览器抓取 | `src/browserRuntime.js` |
| Doctor | `/api/doctor` |
| Live Call 完整管线 | `src/liveCall*.js` + SQLite + WebSocket + whisper.cpp |
| 第三方 API Key 支持 | 智谱 zhipu |

### 未完成（在路线图上）

| 能力 | 目标 Phase | 优先级 |
|------|-----------|--------|
| 前端 ANSI 终端视图 | P1 | 中 |
| cross-platform 沙箱后端 | P1 | 中 |
| 会话 turn/block 重建 | P2 | 高 |
| token budget 估算 | P2 | 中 |
| per-hunk Git stage/stash/conflict | P3 | 中 |
| 浏览器操作（点击/表单/截图） | P3 | 低 |
| command registry | P4 | 低 |
| 多 Agent / 子任务 | P5 | 低 |
| Memory / 项目知识 | P2 | 低 |

### 与参考实现的本质差异

| 维度 | Claude Code | VibeLink Route B |
|------|------------|-----------------|
| 交互层 | TUI (ink React) | Web UI (React) |
| 执行方式 | 进程内 Query Engine | 子进程 spawn + SSE 代理 |
| 本地持久化 | JSONL 文件 | SQLite |
| 远程接入 | built-in bridge | HTTP API + WebSocket |
| 移动端 | 无 | 第一公民 |
| 审批 | 终端内交互 | 跨设备 HTTP + SSE |
| 平台 | macOS/Linux 优先 | Windows 优先 |

---

## 5. 结论

**Route B 的运行时骨架（Phase 0）已基本完成。** VibeLink 具备了独立的 tool runtime、审批、沙箱策略、流式命令执行、PTY、MCP、Browser fetch、Doctor 等能力——虽然没有 Claude Code 的 TUI 和进程内 Query Engine，但在**结构化事件、持久审批、跨设备操作、Windows 优先**这些维度上建立了自己的优势。

**当前 Route B 路线图的完成度估算：**

```
Phase 0 (运行时骨架)    ■■■■■■■■■□  95%
Phase 1 (PTY/沙箱)      ■■■■■■■□□□  85%
Phase 2 (会话恢复)       ■■□□□□□□□□  20%
Phase 3 (Git 工作流)     ■■■■□□□□□□  40%
Phase 4 (CLI 生态)       ■■■■□□□□□□  40%
Phase 5 (多 Agent)       □□□□□□□□□□   0%

整体                    ■■■■■□□□□□  50%
```

**下一步最高价值项：**
1. 前端 ANSI 终端视图（解锁 PTY 体验闭环）
2. 会话 turn/block 重建（提升断线恢复质量）
3. token budget 估算（长任务不失控）
