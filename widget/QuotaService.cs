using System.Diagnostics;
using System.IO;
using System.Text.Json;

namespace QufuUsageWidget;

public enum QuotaSeverity
{
    Unknown,
    Green,
    Yellow,
    Red
}

public sealed record QuotaBucket(
    string Window,
    int? RemainingPercent,
    DateTimeOffset? ResetAt,
    bool IsUnused,
    QuotaSeverity Severity
);

public sealed record QuotaGroup(
    string Id,
    string Name,
    QuotaBucket FiveHour,
    QuotaBucket Weekly
);

public sealed record QuotaSnapshot(
    bool Ok,
    bool Stale,
    DateTimeOffset? LastSuccessAt,
    string? Plan,
    QuotaGroup Gemini,
    QuotaGroup ClaudeGpt,
    string? ErrorCode,
    string? ErrorMessage,
    DateTimeOffset? BackoffUntil
);

public sealed class WidgetSettings
{
    public double? Left { get; set; }
    public double? Top { get; set; }
    public int RefreshIntervalSeconds { get; set; } = 60;
    public string ThemeMode { get; set; } = "auto"; // auto | light | dark
    public bool Expanded { get; set; } = false;
    public bool AutoExitWithAntigravity { get; set; } = true;
}

public static class WidgetSettingsStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    private static string GetSettingsPath()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var dir = Path.Combine(home, ".gemini", "antigravity", "plugin_data", "qufu-usage-monitor");
        return Path.Combine(dir, "widget-settings.json");
    }

    public static WidgetSettings Load()
    {
        try
        {
            var path = GetSettingsPath();
            if (File.Exists(path))
            {
                var json = File.ReadAllText(path);
                var parsed = JsonSerializer.Deserialize<WidgetSettings>(json);
                if (parsed is not null)
                {
                    parsed.RefreshIntervalSeconds = Math.Clamp(parsed.RefreshIntervalSeconds, 15, 3600);
                    if (parsed.ThemeMode is not ("auto" or "light" or "dark"))
                    {
                        parsed.ThemeMode = "auto";
                    }
                    return parsed;
                }
            }
        }
        catch
        {
            // Fall back to defaults on corrupt settings file.
        }
        return new WidgetSettings();
    }

    public static void Save(WidgetSettings settings)
    {
        try
        {
            var path = GetSettingsPath();
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir))
            {
                Directory.CreateDirectory(dir);
            }
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(settings, JsonOptions));
            File.Move(tmp, path, overwrite: true);
        }
        catch
        {
            // Ignore non-fatal disk write issues.
        }
    }
}

public sealed class AgyQuotaClient
{
    private const int TimeoutMs = 15_000;
    private const int BaseBackoffMs = 15_000;
    private const int MaxBackoffMs = 300_000;

    private readonly SemaphoreSlim _lock = new(1, 1);
    private QuotaGroup? _lastGemini;
    private QuotaGroup? _lastClaudeGpt;
    private string? _lastPlan;
    private DateTimeOffset? _lastSuccessAt;
    private int _consecutiveFailures;
    private DateTimeOffset? _nextRetryAt;
    private Process? _activeProcess;

    public static string? ResolveAgyExe()
    {
        var overridePath = Environment.GetEnvironmentVariable("QUFU_AGY_PATH")?.Trim();
        if (!string.IsNullOrEmpty(overridePath) && File.Exists(overridePath))
        {
            return overridePath;
        }

        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var defaultWin = Path.Combine(localAppData, "agy", "bin", "agy.exe");
        if (File.Exists(defaultWin))
        {
            return defaultWin;
        }

        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var localBin = Path.Combine(home, ".local", "bin", "agy.exe");
        if (File.Exists(localBin))
        {
            return localBin;
        }

        var pathEnv = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var dir in pathEnv.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(dir.Trim(), "agy.exe");
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        return null;
    }

    public static QuotaSeverity GetSeverity(int? percent) => percent switch
    {
        null => QuotaSeverity.Unknown,
        >= 50 => QuotaSeverity.Green,
        >= 20 => QuotaSeverity.Yellow,
        _ => QuotaSeverity.Red
    };

