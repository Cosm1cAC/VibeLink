using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.Wave;

const int DefaultProbeSeconds = 30;
const int DefaultLevelSeconds = 30;
const int DefaultLevelIntervalMs = 500;

var command = args.ElementAtOrDefault(0)?.Trim().ToLowerInvariant() ?? "help";

try
{
    var result = command switch
    {
        "list" => ListDevices(),
        "probe" => Probe(args.Skip(1).ToArray()),
        "level" => Level(args.Skip(1).ToArray()),
        "stream" => StreamAsync(args.Skip(1).ToArray()).GetAwaiter().GetResult(),
        "help" or "--help" or "-h" => Help(),
        _ => Fail($"Unknown command: {command}")
    };
    return result;
}
catch (Exception ex)
{
    Console.Error.WriteLine(ex.ToString());
    return 1;
}

static int Help()
{
    Console.WriteLine("WindowsAudioProbe");
    Console.WriteLine();
    Console.WriteLine("Commands:");
    Console.WriteLine("  list");
    Console.WriteLine("      List active Windows render/capture audio devices and defaults.");
    Console.WriteLine("  probe [--seconds N] [--out DIR] [--render ID] [--capture ID]");
    Console.WriteLine("      Record render loopback to remote.wav and microphone capture to local.wav.");
    Console.WriteLine("  level [--seconds N] [--interval-ms N] [--render ID] [--capture ID]");
    Console.WriteLine("      Emit newline-delimited JSON level events for render loopback and microphone capture.");
    Console.WriteLine("  stream --session-id SESSION [--url WS_URL] [--channel remote|local] [--level-interval-ms N] [--render ID]");
    Console.WriteLine("      Stream PCM frames to a VibeLink bridge WebSocket. Default URL: ws://127.0.0.1:8787");
    Console.WriteLine();
    Console.WriteLine("Defaults use Windows communication render/capture devices.");
    return 0;
}

static int ListDevices()
{
    using var enumerator = new MMDeviceEnumerator();
    var defaults = ReadDefaults(enumerator);
    var payload = new
    {
        ok = true,
        defaults,
        render = List(enumerator, DataFlow.Render),
        capture = List(enumerator, DataFlow.Capture)
    };
    WriteJson(payload);
    return 0;
}

static int Probe(string[] args)
{
    var options = ParseProbeOptions(args);
    Directory.CreateDirectory(options.OutputDir);

    using var enumerator = new MMDeviceEnumerator();
    using var renderDevice = ResolveDevice(enumerator, DataFlow.Render, options.RenderId, Role.Communications);
    using var captureDevice = ResolveDevice(enumerator, DataFlow.Capture, options.CaptureId, Role.Communications);

    var startedAt = DateTimeOffset.UtcNow;
    var remotePath = Path.Combine(options.OutputDir, "remote.wav");
    var localPath = Path.Combine(options.OutputDir, "local.wav");
    var metaPath = Path.Combine(options.OutputDir, "probe.json");

    TryDelete(remotePath);
    TryDelete(localPath);
    TryDelete(metaPath);

    using var loopback = new WasapiLoopbackCapture(renderDevice);
    using var capture = new WasapiCapture(captureDevice);
    using var remoteWriter = new WaveFileWriter(remotePath, loopback.WaveFormat);
    using var localWriter = new WaveFileWriter(localPath, capture.WaveFormat);

    long remoteBytes = 0;
    long localBytes = 0;
    Exception? remoteError = null;
    Exception? localError = null;
    var remoteLevels = new LevelStats(loopback.WaveFormat);
    var localLevels = new LevelStats(capture.WaveFormat);

    loopback.DataAvailable += (_, e) =>
    {
        remoteWriter.Write(e.Buffer, 0, e.BytesRecorded);
        remoteBytes += e.BytesRecorded;
        remoteLevels.Add(e.Buffer, e.BytesRecorded);
    };
    capture.DataAvailable += (_, e) =>
    {
        localWriter.Write(e.Buffer, 0, e.BytesRecorded);
        localBytes += e.BytesRecorded;
        localLevels.Add(e.Buffer, e.BytesRecorded);
    };
    loopback.RecordingStopped += (_, e) => remoteError = e.Exception;
    capture.RecordingStopped += (_, e) => localError = e.Exception;

    Console.WriteLine($"Recording {options.Seconds}s...");
    Console.WriteLine($"Render loopback: {renderDevice.FriendlyName}");
    Console.WriteLine($"Capture input:   {captureDevice.FriendlyName}");

    var stopwatch = Stopwatch.StartNew();
    loopback.StartRecording();
    capture.StartRecording();
    Thread.Sleep(TimeSpan.FromSeconds(options.Seconds));
    loopback.StopRecording();
    capture.StopRecording();
    stopwatch.Stop();

    remoteWriter.Flush();
    localWriter.Flush();

    var finishedAt = DateTimeOffset.UtcNow;
    var warnings = new List<string>();
    var remoteSummary = remoteLevels.Summary();
    var localSummary = localLevels.Summary();
    if (remoteBytes <= 0 || !remoteSummary.HasSignal)
    {
        warnings.Add("remote_loopback_has_no_signal: play call audio through the selected Windows communication output during probe.");
    }
    if (localBytes <= 0 || !localSummary.HasSignal)
    {
        warnings.Add("local_capture_has_no_signal: speak into the selected microphone during probe.");
    }

    var meta = new
    {
        ok = remoteError is null && localError is null,
        ready = remoteError is null && localError is null && remoteSummary.HasSignal && localSummary.HasSignal,
        warnings,
        startedAt,
        finishedAt,
        requestedSeconds = options.Seconds,
        elapsedMs = stopwatch.ElapsedMilliseconds,
        outputDir = Path.GetFullPath(options.OutputDir),
        remote = new
        {
            path = Path.GetFullPath(remotePath),
            bytes = remoteBytes,
            device = DeviceInfo(renderDevice, true),
            waveFormat = FormatInfo(loopback.WaveFormat),
            levels = remoteSummary,
            error = remoteError?.Message ?? ""
        },
        local = new
        {
            path = Path.GetFullPath(localPath),
            bytes = localBytes,
            device = DeviceInfo(captureDevice, true),
            waveFormat = FormatInfo(capture.WaveFormat),
            levels = localSummary,
            error = localError?.Message ?? ""
        }
    };

    File.WriteAllText(metaPath, JsonSerializer.Serialize(meta, JsonOptions()));
    WriteJson(meta);
    return remoteError is null && localError is null ? 0 : 2;
}

