# vibelink-plugin-wproxy

VibeLink 内置宿主机 WProxy（Mihomo + Hysteria2）控制与局域网共享插件，同时服务桌面端与安卓端。

## 遵循的安全与运行态规则

- **只读宿主机配置**：仅在服务端内存读取 `wproxy/config.ps1` 与 `wproxy/config.yaml`，不修改任何宿主机配置文件或计划任务。
- **零自动切节点**：严格按 `wproxy/AGENTS.md` 要求，不运行后台自动测速切换；节点切换与 Google 204 延迟探测均由用户主动触发。
- **不暴露 TUN 模式**：仅支持 `sysproxy` 与 `off` 系统代理切换。
- **凭据不落地状态接口**：`health` 与 `status` 不回传 `ApiSecret` 或 `lan-share` 密码；仅在已鉴权的显式复制动作（`getLanShareUri`）中校验宿主机本机接口 IP 后按需生成 URI。
