using System.Diagnostics;
using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.Wave;

const int DefaultProbeSeconds = 30;

var command = args.ElementAtOrDefault(0)?.Trim().ToLowerInvariant() ?? "help";

try
{
    return command switch
    {
        "list" => ListDevices(),
        "probe" => Probe(args.Skip(1).ToArray()),
        "help" or "--help" or "-h" => Help(),
        _ => Fail($"Unknown command: {command}")
    };
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

static JsonSerializerOptions JsonOptions()
{
    return new JsonSerializerOptions { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
}

static string Timestamp()
{
    return DateTime.Now.ToString("yyyyMMdd-HHmmss");
}

static void TryDelete(string path)
{
    if (File.Exists(path)) File.Delete(path);
}

static int Fail(string message)
{
    Console.Error.WriteLine(message);
    Help();
    return 1;
}

internal sealed record ProbeOptions(int Seconds, string OutputDir, string? RenderId, string? CaptureId);

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