static int Level(string[] args)
{
    var options = ParseLevelOptions(args);

    using var enumerator = new MMDeviceEnumerator();
    using var renderDevice = ResolveDevice(enumerator, DataFlow.Render, options.RenderId, Role.Communications);
    using var captureDevice = ResolveDevice(enumerator, DataFlow.Capture, options.CaptureId, Role.Communications);
    using var loopback = new WasapiLoopbackCapture(renderDevice);
    using var capture = new WasapiCapture(captureDevice);

    Exception? remoteError = null;
    Exception? localError = null;
    var remoteLevels = new ChannelLevelState(loopback.WaveFormat);
    var localLevels = new ChannelLevelState(capture.WaveFormat);

    loopback.DataAvailable += (_, e) => remoteLevels.Add(e.Buffer, e.BytesRecorded);
    capture.DataAvailable += (_, e) => localLevels.Add(e.Buffer, e.BytesRecorded);
    loopback.RecordingStopped += (_, e) => remoteError = e.Exception;
    capture.RecordingStopped += (_, e) => localError = e.Exception;

    var startedAt = DateTimeOffset.UtcNow;
    var stopwatch = Stopwatch.StartNew();
    var cancelled = false;
    ConsoleCancelEventHandler handler = (_, e) =>
    {
        e.Cancel = true;
        cancelled = true;
    };

    Console.CancelKeyPress += handler;
    try
    {
        WriteJsonLine(new
        {
            ok = true,
            type = "audio.level.started",
            at = startedAt,
            intervalMs = options.IntervalMs,
            requestedSeconds = options.Seconds,
            remote = new { channel = "remote", device = DeviceInfo(renderDevice, true), waveFormat = FormatInfo(loopback.WaveFormat) },
            local = new { channel = "local", device = DeviceInfo(captureDevice, true), waveFormat = FormatInfo(capture.WaveFormat) }
        });

        loopback.StartRecording();
        capture.StartRecording();

        while (!cancelled && (options.Seconds <= 0 || stopwatch.Elapsed < TimeSpan.FromSeconds(options.Seconds)))
        {
            Thread.Sleep(TimeSpan.FromMilliseconds(options.IntervalMs));
            var remote = remoteLevels.Snapshot();
            var local = localLevels.Snapshot();
            WriteJsonLine(new
            {
                ok = remoteError is null && localError is null,
                type = "audio.level",
                at = DateTimeOffset.UtcNow,
                elapsedMs = stopwatch.ElapsedMilliseconds,
                remote = new
                {
                    channel = "remote",
                    bytes = remote.TotalBytes,
                    intervalBytes = remote.IntervalBytes,
                    deviceName = renderDevice.FriendlyName,
                    levels = remote.Levels,
                    error = remoteError?.Message ?? ""
                },
                local = new
                {
                    channel = "local",
                    bytes = local.TotalBytes,
                    intervalBytes = local.IntervalBytes,
                    deviceName = captureDevice.FriendlyName,
                    levels = local.Levels,
                    error = localError?.Message ?? ""
                }
            });
        }
    }
    finally
    {
        Console.CancelKeyPress -= handler;
        TryStop(loopback);
        TryStop(capture);
        stopwatch.Stop();
    }

    WriteJsonLine(new
    {
        ok = remoteError is null && localError is null,
        type = "audio.level.stopped",
        at = DateTimeOffset.UtcNow,
        startedAt,
        elapsedMs = stopwatch.ElapsedMilliseconds,
        remote = new { error = remoteError?.Message ?? "" },
        local = new { error = localError?.Message ?? "" }
    });
    return remoteError is null && localError is null ? 0 : 2;
}

