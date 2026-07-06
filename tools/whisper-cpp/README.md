# Whisper.cpp 本地 ASR 集成

## 目录结构

```
tools/whisper-cpp/
├── README.md               # 本文
├── bin/                    # whisper.cpp 编译产物（编译后生成）
│   ├── main.exe
│   ├── stream.exe
│   └── ggml-*.bin          # 模型文件
├── models/                 # 模型下载目录
└── build/                  # cmake build 目录
```

## 编译

```bash
# 1. 克隆 whisper.cpp（首次）
git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git tools/whisper-cpp/source

# 2. 编译（需要 cmake + MSVC）
cd tools/whisper-cpp
cmake -S source -B build
cmake --build build --config Release

# 3. 复制 binary
copy build\bin\Release\*.exe bin\
copy build\bin\Release\*.dll bin\
```

## 下载模型

```bash
# 下载 base 中文模型（~150MB，推荐）
.\build\bin\Release\whisper-cli.exe --model base --download-model-dir models

# 或下载 small 中文模型（~500MB，更准）
.\build\bin\Release\whisper-cli.exe --model small --download-model-dir models

# 模型文件会以 ggml-{model}.bin 格式放在 models/ 目录
```

## 测试

```bash
# 测试 single-file 转录
.\build\bin\Release\whisper-cli.exe --model models\ggml-base.bin --language zh --file test.wav

# 测试 stdin 模式（16k mono s16le raw）
cat remote.raw | .\build\bin\Release\whisper-cli.exe --model models\ggml-base.bin --language zh --stdin --output-json
```

## 与 VibeLink 集成

编辑 src/liveCallAsr.js 中的 `WHISPER_CPP_BIN` 路径指向 `tools/whisper-cpp/bin/`：

```js
const WHISPER_CPP_BIN = path.join(rootDir, "tools", "whisper-cpp", "bin");
```

然后在 Web UI 的 Settings 中用 `asrProvider: "whisper-cpp"` 切换使用本地 ASR。

## 性能参考

| 模型 | CPU 实时率 | 内存 | 延迟（3s 音频） |
|-----|-----------|------|----------------|
| tiny   | ~8x | 250 MB | ~0.4s |
| base   | ~4x | 400 MB | ~0.8s |
| small  | ~2x | 1.2 GB | ~1.5s |
| medium | ~0.8x | 2.5 GB | ~3.5s |

面试场景推荐 16k mono PCM，base 或 small 模型。
