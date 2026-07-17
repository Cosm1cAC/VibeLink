# VibeLink P0 执行接管与审批闭环 Todo

## Phase 0: Contract

- [ ] 评审并确认 P0 支持边界与非目标。
- [ ] 新增 durable execution host ADR。
- [ ] 定义 named-pipe v1 request/response/event/error contract。
- [ ] 定义 execution、attach、fidelity 和 approval delivery 状态机。
- [ ] 增加 Codex app-server schema/capability probe fixture。

## Checkpoint 0

- [ ] HTTP 兼容字段均为 additive/optional。
- [ ] 未支持 Provider 的降级语义明确。
- [ ] 人工批准架构后再开始实现。

## Phase 1: Persistence And Host

- [ ] 添加 `execution_bindings` migration 和 repository API。
- [ ] 添加 approval continuation 字段和 `approval_outbox`。
- [ ] 添加 event ingest + host cursor 原子事务。
- [ ] 实现 Rust `execd` mode 和 named-pipe handshake。
- [ ] 实现 manifest discovery 与 worker identity 校验。
- [ ] 实现 execution worker 与 Windows Job Object。
- [ ] 实现 ConPTY terminal backend。
- [ ] 实现 piped stdio command backend。
- [ ] 实现分段 event spool、ack、replay 和 quota marker。

## Checkpoint 1

- [ ] Parent/Bridge 停止时 worker 和 child 继续运行。
- [ ] `execd` 重启后重新连接同一个 worker/child PID。
- [ ] Worker crash 清理 child 并留下 `lost` 状态。
- [ ] Named-pipe ACL、forged manifest 和 PID reuse tests 通过。

## Phase 2: VibeLink-Owned Execution

- [ ] 新增 Node execution host client。
- [ ] 将 `terminalRuntime` 改为 execution host facade。
- [ ] 保持现有 Terminal HTTP endpoint 与 Android/Web contract。
- [ ] 迁移 Workspace streaming command、cancel 和 timeout。
- [ ] 迁移 Agent CLI spawn、stdout/stderr 和 exit status。
- [ ] 将运行中 Agent 输入改成 queued resume turn。
- [ ] 实现 startup reconciliation、event ingest 和 ack。
- [ ] 实现 attached/reconnecting/unreachable/lost/external 状态收敛。

## Checkpoint 2

- [ ] Terminal 在 Bridge/execd restart 后 input/resize/stop 正常。
- [ ] Workspace command 在 restart 后输出、取消和 exit code 正常。
- [ ] Agent CLI 在 restart 后事件无丢失无重复。
- [ ] Legacy 与 execution-host owner 混合运行和 rollback 正常。

## Phase 3: Codex Provider And Approval

- [ ] 实现 app-server version/schema capability gate。
- [ ] Worker 持有 app-server process 和 JSON-RPC connection。
- [ ] 归一化 thread/turn/item/tool/output/exit 事件。
- [ ] 映射 command execution approval request/response。
- [ ] 映射 file change approval request/response。
- [ ] 映射 permission request/grant scope。
- [ ] 实现 approval decision transactional outbox。
- [ ] 实现 continuationRef、available decisions 和 expected version 校验。
- [ ] 实现 decision recorded/delivered/applied/stale 状态。
- [ ] 验证 Bridge restart 后继续同一个上游 request 和 tool call。

## Checkpoint 3

- [ ] Duplicate decision 在存活 continuation 内去重。
- [ ] Worker crash 歧义窗口返回 `OUTCOME_UNKNOWN` 且不自动重放。
- [ ] Opposite/expired/stale/unreachable error tests 通过。
- [ ] Supported Codex version real canary 通过。
- [ ] Unsupported version 自动完整降级 CLI。

## Phase 4: Clients And Rollout

- [ ] Provider registry 返回 execution ownership、capability 和 fidelity。
- [ ] Web 展示权限增量、scope、可选决定和 delivery 状态。
- [ ] Android 展示权限增量、scope、可选决定和 delivery 状态。
- [ ] Web/Android 展示 attach/recovery 状态并限制非法操作。
- [ ] Desktop Remote 固定为 external/sample-only capability。
- [ ] 更新 product status、architecture、OpenAPI 和 Doctor。
- [ ] 增加 `off|canary|on` rollout flags。
- [ ] 执行 package、restart drill、rollback 和 public canary。

## Definition Of Done

- [ ] VibeLink 新执行均有稳定 owner、execution id、attach state 和真实退出状态。
- [ ] Bridge 与 `execd` 重启不改变 worker/child identity。
- [ ] Replay 无静默丢失、无重复，spool 超额有显式事件。
- [ ] Supported app-server approval 继续原调用，不重跑 tool。
- [ ] CLI/Desktop 不宣称 authoritative tool output 或 approval continuation。
- [ ] Focused Node/Rust/Web/Android tests、Windows package 和回滚演练全部通过。
