# VibeLink 当前待办

最后更新：2026-07-29

## P1 产品阻塞

- [ ] PBUG-001：为 Rust-only 空数据目录补完整、幂等 bootstrap，并新增首次启动 API + browser smoke。
- [ ] PBUG-002：缩短 search watcher SQLite 写事务，定义 busy 的可重试错误语义并补启动并发回归。

## P2/P3 产品缺陷

- [ ] PBUG-003：实现 Rust-only legacy `/api/login`，或同步撤销 ownership/OpenAPI/UI 声明。
- [ ] PBUG-004：修复配对卡片标题/说明的纵向间距，补桌面和移动视觉 smoke。

## P1 测试基础设施

- [x] TBUG-001：`f785213` 已修复 Rust HTTP 合同并发等待；2026-07-30 完成 20/20 轮并发门禁，0 timeout，已关闭。
- [x] TBUG-002：2026-07-30 已移除 linker 猜测并恢复 6 个真实 workspace Rust 测试；缺失/CI fail-closed/显式 opt-out 均有回归覆盖。
- [ ] TBUG-003：统一 canary binary provenance，拒绝陈旧 release 和 debug 性能误判。

## P2 质量门禁

- [ ] QG-001：把 execution-host ignored 集成测试接入 focused CI。
- [ ] QG-002：清理 Android 弃用 API 与 unchecked cast 告警。

## 发布证据

- [ ] QG-003：归档真实 Provider、自然 MCP/豁免、终端恢复、弱网 Live Call 和 Android 设备证据。
- [ ] QG-004：`v0.1.1` bundle gate 已实现；完成同 commit 的 ZIP/SBOM/audit/rollback 验证后创建 tag 与 GitHub Preview release。
- [ ] QG-005：在稳定发布后按可逆 slice 退役 hybrid Node 兼容源码。

## 待产品决策

- [ ] FG-001：原生 iOS 还是移动 Web/PWA。
- [ ] FG-002：Codex Desktop Remote 目标是可靠遥控还是完整状态镜像。
- [ ] FG-003：Workspace 是否内置远端协议与离线同步。

详细证据、修复方案、验收和并行策略见 `docs/bug-and-feature-gaps.md`。
