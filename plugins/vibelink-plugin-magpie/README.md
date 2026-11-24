# vibeLink-plugin-magpie

VibeLink 的 Magpie 独立插件包（纯 ESM，零第三方依赖），用于在 VibeLink 与本机 [yetone/magpie](https://github.com/yetone/magpie) 之间提供解耦集成。

## 核心能力

- **按配置展示 Agent**：调用 `magpie ls` 识别本机已配置模型/认证的本地 Coding Agent，自动设为可见并同步进会话与群成员；未配置的 Agent 与宿主应用默认隐藏。
- **独立更新互不耦合**：
  - Magpie 本体通过 `magpie update check` / `magpie update` 独立升级。
  - 插件适配层可迁出至 `~/.vibelink/plugins/magpie/`（`Eject` 后优先加载用户目录），支持 `git pull` 与热重载。
- **网关路由与模型目录**：实时读取 Magpie 本地网关（默认 `http://127.0.0.1:3425/v1/models`）暴露已启用模型与 `auto/*` / `group/*` 路由组，并支持通过 `/v1/chat/completions` 驱动未内置 T3 原生驱动的 Agent。

## 安全边界

本插件仅读取 `gateway.json`、`applied.json`、`magpie ls`、`magpie status --json` 与 `/v1/models`，不读取 `providers.json`、`logins.json` 或 `plugin-auth.json` 等凭据文件。
