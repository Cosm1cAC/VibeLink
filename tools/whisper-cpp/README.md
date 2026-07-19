# Whisper.cpp 本地 ASR 可选依赖

VibeLink 可以使用本地 whisper.cpp 作为 ASR provider。whisper.cpp 没有做项目内本地化改造，因此本仓库只保留安装、下载和构建入口，不提交 upstream 源码、构建产物、模型或二进制文件。

默认安装脚本会从 upstream 拉取固定 ref：`v1.9.1`。

## 仓库内容

```
tools/whisper-cpp/
├── README.md
├── setup.mjs               # 拉取固定 upstream ref 并本地构建
└── download-model.mjs      # 下载 ggml 模型
```

以下目录均为本地生成或下载内容，已由 `.gitignore` 排除：

```
tools/whisper-cpp/bin/
tools/whisper-cpp/build/
tools/whisper-cpp/models/
tools/whisper-cpp/source/
```

## 安装和构建

```bash
npm run whisper:setup
```

脚本会：

1. 从 `https://github.com/ggerganov/whisper.cpp.git` 拉取固定 ref `v1.9.1` 到 `tools/whisper-cpp/source/`
2. 使用 CMake 构建到 `tools/whisper-cpp/build/`
3. 将 `.exe` / `.dll` 复制到 `tools/whisper-cpp/bin/`

如果旧工作区里残留的 `tools/whisper-cpp/source/` 不是 Git checkout，脚本会拒绝继续。移走该目录后重新运行 `npm run whisper:setup` 即可重新拉取固定 ref。

如需临时验证 fork 或其他 upstream ref，可使用环境变量覆盖：

```powershell
$env:VIBELINK_WHISPER_CPP_REPO="https://github.com/<owner>/whisper.cpp.git"
$env:VIBELINK_WHISPER_CPP_REF="<tag-or-commit>"
npm run whisper:setup
```

如果以后需要本地 patch，优先记录 fork/ref 或提交 patch 文件，不要把完整 upstream 源码提交进 VibeLink 主仓库。

## 下载模型

```bash
npm run whisper:model
npm run whisper:model -- small
```

模型文件会以 `ggml-{model}.bin` 格式放在 `tools/whisper-cpp/models/`。

## 测试 whisper.cpp

```powershell
.\tools\whisper-cpp\bin\whisper-cli.exe --model tools\whisper-cpp\models\ggml-base.bin --language zh --file test.wav
```

Live Call 会把 VAD 段封装成临时 WAV 后逐段调用 CLI；`whisper-cli --stdin` 会等待 EOF，不用于长驻实时流。

## 生产配置

生产配置固定在 `production.json`：`whisper-cli.exe` + `ggml-base.bin`、16 kHz mono PCM。启动时缺少任一文件会让 Live Call ASR 报错，生产环境不会静默使用 deterministic mock。可用 `VIBELINK_WHISPER_CPP_BIN`、`VIBELINK_WHISPER_CPP_MODELS` 指向打包目录；如需换 binary/model，必须显式设置对应环境变量并在发布物中一起校验。

PCM checkpoint 默认保留 7 天、单文件 512 MiB、总量 2 GiB。单文件超限自动轮转，过期文件和超总量的最旧非活动文件自动删除。通过 `VIBELINK_LIVE_CALL_PCM_RETENTION_DAYS`、`VIBELINK_LIVE_CALL_PCM_MAX_BYTES` 和 `VIBELINK_LIVE_CALL_PCM_MAX_TOTAL_BYTES` 调整。

## 与 VibeLink 集成

VibeLink 会读取 `production.json` 并在启动时检测固定 binary/model。开发环境可显式选择 `VIBELINK_ASR=mock`；其他 provider 缺失时请求会收到 `no_production_asr_provider`，任何环境都不会隐式回退到 mock。Windows portable 会带上配置，并在本地已有 `bin/`、`models/` 时一并打包。

真实音频与弱网 QA：

```powershell
npm run live-call:qa-stress -- --pcm-file .\fixtures\interview-16k-mono.pcm --seconds 3600 --weak-network
```

## 性能参考

| 模型 | CPU 实时率 | 内存 | 延迟（3s 音频） |
|-----|-----------|------|----------------|
| tiny   | ~8x | 250 MB | ~0.4s |
| base   | ~4x | 400 MB | ~0.8s |
| small  | ~2x | 1.2 GB | ~1.5s |
| medium | ~0.8x | 2.5 GB | ~3.5s |

面试场景推荐 16k mono PCM，base 或 small 模型。
