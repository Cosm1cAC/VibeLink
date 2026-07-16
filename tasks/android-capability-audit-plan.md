# Android Capability Audit And Repair Plan / Android 能力审计与修复计划

Status: completed on 2026-07-14.
状态：2026-07-14 已完成。

## Scope / 范围

Audit the VibeLink Android client against its documented product contract, reproduce and repair critical authentication/intent defects, add repeatable device automation, and verify the result on a visible Android 16 emulator connected to the local bridge.
根据产品文档审计 VibeLink Android 客户端，复现并修复关键认证与 Intent 缺陷，添加可重复执行的设备自动化，并在连接本地 Bridge 的可见 Android 16 模拟器上验证结果。

## Completed Work / 已完成工作

- [x] Inventory Android capabilities and separate product gaps from implementation defects.  盘点 Android 能力，将产品缺口与实现缺陷分开。
- [x] Establish a passing JVM-test and debug-build baseline.  建立通过的 JVM 测试与 Debug 构建基线。
- [x] Add failing device regressions for logout, unauthenticated sharing, and token privacy.  为退出登录、未认证分享和 Token 隐私增加失败回归测试。
- [x] Clear persisted and in-memory authentication during logout.  退出时清除持久化和内存中的认证状态。
- [x] Gate shared content on authentication and retain it until login succeeds.  分享内容必须等待认证，登录成功后再恢复。
- [x] Process new pairing intents in a running single-top activity without recreating it.  在运行中的 singleTop Activity 内处理新配对 Intent，不重建 Activity。
- [x] Mask pairing-token input.  对配 Token 输入实施掩码。
- [x] Run six Compose instrumentation tests on the visible API 36 emulator.  在可见 API 36 模拟器上运行 6 项 Compose 仪器测试。
- [x] Pair automatically with the real local bridge and open Sessions, Workspace, Live Call, and Settings.  与真实本地 Bridge 自动配对，打开会话、Workspace、Live Call 和设置页。
- [x] Capture screenshots, UI XML, and filtered logcat evidence.  保留截图、UI XML 和过滤后的 logcat 证据。
- [x] Revoke all temporary audit devices.  撤销所有临时审计设备。

## Verification / 验证结果

- `apps/android/gradlew.bat testDebugUnitTest assembleDebug --no-daemon`: passed / 通过。
- `apps/android/gradlew.bat connectedDebugAndroidTest --no-daemon`: 6/6 passed / 6 项全部通过。
- Visible real-bridge smoke: passed for pairing and four read-only navigation surfaces.  可见真实 Bridge 冒烟：配对以及 4 个只读导航页面通过。
- Runtime diagnostics: 0 VibeLink fatal exceptions and 0 ANRs.  运行时诊断：VibeLink 崩溃 0 次，ANR 0 次。
- Evidence: `artifacts/android-capability-audit/`.  证据位于 `artifacts/android-capability-audit/`。

## Remaining Product Work / 剩余产品工作

The prioritized product gaps are recorded in `tasks/android-capability-matrix.md`. They are not represented as repaired by this audit.
优先级产品缺口记录在 `tasks/android-capability-matrix.md`，本次审计不将它们视为已修复。
