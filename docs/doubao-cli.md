# 豆包 CLI 与 VibeLink 集成

## 定位

仓库内有两条豆包 Web 路径：

- `packages/doubao-cli`：主路径。通过 Chrome/Edge MV3 扩展连接本地 loopback daemon，复用用户已有的豆包登录状态。
- `tools/doubao-cli.mjs`：旧 CDP fallback。需要独立的 remote-debugging 浏览器，仅用于未安装扩展时的兼容。

VibeLink 的 `/api/doubao/status`、`/api/doubao/ask` 和 `agent: "doubao"` 接口保持稳定，由 `src/doubaoRuntime.js` 解析实际命令。

## 设计约束

- 不读取、导出或保存 Cookie、localStorage、豆包凭据。
- daemon 只监听 `127.0.0.1`，CLI 和扩展请求都使用随机 bearer token。
- 扩展权限只覆盖豆包域名和本机 loopback。
- 一张豆包 tab 同时只允许一个写请求，其余请求排队或返回可恢复的 `BUSY`。
- Chrome 完全关闭、tab 被系统丢弃、需要 CAPTCHA 或重新登录时不能保证自动恢复。
- 日志默认不保存 prompt；诊断输出不得包含 token。

## 使用

```bash
node packages/doubao-cli/src/bin/doubao.mjs configure --json
node packages/doubao-cli/src/bin/doubao.mjs daemon run --json
node packages/doubao-cli/src/bin/doubao.mjs doctor --json
node packages/doubao-cli/src/bin/doubao.mjs ask --prompt "写一个摘要" --json
```

安装为可执行命令后可直接使用：

```bash
doubao doctor --json
doubao ask --prompt "写一个摘要" --json
echo "写一个摘要" | doubao ask --stdin --json
doubao ask --prompt "长回答" --stream --jsonl
doubao mcp serve
```

首次使用需要加载 `packages/doubao-cli/apps/extension` 扩展，并在浏览器中登录 `doubao.com`。扩展与 daemon 都在线后，`doctor --json` 应报告 `backend: "extension_bridge"`。

## 输出契约

Agent 调用应使用 JSON/JSONL，不解析人类可读文本：

```json
{
  "ok": true,
  "provider": "doubao",
  "backend": "extension_bridge",
  "text": "answer text",
  "elapsedMs": 8421
}
```

错误也必须是稳定值：

```json
{
  "ok": false,
  "error": {
    "code": "LOGIN_REQUIRED",
    "message": "Doubao is open but not authenticated.",
    "recoverable": true
  }
}
```

主要错误码：`BRIDGE_OFFLINE`、`EXTENSION_OFFLINE`、`DOUBAO_TAB_MISSING`、`TAB_DISCARDED`、`LOGIN_REQUIRED`、`SEND_FAILED`、`ANSWER_TIMEOUT`、`RATE_LIMITED`、`UNSUPPORTED_UI`。

## VibeLink 命令解析

`DOUBAO_COMMAND=auto` 时按以下顺序解析：

1. PATH 或设置中配置的外部 `doubao`。
2. 仓库内 `packages/doubao-cli/src/bin/doubao.mjs`。
3. 旧 `tools/doubao-cli.mjs` CDP fallback。

VibeLink Agent 通过普通 CLI JSON 契约调用豆包，不把扩展或 DOM 细节泄漏到 Agent runtime。

## 洁净开发约束

- 可以借鉴稳定命令、JSON/JSONL、错误码、doctor、自描述 schema 和 MCP 适配等通用接口思想。
- 不复制第三方仓库源码、测试、提示词、README 段落、商标资源或许可证不兼容内容。
- 新实现必须基于公开行为和本仓库契约独立编写，并由本仓库测试证明。

## 测试

```bash
npm --prefix packages/doubao-cli test
```

测试覆盖 CLI/daemon 协议和扩展 manifest。真实页面 DOM 仍可能随豆包更新变化，出现 `UNSUPPORTED_UI` 时应更新 adapter 并补 DOM fixture 回归测试。