static ProbeOptions ParseProbeOptions(string[] args)
{
    var options = new ProbeOptions(DefaultProbeSeconds, Path.Combine(".agent-mobile-terminal", "audio-probes", Timestamp()), null, null);
    for (var i = 0; i < args.Length; i++)
    {
        var arg = args[i];
        string Next()
        {
            if (i + 1 >= args.Length) throw new ArgumentException($"Missing value for {arg}");
            return args[++i];
        }

        options = arg switch
        {
            "--seconds" or "-s" => options with { Seconds = Math.Max(1, int.Parse(Next())) },
            "--out" or "-o" => options with { OutputDir = Next() },
            "--render" => options with { RenderId = Next() },
            "--capture" => options with { CaptureId = Next() },
            _ => throw new ArgumentException($"Unknown probe option: {arg}")
        };
    }
    return options;
}

static LevelOptions ParseLevelOptions(string[] args)
{
    var options = new LevelOptions(DefaultLevelSeconds, DefaultLevelIntervalMs, null, null);
    for (var i = 0; i < args.Length; i++)
    {
        var arg = args[i];
        string Next()
        {
            if (i + 1 >= args.Length) throw new ArgumentException($"Missing value for {arg}");
            return args[++i];
        }

        options = arg switch
        {
            "--seconds" or "-s" => options with { Seconds = Math.Max(0, int.Parse(Next())) },
            "--interval-ms" or "-i" => options with { IntervalMs = Math.Max(100, int.Parse(Next())) },
            "--render" => options with { RenderId = Next() },
            "--capture" => options with { CaptureId = Next() },
            _ => throw new ArgumentException($"Unknown level option: {arg}")
        };
    }
    return options;
}

static async Task<int> StreamAsync(string[] args)
{
    var options = ParseStreamOptions(args);
    if (string.IsNullOrWhiteSpace(options.SessionId) || string.IsNullOrWhiteSpace(options.Url))
    {
        Console.Error.WriteLine("--session-id and --url are required for stream.");
        return 1;
    }

    using var enumerator = new MMDeviceEnumerator();
    using var device = ResolveDevice(enumerator, options.Channel == "local" ? DataFlow.Capture : DataFlow.Render, options.RenderId, Role.Communications);
    using var capture = options.Channel == "local" ? new WasapiCapture(device) : new WasapiLoopbackCapture(device);
    var waveFormat = capture.WaveFormat;

    using var ws = new ClientWebSocket();
    ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
    try
    {
        await ws.ConnectAsync(new Uri(options.Url), CancellationToken.None);
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"WebSocket connect failed: {ex.Message}");
        return 3;
    }

    var header = new
    {
        sampleRate = waveFormat.SampleRate,
        channels = waveFormat.Channels,
        encoding = "pcm16le",
        device = options.Channel
    };
    var headerBytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(header, JsonOptions()));
    await ws.SendAsync(headerBytes, WebSocketMessageType.Text, true, CancellationToken.None);

    var startedAt = DateTimeOffset.UtcNow;
    Console.WriteLine($"stream started: {header.sampleRate} Hz, {header.channels} ch, channel={header.device}, target={options.Url}");

    Exception? captureError = null;
    var levelStats = new LevelStats(waveFormat);
    long totalBytes = 0;
    var lastLevelAt = DateTimeOffset.UtcNow;
    var cts = new CancellationTokenSource();
    ConsoleCancelEventHandler cancel = (_, e) => { e.Cancel = true; cts.Cancel(); };
    Console.CancelKeyPress += cancel;

    async Task SendTextAsync(string json)
    {
        if (ws.State != WebSocketState.Open) return;
        try
        {
            var bytes = Encoding.UTF8.GetBytes(json);
            await ws.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"ws send failed: {ex.Message}");
        }
    }

    capture.DataAvailable += (_, e) =>
    {
        try
        {
            if (ws.State != WebSocketState.Open) return;
            levelStats.Add(e.Buffer, e.BytesRecorded);
            totalBytes += e.BytesRecorded;
            ws.SendAsync(new ArraySegment<byte>(e.Buffer, 0, e.BytesRecorded), WebSocketMessageType.Binary, true, CancellationToken.None)
              .GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            captureError = ex;
        }
    };
    capture.RecordingStopped += (_, e) => captureError ??= e.Exception;

    capture.StartRecording();

    // Periodic level reporter — also serves as a heartbeat.
    while (!cts.IsCancellationRequested && ws.State == WebSocketState.Open)
    {
        await Task.Delay(TimeSpan.FromMilliseconds(options.LevelIntervalMs), cts.Token).ContinueWith(_ => { });
        var summary = levelStats.Summary();
        await SendTextAsync(JsonSerializer.Serialize(new
        {
            type = "level",
            rms = Math.Round(summary.Rms, 6),
            peak = Math.Round(summary.Peak, 6)
        }, JsonOptions()));
        if (captureError != null) break;
    }

    try { capture.StopRecording(); } catch { }
    try
    {
        await SendTextAsync(JsonSerializer.Serialize(new { type = "stop" }, JsonOptions()));
        await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "client_stop", CancellationToken.None);
    }
    catch { }

    Console.CancelKeyPress -= cancel;
    Console.WriteLine($"stream stopped: bytes={totalBytes}, duration={DateTimeOffset.UtcNow - startedAt:hh\\:mm\\:ss}");
    return captureError is null ? 0 : 2;
}

