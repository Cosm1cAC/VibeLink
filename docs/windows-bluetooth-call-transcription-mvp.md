# Windows 蓝牙通话实时转写 MVP

最后更新：2026-07-04

本文档记录一条本机自用 MVP 路线：面试官仍拨打一加手机的真实手机号，手机把系统电话音频通过蓝牙/Phone Link 带到 Windows，本机 Windows 再复制数字音频流做实时转写，并把问题送进 VibeLink Agent。

## 目标

- 不依赖 Android 通话录音权限。
- 不要求面试官拨桥接号码。
- 不使用手机免提/空气麦克风采集对方声音。
- Windows 本机作为通话音频中转和 Agent bridge。
- 外接麦克风负责你的电话上行；同一路麦克风也可作为本地转写输入。

## 非目标

- 第一版不做 Android 原生 App。
- 第一版不做自研 Bluetooth HFP 协议栈。
- 第一版不尝试读取手机内置麦克风。
- 第一版不做电话桥、SIP trunk、呼叫转移或公网号码。
- 第一版不把 Agent 的语音直接回灌给面试官，只做本机答案提示。

## 核心链路

```text
对方说话
  -> 一加手机系统电话
  -> 蓝牙 HFP / Windows Phone Link
  -> Windows 通信播放设备
  -> WASAPI 数字回环捕获
  -> 实时 ASR
  -> 问题检测
  -> VibeLink Agent
  -> 网页端/后续原生端显示答案

你说话
  -> 外接麦克风
  -> Windows 通信输入设备
  -> 蓝牙 HFP / Windows Phone Link
  -> 一加手机系统电话
  -> 面试官听到
```

这里的“数字回环捕获”不是用麦克风录电脑扬声器。音频已经通过蓝牙进入 Windows，Windows 把它送到播放设备；WASAPI loopback 只是在 Windows 音频图里复制一份 PCM 数据给转写模块。

## 需要准备

- Windows 10/11 主机。
- 一加手机，能通过 Windows Phone Link 或系统蓝牙通话在电脑上接打电话。
- 一个外接麦克风，优先 USB 麦克风或 USB 声卡 + 有线麦克风。
- 一个监听设备，耳机优先，避免电脑外放造成回声。
- VibeLink 本机 bridge。
- 后续 ASR provider：先用 mock/file 模式验证链路，再接云端或本地实时 ASR。

## MVP 阶段

### 阶段 0：手工打通 Windows 通话

1. 一加手机与 Windows 配对。
2. 打开 Windows Phone Link，确认可以在电脑上接听/拨打手机电话。
3. 在 Windows 声音设置里把外接麦克风设为默认通信输入设备。
4. 把耳机或目标播放设备设为默认通信输出设备。
5. 打一通测试电话，确认对方能听到外接麦克风，对方声音能从 Windows 耳机听到。

验收标准：不运行任何 VibeLink 代码时，Windows 已经能作为手机电话的听筒和麦克风使用。

### 阶段 1：采集 30 秒样本

实现或引入一个 Windows audio capture helper，先只做本地录音文件：

- 枚举 render/capture 设备。
- 标出默认通信播放设备和默认通信录音设备。
- 从默认通信播放设备做 WASAPI loopback，保存 `remote.wav`。
- 从默认通信录音设备录外接麦克风，保存 `local.wav`。
- 输出采样率、声道数、设备 id、开始/结束时间。

验收标准：电话测试期间生成两个音频文件，`remote.wav` 有面试官声音，`local.wav` 有你的麦克风声音，二者都不是空气串音的主要来源。

当前最小原型已落在 `tools/windows-audio-probe`，可先用以下命令验证：

```bash
npm run audio:list
npm run audio:probe -- --seconds 30
```

`audio:list` 会列出 Windows 当前 active 的播放/录音端点，并标出默认通信播放设备和默认通信录音设备。`audio:probe` 默认从通信播放设备做 WASAPI 数字回环捕获，输出 `remote.wav`，同时从通信录音设备捕获外接麦克风，输出 `local.wav`。

probe 输出目录默认在：

```text
.agent-mobile-terminal/audio-probes/YYYYMMDD-HHMMSS/
```

每次 probe 会生成：

```text
remote.wav   # Windows 通信播放设备的数字回环，也就是对方声音验证入口
local.wav    # Windows 通信录音设备，也就是你的外接麦克风验证入口
probe.json   # 设备、采样率、字节数、peak/RMS、warning 和 ready 状态
```

`probe.json` 中 `ready: true` 才表示两路都捕获到了有效信号。若出现 `remote_loopback_has_no_signal`，说明测试期间目标 Windows 播放设备没有实际通话/播放音频；若出现 `local_capture_has_no_signal`，说明测试期间麦克风没有有效输入或输入设备选错。

### 阶段 2：实时流接入 VibeLink

