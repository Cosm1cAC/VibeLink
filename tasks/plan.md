# VibeLink 缺口收敛计划

最后更新：2026-07-29

## 目标

以 `docs/bug-and-feature-gaps.md` 为唯一缺口入口，先关闭 Rust-only 首次启动和 SQLite 并发两个产品阻塞，再恢复测试证据可信度，补质量与发布证据，最后决定兼容源码退役和新平台功能。Rust 产品所有权迁移已经完成，但运行健康度尚未达到发布标准。

## 阶段 1：Rust-only 产品阻塞

1. **PBUG-001 空目录 bootstrap**
   - 冻结 settings/schema/bootstrap 的幂等入口和未就绪错误语义。
   - 在监听前完成必需数据结构初始化，不依赖 Node 或预置 smoke fixture。
   - 空目录 API、重复启动、升级数据和真实浏览器配对全部通过。
2. **PBUG-002 search watcher/SQLite 锁**
   - 将逐文件 metadata/content 读取移出 `BEGIN IMMEDIATE`，写入改为短批次和有界退避；workspace 路径收集已经在事务外，不重复搬迁。
   - database busy 返回可重试 503，不得在 Rust-only 中伪装成 404。
   - 真实 workspace 启动期间并发预期成功的 pairing/status/devices/settings/task 20 轮无非业务 404/500，并记录锁持有时间。

两项共享 Rust 启动、SQLite migration 和 frontdoor 错误合同。先由单一 owner 冻结接口；之后 watcher 事务、route 错误映射和集成测试可分支并行，但按 bootstrap -> watcher -> frontdoor -> browser gate 顺序合并。

## 阶段 2：测试基线可信化

1. **TBUG-001 Rust HTTP 并发超时（已关闭）**
   - `f785213` 已加入确定性 framing、ready 信号和有界线程等待。
   - 2026-07-30 并发循环 20/20、隔离合同 15/15 和默认 `cargo test`（199 passed、0 failed、1 ignored）全部通过，已移入关闭记录。
2. **TBUG-002 Cargo 探测误判**
   - 删除 `link.exe` 推断式前置检查，改用 Cargo 实际探测。
   - 当前 Windows 环境恢复 6 个真实 workspace 测试。
   - CI 对非显式允许的 skip fail-closed。
3. **TBUG-003 陈旧 release binary**
   - 为 canary 统一显式 binary/provenance 规则。
   - 陈旧 binary fail-fast，debug binary 不参与 release 性能判断。

三项可以并行开发；TBUG-002/003 共享测试辅助层，由一个 integration owner 统一接口和合并顺序。

## 阶段 3：兼容与质量门禁

1. 实现 Rust-only legacy `/api/login`；若决定删除兼容能力，则同步撤销 route ownership、OpenAPI 和 Web UI。
2. 修复 pairing card 标题/说明布局并补桌面/移动视觉 smoke。
3. 把 execution-host ignored 集成测试接入“构建一次、合同与 canary 复用一次”的 focused workflow。
4. 清理 Android Notification/Compose 弃用 API 与 unchecked cast，不使用全局 suppress。
5. 重跑 Node、Rust、Clippy、Android、浏览器和 ownership gates。

PBUG-003、PBUG-004 和 Android 工作可完全并行；execution-host gate 依赖 TBUG-003。PBUG-003 合并前必须确认 PBUG-001/002 的 bootstrap 和 busy 合同稳定。

## 阶段 4：运行与发布证据

并行收集四类脱敏 evidence：

- 真实 Provider 长任务与 resume/input/stop。
- 自然 MCP 会话；不可用时记录明确 prerequisite 与豁免。
- terminal/approval 崩溃恢复和弱网 Live Call。
- Android 物理设备 pairing、通知、麦克风与断线恢复。

证据满足或由 release owner 明确豁免后，构建同 commit 的 Rust-only 与 hybrid rollback ZIP，执行升级/回滚 smoke。

## 阶段 5：正式发布

由单一 release owner 串行生成 manifest、依赖审计、校验和、release notes 和 tag。tag、包内 commit、manifest、SHA-256 与发布说明必须完全一致。

## 阶段 6：兼容源码退役

在稳定 Rust-only release 和 rollback artifact 存在后，按 route family/后台职责小批次删除 hybrid Node 兼容源码。每批必须保持 shared fixtures、OpenAPI、ownership gate、Web/Android E2E 和 hybrid rollback smoke 通过。

## 独立产品设计轨

iOS、Codex Desktop Remote 完整状态保真、Workspace 远端协议/离线同步只进入 discovery/ADR，不与缺陷修复混排。产品确认目标用户、成功指标和范围后，再建立实现计划。

## 完成标准

- PBUG-001/PBUG-002 有失败回归、修复和真实浏览器证据，Rust-only 首次启动与启动并发不再阻断发布。
- PBUG-003/PBUG-004 按各自兼容/视觉验收关闭。
- `docs/bug-and-feature-gaps.md` 中 TBUG 项有回归测试并关闭。
- 目标 Android 告警清零，execution-host 集成测试不再只靠 ignored 状态。
- release evidence 的未执行项都有明确 prerequisite/豁免，不把环境缺口伪装成 Bug。
- 正式 tag 与可复现产物完全对齐。
- 功能候选只有在产品决策后才转入开发。
