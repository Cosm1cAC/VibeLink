# VibeLink Android 开发 — 后续步骤交接

> 当前状态：Phase 4 全部完成（编译通过、APK 生成）
> 最后 commit: `36d0703` — "Phase 4: Android session list + message list screens"

---

## 环境信息

| 项目 | 值 |
|---|---|
| 项目路径 | `C:\Users\22771\Documents\移动版agent终端` |
| Android 项目 | `apps/android/` |
| Git 分支 | `main` |
| Git 用户 | `Cosm1cAC` |
| VPN 代理 | 需设置 `git config http.proxy` / `https.proxy` 以匹配 VPN 端口才能 `git push` |
| 后端服务 | Node.js 22+, 端口 8787, `src/server.js` |

---

## 当前 Android 项目文件结构

```
apps/android/app/src/main/java/com/vibelink/app/
├── MainActivity.kt
├── data/
│   └── SettingsStore.kt              # DataStore 持久化（token, URL, sessionId）
├── network/
│   ├── ApiClient.kt                  # OkHttp REST + SSE 客户端
│   └── ApiModels.kt                  # 所有数据模型
└── ui/
    ├── VibeLinkApp.kt                # 导航宿主（login → sessionList → messageList / call）
    ├── theme/
    │   ├── Color.kt                  # VibeLink 色板
    │   └── Theme.kt                  # Material3 亮色主题
    ├── components/
    │   ├── CallComponents.kt         # TranscriptFeed, QaCard, LevelIndicator
    │   └── ToolCallCard.kt           # 可折叠 ToolCall 卡片
    └── screens/
        ├── LoginScreen.kt            # Bridge URL + 配对 Token 登录
        ├── SessionListScreen.kt      # 会话列表（合并 histories + tasks）
        ├── SessionListViewModel.kt   # 会话列表逻辑
        ├── MessageListScreen.kt      # 消息详情（含 ToolCard）
        ├── MessageListViewModel.kt   # 消息加载 + SSE 订阅
        └── CallScreen.kt             # Live Call 面板（现有）
```

---

## 导航流程

```
VibeLinkApp (NavHost)
  ├── "login" ───────── LoginScreen
  │                      └── onLoginSuccess → navigate("sessionList")
  ├── "sessionList" ─── SessionListScreen
  │                      ├── onSelectConversation → navigate("messageList/{key}")
  │                      ├── onLogout → navigate("login")
  │                      └── onOpenLiveCall → navigate("call")
  ├── "messageList/{key}" ─ MessageListScreen
  │                        └── onBack → popBackStack()
  └── "call" ─────────── CallScreen
                          └── onLogout → navigate("login")
```

---

## 各 API Endpoint 实现状态

| Endpoint | 方法 | Web端 | Android | 备注 |
|---|---|---|---|---|
| `/api/status` | GET | ✅ | ✅ `checkStatus()` | LoginScreen 使用 |
| `/api/login` | POST | ✅ | ✅ `login()` | |
| `/api/histories` | GET | ✅ | ✅ `listHistories()` | Phase 4 |
| `/api/histories/{provider}/{id}` | GET | ✅ | ✅ `getHistoryDetail()` | Phase 4 |
| `/api/tasks` | GET | ✅ | ✅ `listTasks()` | Phase 4 |
| `/api/tasks` | POST | ✅ | ❌ | 创建新任务 |
| `/api/tasks/{id}` | GET | ✅ | ✅ `getTask()` | Phase 4 |
| `/api/tasks/{id}/events` | GET SSE | ✅ | ✅ `subscribeTaskEvents()` | Phase 4 |
| `/api/tasks/{id}/input` | POST | ✅ | ❌ | 发送 stdin |
| `/api/tasks/{id}/stop` | POST | ✅ | ❌ | 停止任务 |
| `/api/tool-events` | GET SSE | ✅ | ✅ `subscribeToolEvents()` | Phase 4 |
| `/api/tool-runs/{id}` | GET | ✅ | ❌ | 获取 tool run 详情 |
| `/api/live-calls` | GET/POST | ✅ | ✅ `createSession()`, `listSessions()` | Route C |
| `/api/live-calls/{id}/stop` | POST | ✅ | ✅ `stopSession()` | |
| `/api/live-calls/{id}/events` | GET SSE | ✅ | ✅ `subscribeLiveCallEvents()` | |
| `/api/workspaces` | GET | ✅ | ❌ | Phase 6 |
| `/api/workspaces/{id}/git/*` | GET | ✅ | ❌ | Phase 6 |
| `/api/settings` | POST | ✅ | ❌ | Phase 7 |
| `/api/thread-state` | GET/POST | ✅ | ❌ | 会话排序/分组 |

---

## 下一步 Phase 6: Workspace (文件树 + Git + 终端)

> 估算：中等难度，3-5 个文件

