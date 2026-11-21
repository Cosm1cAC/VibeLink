# AGENTS.md — VibeLink v3 & 宿主机代理规则

## 一、宿主机代理与运行态保护（不可破坏）

当前 PC（`HAOSHAO`）的宿舍热点代理策略以 [`wproxy/AGENTS.md`](wproxy/AGENTS.md) 为准，先记住这三条再动手：

1. PC 是热点宿主，翻墙出口在笔记本；PC 系统代理必须指向**笔记本当前 LAN IP** 的 `7897`，由 `C:\Users\22771\bin\pc-proxy-failover.ps1` 自动发现。
2. **不要写死 `192.168.137.24`**，也不要把系统代理长期设成 `127.0.0.1:7897`（PC 本地 mihomo 只有 18–27KB/s，仅最后兜底）。
3. 笔记本 repo `C:\Users\admin\Desktop\项目\proxy-stack\wproxy\` 是源文件；改脚本先在笔记本改，再同步到 PC。

以下本地运行态与凭据目录保留在工作区根目录并已在 `.gitignore` 中忽略，**严禁删除、清空或将其纳入 Git**：
- `wproxy/`（计划任务 `WProxy`、`WProxy-Hysteria-NetHeal`）
- `opencode-mesh/`（开机启动项 `OpenCodeServer.vbs`）
- `rshell/`（开机启动项 `RShellServer.vbs`）
- `keys/`（本机及远端节点凭据）

---

## 二、VibeLink v3 目录与工程约定

本项目完全个人自用不商用，目标是打造「QQ 风格即时通讯 + 单 Bot 好友 + 多 Bot 群聊协作」一体化桌面与移动端应用：

- `client/`：前端客户端（基于 `HuLaSpark/HuLa` 二开，Tauri 2 + Vue 3 + Vite + Naive UI + UnoCSS + Pinia + Rust SQLite），同时输出 Windows/macOS 桌面端（四栏 QQ NT 风格）与 Android 移动端（Tauri Mobile）。
- `server/`：核心控制面与编排后端（基于 `pingdotgg/t3code` `apps/server` + `packages/*` 二开，融合 `stablyai/orca` Bot Home 与群组 `@Bot` 交接设计，Node.js + Effect-TS + SQLite + MCP Server + `node-pty`）。
- `seeds/`：初始化种子配置（如 `bots_fleet.seed.json`，首次启动自动迁移到 `~/.vibelink/bots/` 目录结构）。
- `docs/`：架构与上游源码溯源文档（含 `UPSTREAM.md`）。
- `scripts/`：开发启动、打包与验证脚本。

### 重要工作区规则
1. **双独立 pnpm workspace**：`client/`（Vue 3 + Tauri 2）与 `server/`（Effect-TS + Node）**禁止合并到同一个 `pnpm-workspace.yaml`**，两者各自独立安装与维护依赖，避免 `catalog:` 与 peer dependencies 冲突。
2. **联网操作代理**：执行 `git clone`、`pnpm install`、`cargo` 等联网命令前，动态读取 Windows 注册表 `HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 的 `ProxyServer` 注入 `HTTP_PROXY` / `HTTPS_PROXY`，不要写死代理地址。