static StreamOptions ParseStreamOptions(string[] args)
{
    var options = new StreamOptions("", "ws://127.0.0.1:8787", "remote", 500, null);
    for (var i = 0; i < args.Length; i++)
    {
        var arg = args[i];
        string Next()
        {
            if (i + 1 >= args.Length) throw new ArgumentException($"Missing value for {arg}");
            return args[++i];
        }

        options = arg switch
        {
            "--session-id" => options with { SessionId = Next() },
            "--url" => options with { Url = Next() },
            "--channel" => options with { Channel = Next() == "local" ? "local" : "remote" },
            "--level-interval-ms" => options with { LevelIntervalMs = Math.Max(100, int.Parse(Next())) },
            "--render" => options with { RenderId = Next() },
            _ => throw new ArgumentException($"Unknown stream option: {arg}")
        };
    }
    if (!string.IsNullOrWhiteSpace(options.SessionId) && !options.Url.Contains("session-id="))
    {
        var sep = options.Url.Contains("?") ? "&" : "?";
        options = options with { Url = $"{options.Url}{sep}session-id={Uri.EscapeDataString(options.SessionId)}" };
    }
    return options;
}

static MMDevice ResolveDevice(MMDeviceEnumerator enumerator, DataFlow flow, string? id, Role fallbackRole)
{
    if (!string.IsNullOrWhiteSpace(id)) return enumerator.GetDevice(id);
    try
    {
        return enumerator.GetDefaultAudioEndpoint(flow, fallbackRole);
    }
    catch
    {
        return enumerator.GetDefaultAudioEndpoint(flow, Role.Multimedia);
    }
}

static object ReadDefaults(MMDeviceEnumerator enumerator)
{
    object? Default(DataFlow flow, Role role)
    {
        try
        {
            using var device = enumerator.GetDefaultAudioEndpoint(flow, role);
            return DeviceInfo(device, true);
        }
        catch (Exception ex)
        {
            return new { error = ex.Message };
        }
    }

    return new
    {
        renderCommunications = Default(DataFlow.Render, Role.Communications),
        captureCommunications = Default(DataFlow.Capture, Role.Communications),
        renderMultimedia = Default(DataFlow.Render, Role.Multimedia),
        captureMultimedia = Default(DataFlow.Capture, Role.Multimedia)
    };
}

static object[] List(MMDeviceEnumerator enumerator, DataFlow flow)
{
    var devices = enumerator.EnumerateAudioEndPoints(flow, DeviceState.Active);
    return devices.Select(device => DeviceInfo(device, true)).ToArray();
}

static object DeviceInfo(MMDevice device, bool includeFormat)
{
    object? format = null;
    if (includeFormat)
    {
        try { format = FormatInfo(device.AudioClient.MixFormat); } catch { format = null; }
    }

