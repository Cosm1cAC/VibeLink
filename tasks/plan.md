# VibeLink 缺口收敛计划

最后更新：2026-07-28

## 目标

以 `docs/bug-and-feature-gaps.md` 为唯一缺口入口，先恢复测试证据可信度，再补质量与发布证据，最后决定兼容源码退役和新平台功能。Rust 产品所有权迁移已经完成，不再把已完成 route family 写成待迁任务。

## 阶段 1：测试基线可信化

1. **TBUG-001 Rust HTTP 并发超时**
   - 写出可控并发的失败回归测试。
   - 修复 listener/thread/ready 同步或增加最小粒度资源锁。
   - 并发循环 20 次、隔离合同和默认 `cargo test` 全部通过。
2. **TBUG-002 Cargo 探测误判**
   - 删除 `link.exe` 推断式前置检查，改用 Cargo 实际探测。
   - 当前 Windows 环境恢复 6 个真实 workspace 测试。
   - CI 对非显式允许的 skip fail-closed。
3. **TBUG-003 陈旧 release binary**
   - 为 canary 统一显式 binary/provenance 规则。
   - 陈旧 binary fail-fast，debug binary 不参与 release 性能判断。

三项可以并行开发；TBUG-002/003 共享测试辅助层，由一个 integration owner 统一接口和合并顺序。

## 阶段 2：质量门禁

1. 把 execution-host ignored 集成测试接入“构建一次、合同与 canary 复用一次”的 focused workflow。
2. 清理 Android Notification/Compose 弃用 API 与 unchecked cast，不使用全局 suppress。
3. 重跑 Node、Rust、Clippy、Android、浏览器和 ownership gates。

Android 工作与 Rust 测试修复可完全并行；execution-host gate 依赖 TBUG-003。

## 阶段 3：运行与发布证据

并行收集四类脱敏 evidence：

- 真实 Provider 长任务与 resume/input/stop。
- 自然 MCP 会话；不可用时记录明确 prerequisite 与豁免。
- terminal/approval 崩溃恢复和弱网 Live Call。
- Android 物理设备 pairing、通知、麦克风与断线恢复。

证据满足或由 release owner 明确豁免后，构建同 commit 的 Rust-only 与 hybrid rollback ZIP，执行升级/回滚 smoke。

## 阶段 4：正式发布

由单一 release owner 串行生成 manifest、依赖审计、校验和、release notes 和 tag。tag、包内 commit、manifest、SHA-256 与发布说明必须完全一致。

## 阶段 5：兼容源码退役

在稳定 Rust-only release 和 rollback artifact 存在后，按 route family/后台职责小批次删除 hybrid Node 兼容源码。每批必须保持 shared fixtures、OpenAPI、ownership gate、Web/Android E2E 和 hybrid rollback smoke 通过。

## 独立产品设计轨

iOS、Codex Desktop Remote 完整状态保真、Workspace 远端协议/离线同步只进入 discovery/ADR，不与缺陷修复混排。产品确认目标用户、成功指标和范围后，再建立实现计划。

## 完成标准

- `docs/bug-and-feature-gaps.md` 中 TBUG 项有回归测试并关闭。
- 目标 Android 告警清零，execution-host 集成测试不再只靠 ignored 状态。
- release evidence 的未执行项都有明确 prerequisite/豁免，不把环境缺口伪装成 Bug。
- 正式 tag 与可复现产物完全对齐。
- 功能候选只有在产品决策后才转入开发。