    public static string FormatCountdown(QuotaBucket bucket, DateTimeOffset now, bool compact)
    {
        if (bucket.IsUnused) return "Full";
        if (bucket.ResetAt is null) return "--";

        var diff = bucket.ResetAt.Value - now;
        if (diff <= TimeSpan.Zero) return compact ? "0s" : "Refreshing";

        if (diff.TotalDays >= 1)
        {
            return $"{(int)diff.TotalDays}d {diff.Hours}h";
        }
        if (diff.TotalHours >= 1)
        {
            return compact
                ? $"{diff.Hours}h{diff.Minutes:D2}m"
                : $"{diff.Hours}h {diff.Minutes:D2}m {diff.Seconds:D2}s";
        }
        if (diff.TotalMinutes >= 1)
        {
            return compact
                ? $"{diff.Minutes}m"
                : $"{diff.Minutes}m {diff.Seconds:D2}s";
        }
        return $"{diff.Seconds}s";
    }

    public async Task<QuotaSnapshot> FetchAsync(bool force, int refreshIntervalSeconds, CancellationToken ct)
    {
        await _lock.WaitAsync(ct);
        try
        {
            var now = DateTimeOffset.UtcNow;

            if (!force && _lastGemini is not null && _lastClaudeGpt is not null && _lastSuccessAt is not null && _consecutiveFailures == 0)
            {
                var cacheTtl = TimeSpan.FromSeconds(Math.Max(10, refreshIntervalSeconds - 5));
                if (now - _lastSuccessAt.Value < cacheTtl)
                {
                    return BuildSuccessSnapshot(false);
                }
            }

            if (!force && _nextRetryAt is not null && now < _nextRetryAt.Value)
            {
                return BuildErrorSnapshot("BACKOFF", "Waiting before retry...");
            }

            var agyExe = ResolveAgyExe();
            if (agyExe is null)
            {
                return RecordFailure(
                    "CLI_NOT_FOUND",
                    "Antigravity CLI (agy) not found. Install it and sign in."
                );
            }

            try
            {
                var stdout = await RunAgyAsync(agyExe, ct);
                ParseOutput(stdout, out var gemini, out var claudeGpt, out var plan);

                _lastGemini = gemini;
                _lastClaudeGpt = claudeGpt;
                _lastPlan = plan;
                _lastSuccessAt = DateTimeOffset.UtcNow;
                _consecutiveFailures = 0;
                _nextRetryAt = null;

                return BuildSuccessSnapshot(false);
            }
            catch (QuotaCliException ex)
            {
                return RecordFailure(ex.Code, ex.Message);
            }
            catch (OperationCanceledException)
            {
                return RecordFailure("TIMEOUT", "Quota query timed out.");
            }
            catch (Exception ex)
            {
                return RecordFailure("CLI_ERROR", ex.Message);
            }
        }
        finally
        {
            _lock.Release();
        }
    }