在本机 bridge 增加 `live-call` 会话模型，先不接真实 ASR：

- capture helper 把 PCM frame 通过本地 WebSocket 推给 Node bridge。
- Node bridge 写入 `live_call_events` 或临时内存事件流。
- 前端出现 `Live Call` 面板，显示音量、电平、设备名、连接状态。
- 使用 mock ASR 把固定文本或本地文本流推入会话，验证 UI 和 Agent 调用链路。

验收标准：不依赖真实电话内容时，VibeLink 能显示 live session 状态，并能把模拟问题送进 Agent。

### 阶段 3：接实时 ASR

把 `remote` 音频送入实时 ASR，`local` 音频按需用于说话人分离和上下文：

- 电话音频优先按 8k/16k 单声道处理。
- ASR 返回 partial/final transcript。
- 对 final transcript 做去重、断句和问题检测。
- 仅当检测到对方面试问题或长句结束时触发 Agent。

验收标准：真实电话中，对方问题能在 1-3 秒内出现在 VibeLink，并触发 Agent 生成回答草稿。

### 阶段 4：面试辅助体验

- 当前问题高亮。
- Agent 回答流式显示。
- 一键复制答案。
- 保存问答记录。
- 结束通话后生成复盘摘要。

验收标准：一次 10 分钟测试通话内，转写不中断，答案卡不会阻塞通话音频。

## 建议实现形态

### Windows capture helper

优先用 .NET/NAudio 或 Rust 实现一个小 helper，而不是依赖用户环境里是否安装了特定 ffmpeg build。

职责：

- `list-devices`：列出 Windows 音频端点。
- `probe`：录制短样本并输出文件。
- `stream`：把 PCM frame 推送到 `ws://127.0.0.1:8787/api/live-call/audio`。
- `level`：实时输出 RMS/peak，方便调设备。

第一版建议只支持 Windows，后续再抽象成跨平台 audio source。

### VibeLink bridge

新增模块建议：

```text
src/liveCall.js
src/liveCallAsr.js
src/liveCallAgent.js
```

建议 API：

```text
POST /api/live-calls
GET  /api/live-calls/:id
GET  /api/live-calls/:id/events
POST /api/live-calls/:id/stop
WS   /api/live-calls/:id/audio
```

事件类型：

```text
live_call.started
live_call.audio_level
live_call.transcript.partial
live_call.transcript.final
live_call.question.detected
live_call.agent.delta
live_call.agent.done
live_call.stopped
live_call.error
```

### 前端

第一版可以先放在设置/实验面板，不进入主聊天列表：

- 设备状态：Phone Link、播放回环、麦克风、ASR、Agent。
- 实时 transcript。
- 当前问题。
- Agent 建议回答。
- 录音样本下载入口，仅用于调试。

## 风险与验证点

| 风险 | 验证方式 | 兜底 |
| --- | --- | --- |
| Windows Phone Link 不稳定或不把通话音频走目标播放设备 | 阶段 0 手工通话测试 | 改用系统蓝牙通话入口或电话桥路线 |
| WASAPI loopback 抓到的是其它系统声音 | 测试时关闭其它播放源，并显示设备 id/应用音量 | 使用虚拟音频线或专用通信输出设备 |
| 外接麦克风被 Phone Link 占用后 helper 录不到 | 阶段 1 同时录 `local.wav` | 只转写下行；或用虚拟音频路由/第二麦克风 |
| 回声导致 ASR 把你的声音混入 remote | 使用耳机，避免外放 | remote/local 双路做简单能量门限和去重 |
| ASR 延迟过高 | 记录 partial/final 延迟 | 更换 ASR provider 或本地模型 |
| Agent 回答太慢 | 先触发短回答模式 | 用简历/岗位上下文预加载，限制输出长度 |

## 购买麦克风建议

优先级：

1. USB 麦克风或 USB 领夹麦，Windows 识别稳定。
2. USB 声卡 + 3.5mm 领夹麦，便宜且可替换。
3. 蓝牙麦克风不推荐，容易和手机/Windows 蓝牙通话链路抢路由。

同时建议使用有线耳机监听对方声音，避免电脑外放被麦克风重新收进去。

## 第一轮开发清单

1. 写 Windows capture helper 的设备枚举和 30 秒 probe。
2. 在 VibeLink 增加 `live-call` 实验面板。
3. 把 probe 结果展示在面板里。
4. 接 mock ASR，跑通 transcript -> question -> Agent。
5. 接一个真实 ASR provider。
6. 做 10 分钟真实电话稳定性测试。

## 成功标准

MVP 成功不要求完全自动化，只要求证明这条链路成立：

- 面试官拨真实手机号。
- Windows 可接收蓝牙通话下行音频。
- Windows 外接麦克风可作为电话上行。
- VibeLink 可拿到下行数字音频并实时转写。
- Agent 能基于实时问题给出可读答案。