    return new
    {
        id = device.ID,
        name = device.FriendlyName,
        dataFlow = device.DataFlow.ToString(),
        state = device.State.ToString(),
        format
    };
}

static object FormatInfo(WaveFormat format)
{
    return new
    {
        encoding = format.Encoding.ToString(),
        sampleRate = format.SampleRate,
        channels = format.Channels,
        bitsPerSample = format.BitsPerSample,
        averageBytesPerSecond = format.AverageBytesPerSecond,
        blockAlign = format.BlockAlign
    };
}

static void WriteJson(object payload)
{
    Console.WriteLine(JsonSerializer.Serialize(payload, JsonOptions()));
}

static void WriteJsonLine(object payload)
{
    Console.WriteLine(JsonSerializer.Serialize(payload, JsonLineOptions()));
    Console.Out.Flush();
}

static JsonSerializerOptions JsonOptions()
{
    return new JsonSerializerOptions { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
}

static JsonSerializerOptions JsonLineOptions()
{
    return new JsonSerializerOptions { WriteIndented = false, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
}

static string Timestamp()
{
    return DateTime.Now.ToString("yyyyMMdd-HHmmss");
}

static void TryDelete(string path)
{
    if (File.Exists(path)) File.Delete(path);
}

static void TryStop(IWaveIn capture)
{
    try { capture.StopRecording(); } catch { }
}

static int Fail(string message)
{
    Console.Error.WriteLine(message);
    Help();
    return 1;
}

internal sealed record ProbeOptions(int Seconds, string OutputDir, string? RenderId, string? CaptureId);
internal sealed record LevelOptions(int Seconds, int IntervalMs, string? RenderId, string? CaptureId);
internal sealed record StreamOptions(string SessionId, string Url, string Channel, int LevelIntervalMs, string? RenderId);
internal sealed record ChannelLevelSnapshot(long TotalBytes, long IntervalBytes, LevelSummary Levels);

internal sealed class ChannelLevelState
{
    private readonly object gate = new();
    private readonly WaveFormat format;
    private LevelStats intervalStats;
    private long totalBytes;
    private long intervalBytes;

    public ChannelLevelState(WaveFormat format)
    {
        this.format = format;
        intervalStats = new LevelStats(format);
    }

    public void Add(byte[] buffer, int bytesRecorded)
    {
        if (bytesRecorded <= 0) return;
        lock (gate)
        {
            totalBytes += bytesRecorded;
            intervalBytes += bytesRecorded;
            intervalStats.Add(buffer, bytesRecorded);
        }
    }

    public ChannelLevelSnapshot Snapshot()
    {
        lock (gate)
        {
            var snapshot = new ChannelLevelSnapshot(totalBytes, intervalBytes, intervalStats.Summary());
            intervalBytes = 0;
            intervalStats = new LevelStats(format);
            return snapshot;
        }
    }
}

internal sealed class LevelStats
{
    private readonly WaveFormat format;
    private double squareSum;
    private double peak;
    private long sampleCount;

    public LevelStats(WaveFormat format)
    {
        this.format = format;
    }

    public void Add(byte[] buffer, int bytesRecorded)
    {
        if (bytesRecorded <= 0) return;

        if (format.BitsPerSample == 32)
        {
            for (var offset = 0; offset + 3 < bytesRecorded; offset += 4)
            {
                var sample = BitConverter.ToSingle(buffer, offset);
                if (float.IsNaN(sample) || float.IsInfinity(sample)) continue;
                AddSample(sample);
            }
            return;
        }

        if (format.BitsPerSample == 16)
        {
            for (var offset = 0; offset + 1 < bytesRecorded; offset += 2)
            {
                var sample = BitConverter.ToInt16(buffer, offset) / 32768.0;
                AddSample(sample);
            }
        }
    }

    public LevelSummary Summary()
    {
        var rms = sampleCount > 0 ? Math.Sqrt(squareSum / sampleCount) : 0;
        return new LevelSummary(
            Samples: sampleCount,
            Peak: Math.Round(peak, 6),
            PeakDb: ToDb(peak),
            Rms: Math.Round(rms, 6),
            RmsDb: ToDb(rms),
            HasSignal: sampleCount > 0 && peak >= 0.001
        );
    }

    private void AddSample(double sample)
    {
        var absolute = Math.Abs(sample);
        if (absolute > peak) peak = absolute;
        squareSum += sample * sample;
        sampleCount += 1;
    }

    private static double ToDb(double value)
    {
        return value > 0 ? Math.Round(20 * Math.Log10(value), 2) : -120;
    }
}

internal sealed record LevelSummary(long Samples, double Peak, double PeakDb, double Rms, double RmsDb, bool HasSignal);