    public void AbortActive()
    {
        try
        {
            if (_activeProcess is { HasExited: false })
            {
                _activeProcess.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // Ignore cleanup errors.
        }
    }

    private QuotaSnapshot BuildSuccessSnapshot(bool stale)
    {
        return new QuotaSnapshot(
            Ok: !stale,
            Stale: stale,
            LastSuccessAt: _lastSuccessAt,
            Plan: _lastPlan,
            Gemini: _lastGemini ?? MissingGroup("gemini", "Gemini Models"),
            ClaudeGpt: _lastClaudeGpt ?? MissingGroup("claude_gpt", "Claude & GPT Models"),
            ErrorCode: null,
            ErrorMessage: null,
            BackoffUntil: null
        );
    }

    private QuotaSnapshot BuildErrorSnapshot(string code, string message)
    {
        bool hasCache = _lastGemini is not null && _lastClaudeGpt is not null;
        return new QuotaSnapshot(
            Ok: false,
            Stale: hasCache,
            LastSuccessAt: _lastSuccessAt,
            Plan: _lastPlan,
            Gemini: _lastGemini ?? MissingGroup("gemini", "Gemini Models"),
            ClaudeGpt: _lastClaudeGpt ?? MissingGroup("claude_gpt", "Claude & GPT Models"),
            ErrorCode: code,
            ErrorMessage: message,
            BackoffUntil: _nextRetryAt
        );
    }

    private QuotaSnapshot RecordFailure(string code, string message)
    {
        _consecutiveFailures++;
        var delayMs = Math.Min(BaseBackoffMs * (1 << Math.Min(_consecutiveFailures - 1, 6)), MaxBackoffMs);
        _nextRetryAt = DateTimeOffset.UtcNow.AddMilliseconds(delayMs);
        return BuildErrorSnapshot(code, message);
    }

    private async Task<string> RunAgyAsync(string agyExe, CancellationToken externalCt)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(externalCt);
        cts.CancelAfter(TimeoutMs);

        var psi = new ProcessStartInfo
        {
            FileName = agyExe,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        psi.ArgumentList.Add("-p");
        psi.ArgumentList.Add("/usage");
        psi.ArgumentList.Add("--output-format");
        psi.ArgumentList.Add("json");

        using var process = new Process { StartInfo = psi };
        _activeProcess = process;
        try
        {
            if (!process.Start())
            {
                throw new QuotaCliException("CLI_NOT_FOUND", "Failed to start agy CLI.");
            }

            var stdoutTask = process.StandardOutput.ReadToEndAsync(cts.Token);
            var stderrTask = process.StandardError.ReadToEndAsync(cts.Token);

            await process.WaitForExitAsync(cts.Token);

            var stdout = (await stdoutTask).Trim();
            var stderr = (await stderrTask).Trim();

            if (process.ExitCode != 0)
            {
                var detail = ExtractErrorText(stdout, stderr);
                throw ClassifyError(detail);
            }

            if (string.IsNullOrWhiteSpace(stdout))
            {
                throw new QuotaCliException("PARSE_ERROR", "Empty output from agy CLI.");
            }

            return stdout;
        }
        catch (OperationCanceledException)
        {
            try
            {
                if (!process.HasExited) process.Kill(entireProcessTree: true);
            }
            catch { }
            throw new QuotaCliException("TIMEOUT", $"Quota query timed out after {TimeoutMs / 1000}s.");
        }
        finally
        {
            _activeProcess = null;
        }
    }

    private static string ExtractErrorText(string stdout, string stderr)
    {
        if (stdout.StartsWith('{'))
        {
            try
            {
                using var doc = JsonDocument.Parse(stdout);
                if (doc.RootElement.TryGetProperty("error", out var errProp) && errProp.ValueKind == JsonValueKind.String)
                {
                    var text = errProp.GetString();
                    if (!string.IsNullOrWhiteSpace(text)) return text;
                }
            }
            catch { }
        }
        return !string.IsNullOrWhiteSpace(stderr) ? stderr : stdout;
    }

    private static QuotaCliException ClassifyError(string raw)
    {
        var lower = (raw ?? string.Empty).ToLowerInvariant();
        if (lower.Contains("authentication required") || lower.Contains("not authenticated") ||
            lower.Contains("unauthenticated") || lower.Contains("sign in") || lower.Contains("logged out"))
        {
            return new QuotaCliException("AUTH_REQUIRED", "CLI session is signed out. Run 'agy' to sign in.");
        }
        if (lower.Contains("no such host") || lower.Contains("dial tcp") || lower.Contains("offline") ||
            lower.Contains("network") || lower.Contains("connectex") || lower.Contains("unavailable") ||
            lower.Contains("deadline exceeded"))
        {
            return new QuotaCliException("NETWORK_ERROR", "No internet connection or quota service unreachable.");
        }
        var clean = string.IsNullOrWhiteSpace(raw) ? "Antigravity CLI returned an error." : raw;
        if (clean.Length > 180) clean = clean[..177] + "...";
        return new QuotaCliException("CLI_ERROR", clean);
    }

    private static void ParseOutput(string stdout, out QuotaGroup gemini, out QuotaGroup claudeGpt, out string? plan)
    {
        using var doc = JsonDocument.Parse(stdout);
        var root = doc.RootElement;

        if (root.TryGetProperty("status", out var statusEl) && statusEl.ValueKind == JsonValueKind.String)
        {
            var status = statusEl.GetString();
            if (!string.Equals(status, "SUCCESS", StringComparison.OrdinalIgnoreCase))
            {
                var errMsg = root.TryGetProperty("error", out var errEl) ? errEl.GetString() ?? "" : $"CLI status: {status}";
                throw ClassifyError(errMsg);
            }
        }

        JsonElement? dataEl = null;
        if (root.TryGetProperty("command", out var cmdEl) && cmdEl.ValueKind == JsonValueKind.Object &&
            cmdEl.TryGetProperty("data", out var innerData) && innerData.ValueKind == JsonValueKind.Object)
        {
            dataEl = innerData;
        }

        plan = ExtractPlan(root, dataEl);

        var gemini5h = MissingBucket("5h");
        var geminiWeekly = MissingBucket("weekly");
        var third5h = MissingBucket("5h");
        var thirdWeekly = MissingBucket("weekly");
        bool matchedAny = false;

        if (dataEl.HasValue && dataEl.Value.TryGetProperty("groups", out var groupsEl) && groupsEl.ValueKind == JsonValueKind.Array)
        {
            foreach (var grp in groupsEl.EnumerateArray())
            {
                var name = grp.TryGetProperty("name", out var nEl) ? (nEl.GetString() ?? "") : "";
                var lowerName = name.ToLowerInvariant();

                if (!grp.TryGetProperty("buckets", out var bucketsEl) || bucketsEl.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }

                bool isGemini = lowerName.Contains("gemini");
                bool isThird = lowerName.Contains("claude") || lowerName.Contains("gpt");

                foreach (var b in bucketsEl.EnumerateArray())
                {
                    var id = b.TryGetProperty("id", out var idEl) ? (idEl.GetString() ?? "").ToLowerInvariant() : "";
                    var win = b.TryGetProperty("window", out var winEl) ? (winEl.GetString() ?? "").ToLowerInvariant() : "";

                    if (!isGemini && id.StartsWith("gemini-")) isGemini = true;
                    if (!isThird && id.StartsWith("3p-")) isThird = true;

                    bool is5h = win == "5h" || id.EndsWith("-5h");
                    bool isWeekly = win == "weekly" || id.EndsWith("-weekly");
                    if (!is5h && !isWeekly) continue;

                    var parsedBucket = ParseBucket(b, is5h ? "5h" : "weekly");
                    if (parsedBucket.RemainingPercent.HasValue) matchedAny = true;

                    if (isGemini)
                    {
                        if (is5h) gemini5h = parsedBucket;
                        else geminiWeekly = parsedBucket;
                    }
                    else if (isThird)
                    {
                        if (is5h) third5h = parsedBucket;
                        else thirdWeekly = parsedBucket;
                    }
                }
            }
        }

        if (!matchedAny)
        {
            throw new QuotaCliException("PARSE_ERROR", "No valid quota buckets found in CLI response.");
        }

        gemini = new QuotaGroup("gemini", "Gemini Models", gemini5h, geminiWeekly);
        claudeGpt = new QuotaGroup("claude_gpt", "Claude & GPT Models", third5h, thirdWeekly);
    }

    private static string? ExtractPlan(JsonElement root, JsonElement? dataEl)
    {
        string[] keys = ["plan_tier", "plan_name", "subscription_plan", "plan", "tier"];
        if (dataEl.HasValue)
        {
            foreach (var k in keys)
            {
                if (dataEl.Value.TryGetProperty(k, out var el) && el.ValueKind == JsonValueKind.String)
                {
                    var val = el.GetString()?.Trim();
                    if (!string.IsNullOrEmpty(val)) return val;
                }
            }
        }
        foreach (var k in keys)
        {
            if (root.TryGetProperty(k, out var el) && el.ValueKind == JsonValueKind.String)
            {
                var val = el.GetString()?.Trim();
                if (!string.IsNullOrEmpty(val)) return val;
            }
        }
        return null;
    }

    private static QuotaBucket ParseBucket(JsonElement el, string window)
    {
        int? pct = null;
        if (el.TryGetProperty("remaining_fraction", out var fracEl) && fracEl.ValueKind == JsonValueKind.Number)
        {
            var frac = fracEl.GetDouble();
            if (double.IsFinite(frac) && frac >= 0 && frac <= 1.0001)
            {
                pct = (int)Math.Round(Math.Clamp(frac, 0.0, 1.0) * 100.0);
            }
        }

        DateTimeOffset? resetAt = null;
        bool isEpochZero = false;
        if (el.TryGetProperty("reset_time", out var resetEl) && resetEl.ValueKind == JsonValueKind.String)
        {
            var raw = resetEl.GetString();
            if (!string.IsNullOrWhiteSpace(raw) && DateTimeOffset.TryParse(raw, out var dto))
            {
                if (dto.ToUnixTimeSeconds() <= 0)
                {
                    isEpochZero = true;
                }
                else
                {
                    resetAt = dto;
                }
            }
        }

        bool isUnused = isEpochZero && pct == 100;
        return new QuotaBucket(window, pct, resetAt, isUnused, GetSeverity(pct));
    }

    private static QuotaBucket MissingBucket(string window) =>
        new(window, null, null, false, QuotaSeverity.Unknown);

    private static QuotaGroup MissingGroup(string id, string name) =>
        new(id, name, MissingBucket("5h"), MissingBucket("weekly"));
}

public sealed class QuotaCliException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