### 需要新增的 Android 端能力

1. **API Models** (ApiModels.kt 追加)
   - `WorkspaceItem` — id, name, path
   - `WorkspaceListResponse` — items
   - `GitStatusItem` — path, status (modified/added/deleted/untracked)
   - `GitDiffResponse` — branch, files, fileCount, hunks
   - `CommandResult` — stdout, stderr, exitCode

2. **API Client** (ApiClient.kt 追加)
   - `listWorkspaces()` — GET /api/workspaces
   - `getGitStatus(workspaceId)` — GET /api/workspaces/{id}/git/status
   - `getGitDiff(workspaceId)` — GET /api/workspaces/{id}/git/diff
   - `runCommand(workspaceId, command)` — POST /api/workspaces/{id}/command

3. **WorkspaceScreen.kt**
   - 文件树视图（可折叠目录）
   - Git 状态指示（M/A/D/?? 标记）
   - 文件变更预览

4. **TerminalScreen.kt** (可选)
   - 终端输入/输出
   - 命令历史

5. **导航整合** — 接入 VibeLinkApp 路由

### 参考实现
- Web 端 Workspace 逻辑在 `main.jsx` 中搜索 `workspace`、`/api/workspaces`、`changeSummary`
- Workspace 面板在 Web 端是侧边栏内的可折叠面板

---

## 下一步 Phase 7: Settings (设置页)

> 估算：低难度，1-2 个文件

### 需要新增的能力

1. **SettingsScreen.kt**
   - API Key 配置开关（OpenAI / Anthropic / Zhipu）
   - 默认工作目录
   - 权限模式选择（default / auto-approve）
   - 配对 Token 展示 / 刷新
   - 断开连接按钮

2. **API Client**
   - `saveSettings(settings)` — POST /api/settings

### 参考实现
- Web 端 Settings 在 `main.jsx` 中搜索 `settings`、`/api/settings`
- 设置页是一个 modal 对话框，不是独立路由

---

## 下一步 Phase 8: Bluetooth 音频采集 (Route C)

> 估算：高难度，涉及原生 Android 音频 API

### 依赖
- Android `BluetoothAdapter`, `BluetoothHeadset`, `BluetoothSco`
- `AudioRecord` / `AudioTrack` 原始音频捕获
- `MediaRecorder` 编码可选
- whisper.cpp 集成（已在工具链中 `tools/whisper-bin/`）

### 需要新增的能力

1. **BluetoothService.kt** — 蓝牙设备连接管理
2. **AudioCaptureService.kt** — 音频流捕获 + 发送
3. **WhisperIntegration.kt** — JNI / 进程调用 whisper.cpp
4. **Live Call 增强** — 将 ASR 结果接入 `/api/live-calls` SSE
5. **权限处理** — BLUETOOTH, RECORD_AUDIO, BLUETOOTH_CONNECT (Android 12+)

---

## 已知问题 & 待办

- [ ] **Git push**: 网络连不上 `github.com`（VPN 未配置），需要设置：
  ```bash
  git config http.proxy http://127.0.0.1:{vpn_port}
  git config https.proxy http://127.0.0.1:{vpn_port}
  ```
- [ ] **MessageListScreen**: 点击 history 的"继续此会话"按钮尚未实现功能
- [ ] **MessageListScreen**: ToolEvent SSE 接收后没有实时合并到 toolCalls 中（当前只存了 raw events）
- [ ] **ToolCallCard**: Input/Output 渲染使用了 Gson pretty-print，大对象可能撑爆 UI
- [ ] **CallScreen**: sendTranscript 和 sendLevel 功能需要接真实麦克风数据
- [ ] **VibeLinkApp**: `pendingConversation` 传递方式脆弱，导航回来可能丢失状态

---

## 关键技术参考

### Web 端对应文件
- 全部 UI 逻辑在 `apps/web/src/main.jsx`（~6500 行单文件）
- 搜索关键词：`workspace`, `settings`, `tool-events`, `changeSummary`, `GitDiff`, `Message`, `ToolCallCards`

### Android 端模式
- 无 DI 框架：ViewModel 在 `VibeLinkApp` 级别用 `remember {}` 创建
- API 调用：`ApiClient` 直接传入 Screen 或 ViewModel
- 导航：Navigation Compose，路由在 `VibeLinkApp.kt` 定义
- 主题：Material3 lightColorScheme，自定义色板在 `Color.kt`
- 网络：OkHttp 裸请求 + Gson 解析，SSE 用 `okhttp3-sse`
- 构建：Gradle 8.11.1, Kotlin 2.1.0, compileSdk 35
- 编译：`./gradlew assembleDebug`（APK 输出在 `app/build/outputs/apk/debug/`）

---

*交接文档生成时间：2026-07-06*
*上一会话：Phase 4 完成 commit 36d0703*
