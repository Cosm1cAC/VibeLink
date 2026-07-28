# VibeLink 当前待办

最后更新：2026-07-28

## P1 测试基础设施

- [ ] TBUG-001：修复 Rust HTTP 合同并发超时，完成 20 轮并发回归。
- [ ] TBUG-002：修复 Cargo/linker 可用性误判，恢复 6 个真实 workspace Rust 测试。
- [ ] TBUG-003：统一 canary binary provenance，拒绝陈旧 release 和 debug 性能误判。

## P2 质量门禁

- [ ] QG-001：把 execution-host ignored 集成测试接入 focused CI。
- [ ] QG-002：清理 Android 弃用 API 与 unchecked cast 告警。

## 发布证据

- [ ] QG-003：归档真实 Provider、自然 MCP/豁免、终端恢复、弱网 Live Call 和 Android 设备证据。
- [ ] QG-004：发布与最终 commit 对齐的 tag、manifest、Rust-only/hybrid ZIP、SHA-256 与回滚说明。
- [ ] QG-005：在稳定发布后按可逆 slice 退役 hybrid Node 兼容源码。

## 待产品决策

- [ ] FG-001：原生 iOS 还是移动 Web/PWA。
- [ ] FG-002：Codex Desktop Remote 目标是可靠遥控还是完整状态镜像。
- [ ] FG-003：Workspace 是否内置远端协议与离线同步。

详细证据、修复方案、验收和并行策略见 `docs/bug-and-feature-gaps.md`。
