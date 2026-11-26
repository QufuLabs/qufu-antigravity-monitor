using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Win32;
using Forms = System.Windows.Forms;
using MediaColor = System.Windows.Media.Color;
using MediaBrush = System.Windows.Media.SolidColorBrush;

namespace QufuUsageWidget;

public sealed record AntigravityThemeInfo(
    bool IsDark,
    string? BackgroundHex,
    string? ForegroundHex,
    string? PrimaryHex
);

public partial class MainWindow : Window
{
    private const string RunRegistrySubKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunRegistryValueName = "QufuAntigravityMonitor";

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    private readonly AgyQuotaClient _client = new();
    private readonly CancellationTokenSource _shutdownCts = new();
    private readonly DispatcherTimer _tickTimer;
    private readonly DispatcherTimer _refreshTimer;
    private readonly DispatcherTimer _watchTimer;
    private readonly DispatcherTimer _focusTimer;
    private readonly WidgetSettings _settings;
    private readonly int _currentPid = Environment.ProcessId;

    private Forms.NotifyIcon? _trayIcon;
    private QuotaSnapshot? _snapshot;
    private bool _isFetching;
    private bool _sawAntigravityRunning;
    private bool _isDark;
    private bool _isMouseOverWidget;
    private DateTime _lastConfigMtimeUtc = DateTime.MinValue;
    private AntigravityThemeInfo? _cachedAntigravityTheme;
    private string _appliedThemeSignature = string.Empty;

    public MainWindow()
    {
        InitializeComponent();

        _settings = WidgetSettingsStore.Load();
        _sawAntigravityRunning = IsAntigravityRunning();

        ApplyExpandedState(_settings.Expanded);
        ApplyTheme();
        ApplyOpacity();
        BuildContextMenu();
        SetupTrayIcon();

        Loaded += MainWindow_Loaded;
        Closing += MainWindow_Closing;
        MouseEnter += (_, _) => { _isMouseOverWidget = true; ApplyOpacity(); };
        MouseLeave += (_, _) => { _isMouseOverWidget = false; ApplyOpacity(); };

        _tickTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _tickTimer.Tick += (_, _) => UpdateCountdownsAndFooter();
        _tickTimer.Start();

        _refreshTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(_settings.RefreshIntervalSeconds) };
        _refreshTimer.Tick += async (_, _) => await RefreshQuotaAsync(force: false);
        _refreshTimer.Start();

        _watchTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
        _watchTimer.Tick += (_, _) => CheckThemeAndLifecycle();
        _watchTimer.Start();

        _focusTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(350) };
        _focusTimer.Tick += (_, _) => UpdateFocusVisibility();
        if (_settings.OnlyWhenAntigravityActive)
        {
            _focusTimer.Start();
        }
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        UpdateLayout();
        var work = SystemParameters.WorkArea;
        double width = ActualWidth > 0 ? ActualWidth : 340;
        double height = ActualHeight > 0 ? ActualHeight : 34;

        if (_settings.Left.HasValue && _settings.Top.HasValue && IsWithinVirtualScreen(_settings.Left.Value, _settings.Top.Value))
        {
            Left = Math.Clamp(_settings.Left.Value, work.Left + 4, Math.Max(work.Left + 4, work.Right - width - 4));
            Top = Math.Clamp(_settings.Top.Value, work.Top + 1, Math.Max(work.Top + 1, work.Bottom - height - 4));
        }
        else
        {
            SnapToTopbarRight();
        }

        Topmost = true;
        await RefreshQuotaAsync(force: true);
    }

    private void MainWindow_Closing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        _tickTimer.Stop();
        _refreshTimer.Stop();
        _watchTimer.Stop();
        _focusTimer.Stop();
        _shutdownCts.Cancel();
        _client.AbortActive();

        if (_trayIcon is not null)
        {
            _trayIcon.Visible = false;
            _trayIcon.Dispose();
            _trayIcon = null;
        }

        SavePosition();
    }

    private static bool IsAntigravityRunning()
    {
        try
        {
            return Process.GetProcessesByName("Antigravity").Length > 0;
        }
        catch
        {
            return false;
        }
    }

    private void UpdateFocusVisibility()
    {
        if (!_settings.OnlyWhenAntigravityActive)
        {
            if (Visibility != Visibility.Visible) Visibility = Visibility.Visible;
            return;
        }

        if (_isMouseOverWidget || (ContextMenu?.IsOpen == true))
        {
            if (Visibility != Visibility.Visible) Visibility = Visibility.Visible;
            return;
        }

        bool shouldShow = false;
        try
        {
            var hwnd = GetForegroundWindow();
            if (hwnd != IntPtr.Zero)
            {
                GetWindowThreadProcessId(hwnd, out uint fgPid);
                if (fgPid == (uint)_currentPid)
                {
                    shouldShow = true;
                }
                else if (fgPid > 0)
                {
                    using var proc = Process.GetProcessById((int)fgPid);
                    shouldShow = string.Equals(proc.ProcessName, "Antigravity", StringComparison.OrdinalIgnoreCase);
                }
            }
        }
        catch
        {
            shouldShow = true;
        }

        var nextVis = shouldShow ? Visibility.Visible : Visibility.Hidden;
        if (Visibility != nextVis)
        {
            Visibility = nextVis;
        }
    }

    private void CheckThemeAndLifecycle()
    {
        if (_settings.ThemeMode == "auto")
        {
            var theme = ResolveAutoTheme();
            var sig = $"{theme.IsDark}|{theme.BackgroundHex}|{theme.ForegroundHex}|{theme.PrimaryHex}";
            if (sig != _appliedThemeSignature)
            {
                ApplyTheme();
                RenderSnapshot();
            }
        }

        if (!_settings.AutoExitWithAntigravity) return;

        bool running = IsAntigravityRunning();
        if (running)
        {
            _sawAntigravityRunning = true;
        }
        else if (_sawAntigravityRunning)
        {
            Close();
        }
    }

    /// <summary>
    /// Reads ONLY Antigravity's public appearance settings (`themeMode`,
    /// `customThemeSeedsDark`, `customThemeSeedsLight`) from ~/.gemini/config/config.json.
    /// Zero credentials or tokens are ever read.
    /// </summary>
    private AntigravityThemeInfo ResolveAutoTheme()
    {
        try
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var cfgPath = Path.Combine(home, ".gemini", "config", "config.json");
            if (File.Exists(cfgPath))
            {
                var mtime = File.GetLastWriteTimeUtc(cfgPath);
                if (mtime != _lastConfigMtimeUtc)
                {
                    _lastConfigMtimeUtc = mtime;
                    _cachedAntigravityTheme = ReadAntigravityTheme(cfgPath);
                }
                if (_cachedAntigravityTheme is not null)
                {
                    return _cachedAntigravityTheme;
                }
            }
        }
        catch
        {
            // Fall back to Windows theme.
        }

        return new AntigravityThemeInfo(DetectWindowsDarkMode(), null, null, null);
    }

    private static AntigravityThemeInfo? ReadAntigravityTheme(string cfgPath)
    {
        try
        {
            var json = File.ReadAllText(cfgPath);
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("userSettings", out var userSettings) ||
                userSettings.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            bool? isDark = null;
            if (userSettings.TryGetProperty("themeMode", out var themeProp) &&
                themeProp.ValueKind == JsonValueKind.String)
            {
                var mode = (themeProp.GetString() ?? string.Empty).ToUpperInvariant();
                if (mode.Contains("LIGHT")) isDark = false;
                else if (mode.Contains("DARK")) isDark = true;
            }

            bool darkResolved = isDark ?? DetectWindowsDarkMode();
            string seedKey = darkResolved ? "customThemeSeedsDark" : "customThemeSeedsLight";

            string? bg = null;
            string? fg = null;
            string? primary = null;

            if (userSettings.TryGetProperty(seedKey, out var seedEl) && seedEl.ValueKind == JsonValueKind.Object)
            {
                if (seedEl.TryGetProperty("background", out var bgEl) && bgEl.ValueKind == JsonValueKind.String)
                    bg = bgEl.GetString()?.Trim();
                if (seedEl.TryGetProperty("foregroundOverride", out var fgEl) && fgEl.ValueKind == JsonValueKind.String)
                    fg = fgEl.GetString()?.Trim();
                if (seedEl.TryGetProperty("primary", out var prEl) && prEl.ValueKind == JsonValueKind.String)
                    primary = prEl.GetString()?.Trim();
            }

            return new AntigravityThemeInfo(darkResolved, bg, fg, primary);
        }
        catch
        {
            return null;
        }
    }

    private static bool DetectWindowsDarkMode()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            var val = key?.GetValue("AppsUseLightTheme");
            if (val is int intVal) return intVal == 0;
        }
        catch { }
        return false;
    }

    private static bool IsStartWithWindowsEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunRegistrySubKey, writable: false);
            var val = key?.GetValue(RunRegistryValueName) as string;
            return !string.IsNullOrWhiteSpace(val);
        }
        catch
        {
            return false;
        }
    }

    private static void SetStartWithWindows(bool enable)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunRegistrySubKey, writable: true)
                ?? Registry.CurrentUser.CreateSubKey(RunRegistrySubKey);
            if (key is null) return;

            if (enable)
            {
                var exePath = Environment.ProcessPath;
                if (!string.IsNullOrWhiteSpace(exePath))
                {
                    key.SetValue(RunRegistryValueName, $"\"{exePath}\"");
                }
            }
            else
            {
                key.DeleteValue(RunRegistryValueName, throwOnMissingValue: false);
            }
        }
        catch
        {
            // Ignore registry permission errors cleanly.
        }
    }

    private static bool IsWithinVirtualScreen(double left, double top)
    {
        var vLeft = SystemParameters.VirtualScreenLeft;
        var vTop = SystemParameters.VirtualScreenTop;
        var vRight = vLeft + SystemParameters.VirtualScreenWidth;
        var vBottom = vTop + SystemParameters.VirtualScreenHeight;
        return left >= vLeft - 20 && left <= vRight - 80 && top >= vTop - 10 && top <= vBottom - 20;
    }

    private void SnapToTopbarRight()
    {
        UpdateLayout();
        var work = SystemParameters.WorkArea;
        double width = ActualWidth > 0 ? ActualWidth : 340;
        Left = Math.Max(work.Left + 8, work.Right - width - 148);
        Top = work.Top + 1;
        SavePosition();
    }

    private void SnapToBottomLeftSidebar()
    {
        UpdateLayout();
        var work = SystemParameters.WorkArea;
        double height = ActualHeight > 0 ? ActualHeight : 34;
        Left = work.Left + 10;
        Top = Math.Max(work.Top + 8, work.Bottom - height - 46);
        SavePosition();
    }

    private void SnapToBottomRight()
    {
        UpdateLayout();
        var work = SystemParameters.WorkArea;
        double width = ActualWidth > 0 ? ActualWidth : 340;
        double height = ActualHeight > 0 ? ActualHeight : 34;
        Left = Math.Max(work.Left + 8, work.Right - width - 12);
        Top = Math.Max(work.Top + 8, work.Bottom - height - 12);
        SavePosition();
    }

    private void SavePosition()
    {
        if (double.IsFinite(Left) && double.IsFinite(Top))
        {
            _settings.Left = Math.Round(Left);
            _settings.Top = Math.Round(Top);
            WidgetSettingsStore.Save(_settings);
        }
    }

    private void ToggleExpanded()
    {
        _settings.Expanded = !_settings.Expanded;
        ApplyExpandedState(_settings.Expanded);
        WidgetSettingsStore.Save(_settings);
        RenderSnapshot();

        UpdateLayout();
        var work = SystemParameters.WorkArea;
        if (ActualWidth > 0 && Left + ActualWidth > work.Right - 4)
        {
            Left = Math.Max(work.Left + 4, work.Right - ActualWidth - 4);
        }
        if (ActualHeight > 0 && Top + ActualHeight > work.Bottom - 4)
        {
            Top = Math.Max(work.Top + 1, work.Bottom - ActualHeight - 4);
        }
    }

    private void Window_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ChangedButton != MouseButton.Left) return;

        if (e.ClickCount == 2)
        {
            e.Handled = true;
            ToggleExpanded();
            return;
        }

        try
        {
            DragMove();
            SavePosition();
        }
        catch
        {
            // Ignore DragMove race when clicking buttons.
        }
    }

    private async void RefreshBtn_Click(object sender, RoutedEventArgs e)
    {
        e.Handled = true;
        await RefreshQuotaAsync(force: true);
    }

    private void ExpandBtn_Click(object sender, RoutedEventArgs e)
    {
        e.Handled = true;
        ToggleExpanded();
    }

    private void ApplyExpandedState(bool expanded)
    {
        DetailPanel.Visibility = expanded ? Visibility.Visible : Visibility.Collapsed;
        ExpandIcon.Data = Geometry.Parse(expanded ? "M 2,8 L 6,4 L 10,8" : "M 2,4 L 6,8 L 10,4");
        ExpandBtn.ToolTip = expanded
            ? "Hide detailed progress bars (or double-click bar)"
            : "Show detailed progress bars (or double-click bar)";
    }

    private void ApplyOpacity()
    {
        double target = _isMouseOverWidget ? 1.0 : Math.Clamp(_settings.OpacityPercent, 50, 100) / 100.0;
        RootBorder.Opacity = target;
    }

    private static bool TryParseColor(string? hex, out MediaColor color)
    {
        color = default;
        if (string.IsNullOrWhiteSpace(hex)) return false;
        try
        {
            var obj = System.Windows.Media.ColorConverter.ConvertFromString(hex.Trim());
            if (obj is MediaColor c)
            {
                color = c;
                return true;
            }
        }
        catch { }
        return false;
    }

    private static MediaColor Blend(MediaColor a, MediaColor b, double t, byte alpha = 255)
    {
        t = Math.Clamp(t, 0.0, 1.0);
        return MediaColor.FromArgb(
            alpha,
            (byte)Math.Round(a.R + (b.R - a.R) * t),
            (byte)Math.Round(a.G + (b.G - a.G) * t),
            (byte)Math.Round(a.B + (b.B - a.B) * t)
        );
    }

    private static MediaBrush FrozenBrush(MediaColor c)
    {
        var b = new MediaBrush(c);
        b.Freeze();
        return b;
    }

    private void ApplyTheme()
    {
        AntigravityThemeInfo themeInfo = _settings.ThemeMode switch
        {
            "dark" => new AntigravityThemeInfo(true, null, null, null),
            "light" => new AntigravityThemeInfo(false, null, null, null),
            _ => ResolveAutoTheme()
        };

        _isDark = themeInfo.IsDark;
        _appliedThemeSignature = $"{themeInfo.IsDark}|{themeInfo.BackgroundHex}|{themeInfo.ForegroundHex}|{themeInfo.PrimaryHex}";

        // Base colors from Antigravity's active theme seed when available, else native defaults.
        MediaColor baseBg = TryParseColor(themeInfo.BackgroundHex, out var seedBg)
            ? seedBg
            : (MediaColor)System.Windows.Media.ColorConverter.ConvertFromString(_isDark ? "#18181B" : "#FAFAFA");

        MediaColor baseFg = TryParseColor(themeInfo.ForegroundHex, out var seedFg)
            ? seedFg
            : (MediaColor)System.Windows.Media.ColorConverter.ConvertFromString(_isDark ? "#F4F4F5" : "#18181B");

        bool hasAccent = TryParseColor(themeInfo.PrimaryHex, out var accentColor);

        // Slightly elevate pill surface from raw canvas background so it stays crisp on the topbar.
        MediaColor surfaceColor = _isDark
            ? Blend(baseBg, MediaColor.FromRgb(255, 255, 255), 0.05, alpha: 244)
            : Blend(baseBg, MediaColor.FromRgb(255, 255, 255), 0.20, alpha: 247);

        MediaColor borderColor = hasAccent
            ? Blend(Blend(baseBg, baseFg, _isDark ? 0.18 : 0.14), accentColor, 0.22)
            : Blend(baseBg, baseFg, _isDark ? 0.20 : 0.14);

        MediaColor dividerColor = Blend(baseBg, baseFg, _isDark ? 0.13 : 0.11);
        MediaColor trackColor = Blend(baseBg, baseFg, _isDark ? 0.12 : 0.10);
        MediaColor fgMutedColor = Blend(baseBg, baseFg, 0.68);
        MediaColor fgSubtleColor = Blend(baseBg, baseFg, 0.48);

        MediaColor hoverColor = hasAccent
            ? MediaColor.FromArgb(_isDark ? (byte)36 : (byte)28, accentColor.R, accentColor.G, accentColor.B)
            : MediaColor.FromArgb(_isDark ? (byte)32 : (byte)20, baseFg.R, baseFg.G, baseFg.B);

        MediaColor pressedColor = hasAccent
            ? MediaColor.FromArgb(_isDark ? (byte)56 : (byte)44, accentColor.R, accentColor.G, accentColor.B)
            : MediaColor.FromArgb(_isDark ? (byte)52 : (byte)36, baseFg.R, baseFg.G, baseFg.B);

        Resources["IconBtnHoverBrush"] = FrozenBrush(hoverColor);
        Resources["IconBtnPressedBrush"] = FrozenBrush(pressedColor);

        var bg = FrozenBrush(surfaceColor);
        var border = FrozenBrush(borderColor);
        var divider = FrozenBrush(dividerColor);
        var fg = FrozenBrush(baseFg);
        var fgMuted = FrozenBrush(fgMutedColor);
        var fgSubtle = FrozenBrush(fgSubtleColor);
        var track = FrozenBrush(trackColor);

        RootBorder.Background = bg;
        RootBorder.BorderBrush = border;

        SepMid.Background = divider;
        DetailDividerTop.Background = divider;
        DetailDividerMid.Background = divider;
        DetailDividerBot.Background = divider;

        PlanCompactText.Foreground = hasAccent ? FrozenBrush(accentColor) : fgMuted;
        GrpGeminiLbl.Foreground = fg;
        GrpClaudeLbl.Foreground = fg;

        LblG5h.Foreground = fgSubtle;
        LblGw.Foreground = fgSubtle;
        LblC5h.Foreground = fgSubtle;
        LblCw.Foreground = fgSubtle;
        RstG5h.Foreground = fgSubtle;
        DotSep1.Foreground = fgSubtle;
        DotSep2.Foreground = fgSubtle;

        RefreshIcon.Stroke = fgMuted;
        ExpandIcon.Stroke = fgMuted;

        HeaderGemini.Foreground = fgMuted;
        HeaderClaude.Foreground = fgMuted;
        DetLblG5h.Foreground = fg;
        DetLblGw.Foreground = fg;
        DetLblC5h.Foreground = fg;
        DetLblCw.Foreground = fg;
        DetRstG5h.Foreground = fgSubtle;
        DetRstGw.Foreground = fgSubtle;
        DetRstC5h.Foreground = fgSubtle;
        DetRstCw.Foreground = fgSubtle;

        TrackG5h.Background = track;
        TrackGw.Background = track;
        TrackC5h.Background = track;
        TrackCw.Background = track;

        FooterUpdated.Foreground = fgSubtle;
        FooterInterval.Foreground = fgSubtle;
    }

    private MediaBrush GetSeverityBrush(QuotaSeverity severity) => severity switch
    {
        QuotaSeverity.Green => BrushFromHex(_isDark ? "#22C55E" : "#16A34A"),
        QuotaSeverity.Yellow => BrushFromHex(_isDark ? "#EAB308" : "#B45309"),
        QuotaSeverity.Red => BrushFromHex(_isDark ? "#EF4444" : "#DC2626"),
        _ => BrushFromHex("#71717A")
    };

    private static MediaBrush BrushFromHex(string hex)
    {
        var color = (MediaColor)System.Windows.Media.ColorConverter.ConvertFromString(hex);
        return FrozenBrush(color);
    }

    private async Task RefreshQuotaAsync(bool force)
    {
        if (_isFetching) return;
        _isFetching = true;
        RefreshBtn.IsEnabled = false;

        try
        {
            _snapshot = await _client.FetchAsync(force, _settings.RefreshIntervalSeconds, _shutdownCts.Token);
            RenderSnapshot();
        }
        catch (OperationCanceledException)
        {
            // Closing.
        }
        finally
        {
            _isFetching = false;
            RefreshBtn.IsEnabled = true;
        }
    }

    private void RenderSnapshot()
    {
        if (_snapshot is null)
        {
            StatusDot.Fill = BrushFromHex("#71717A");
            return;
        }

        var s = _snapshot;
        var now = DateTimeOffset.UtcNow;

        StatusDot.Fill = s.Ok
            ? GetSeverityBrush(QuotaSeverity.Green)
            : s.Stale
                ? GetSeverityBrush(QuotaSeverity.Yellow)
                : GetSeverityBrush(QuotaSeverity.Red);

        if (!string.IsNullOrWhiteSpace(s.Plan))
        {
            PlanCompactText.Text = s.Plan;
            PlanCompactText.Visibility = Visibility.Visible;
        }
        else
        {
            PlanCompactText.Visibility = Visibility.Collapsed;
        }

        ApplyBucketDisplay(s.Gemini.FiveHour, ValG5h, DetValG5h, DetRstG5h, FillG5h, now);
        ApplyBucketDisplay(s.Gemini.Weekly, ValGw, DetValGw, DetRstGw, FillGw, now);
        ApplyBucketDisplay(s.ClaudeGpt.FiveHour, ValC5h, DetValC5h, DetRstC5h, FillC5h, now);
        ApplyBucketDisplay(s.ClaudeGpt.Weekly, ValCw, DetValCw, DetRstCw, FillCw, now);

        if (!string.IsNullOrWhiteSpace(s.ErrorMessage))
        {
            NoticeBorder.Visibility = Visibility.Visible;
            if (s.Stale)
            {
                NoticeBorder.Background = BrushFromHex(_isDark ? "#26EAB308" : "#1ACA8A04");
                NoticeBorder.BorderBrush = BrushFromHex(_isDark ? "#55EAB308" : "#55CA8A04");
                NoticeText.Foreground = BrushFromHex(_isDark ? "#FACC15" : "#A16207");
                NoticeText.Text = $"Stale data: {s.ErrorMessage}";
            }
            else
            {
                NoticeBorder.Background = BrushFromHex(_isDark ? "#26EF4444" : "#1ADC2626");
                NoticeBorder.BorderBrush = BrushFromHex(_isDark ? "#55EF4444" : "#55DC2626");
                NoticeText.Foreground = BrushFromHex(_isDark ? "#F87171" : "#B91C1C");
                NoticeText.Text = s.ErrorMessage;
            }
        }
        else
        {
            NoticeBorder.Visibility = Visibility.Collapsed;
        }

        UpdateCountdownsAndFooter();
        UpdateTooltips(now);
        UpdateTrayTooltip();
    }

    private void ApplyBucketDisplay(
        QuotaBucket bucket,
        TextBlock compactVal,
        TextBlock detailVal,
        TextBlock detailReset,
        Border barFill,
        DateTimeOffset now)
    {
        var pctText = bucket.RemainingPercent.HasValue ? $"{bucket.RemainingPercent.Value}%" : "--";
        var brush = GetSeverityBrush(bucket.Severity);

        compactVal.Text = pctText;
        compactVal.Foreground = brush;

        detailVal.Text = pctText;
        detailVal.Foreground = brush;
        detailReset.Text = AgyQuotaClient.FormatCountdown(bucket, now, compact: false);

        barFill.Background = brush;
        double trackWidth = 296;
        barFill.Width = bucket.RemainingPercent.HasValue
            ? Math.Round(trackWidth * Math.Clamp(bucket.RemainingPercent.Value, 0, 100) / 100.0)
            : 0;
    }

    private static string BuildBucketTooltip(string groupName, string windowLabel, QuotaBucket bucket, DateTimeOffset now)
    {
        var pct = bucket.RemainingPercent.HasValue ? $"{bucket.RemainingPercent.Value}%" : "Unavailable";
        var countdown = AgyQuotaClient.FormatCountdown(bucket, now, compact: false);
        if (bucket.IsUnused)
        {
            return $"{groupName} — {windowLabel}\nRemaining: {pct} (Full)";
        }
        if (bucket.ResetAt.HasValue)
        {
            var localReset = bucket.ResetAt.Value.ToLocalTime().ToString("dd.MM HH:mm");
            return $"{groupName} — {windowLabel}\nRemaining: {pct}\nResets in: {countdown} ({localReset})";
        }
        return $"{groupName} — {windowLabel}\nRemaining: {pct}";
    }

    private void UpdateTooltips(DateTimeOffset now)
    {
        if (_snapshot is null) return;
        PillG5h.ToolTip = BuildBucketTooltip("Gemini Models", "5-Hour Limit", _snapshot.Gemini.FiveHour, now);
        PillGw.ToolTip = BuildBucketTooltip("Gemini Models", "Weekly Limit (7 days)", _snapshot.Gemini.Weekly, now);
        PillC5h.ToolTip = BuildBucketTooltip("Claude & GPT Models", "5-Hour Limit", _snapshot.ClaudeGpt.FiveHour, now);
        PillCw.ToolTip = BuildBucketTooltip("Claude & GPT Models", "Weekly Limit (7 days)", _snapshot.ClaudeGpt.Weekly, now);

        string updatedStr = _snapshot.LastSuccessAt.HasValue
            ? _snapshot.LastSuccessAt.Value.ToLocalTime().ToString("HH:mm:ss")
            : "--";
        string statusLine = _snapshot.Ok
            ? $"Live · Updated {updatedStr}"
            : _snapshot.Stale
                ? $"Stale (Last updated {updatedStr}): {_snapshot.ErrorMessage}"
                : $"Error: {_snapshot.ErrorMessage}";
        StatusDot.ToolTip = $"{statusLine}\nDouble-click bar to expand · Right-click for settings";
    }

    private void UpdateCountdownsAndFooter()
    {
        if (_snapshot is null) return;
        var now = DateTimeOffset.UtcNow;

        var compactReset = AgyQuotaClient.FormatCountdown(_snapshot.Gemini.FiveHour, now, compact: true);
        RstG5h.Text = compactReset is "--" or "Full" ? "" : $"({compactReset})";

        DetRstG5h.Text = AgyQuotaClient.FormatCountdown(_snapshot.Gemini.FiveHour, now, compact: false);
        DetRstGw.Text = AgyQuotaClient.FormatCountdown(_snapshot.Gemini.Weekly, now, compact: false);
        DetRstC5h.Text = AgyQuotaClient.FormatCountdown(_snapshot.ClaudeGpt.FiveHour, now, compact: false);
        DetRstCw.Text = AgyQuotaClient.FormatCountdown(_snapshot.ClaudeGpt.Weekly, now, compact: false);

        if (_snapshot.LastSuccessAt.HasValue)
        {
            var local = _snapshot.LastSuccessAt.Value.ToLocalTime();
            var prefix = _snapshot.Stale ? "Stale · " : "Updated ";
            FooterUpdated.Text = $"{prefix}{local:HH:mm:ss}";
        }
        else
        {
            FooterUpdated.Text = _snapshot.ErrorMessage is not null ? "Unavailable" : "Loading...";
        }

        FooterInterval.Text = $"{_settings.RefreshIntervalSeconds}s · Right-click for menu";
        UpdateTooltips(now);
    }

    private void UpdateTrayTooltip()
    {
        if (_trayIcon is null || _snapshot is null) return;
        string g5 = _snapshot.Gemini.FiveHour.RemainingPercent?.ToString() ?? "--";
        string gw = _snapshot.Gemini.Weekly.RemainingPercent?.ToString() ?? "--";
        string c5 = _snapshot.ClaudeGpt.FiveHour.RemainingPercent?.ToString() ?? "--";
        string cw = _snapshot.ClaudeGpt.Weekly.RemainingPercent?.ToString() ?? "--";
        string tip = $"Qufu Usage: Gemini {g5}%/{gw}% | Claude {c5}%/{cw}%";
        _trayIcon.Text = tip.Length > 63 ? tip[..63] : tip;
    }

    private void BuildContextMenu()
    {
        var menu = new ContextMenu();

        var refreshItem = new MenuItem { Header = "Refresh Now" };
        refreshItem.Click += async (_, _) => await RefreshQuotaAsync(force: true);
        menu.Items.Add(refreshItem);

        var expandItem = new MenuItem { Header = "Toggle Details" };
        expandItem.Click += (_, _) => ToggleExpanded();
        menu.Items.Add(expandItem);

        menu.Items.Add(new Separator());

        var posMenu = new MenuItem { Header = "Position" };
        var posTopbar = new MenuItem { Header = "Topbar Right (Antigravity)" };
        posTopbar.Click += (_, _) => SnapToTopbarRight();
        var posSidebar = new MenuItem { Header = "Bottom-Left (Above Settings)" };
        posSidebar.Click += (_, _) => SnapToBottomLeftSidebar();
        var posBottomRight = new MenuItem { Header = "Bottom-Right" };
        posBottomRight.Click += (_, _) => SnapToBottomRight();
        posMenu.Items.Add(posTopbar);
        posMenu.Items.Add(posSidebar);
        posMenu.Items.Add(posBottomRight);
        menu.Items.Add(posMenu);

        var intervalMenu = new MenuItem { Header = "Refresh Interval" };
        foreach (int sec in new[] { 30, 60, 120, 300 })
        {
            int captured = sec;
            var item = new MenuItem
            {
                Header = sec < 60 ? $"{sec}s" : $"{sec / 60}m ({sec}s)",
                IsCheckable = true,
                IsChecked = _settings.RefreshIntervalSeconds == sec
            };
            item.Click += (_, _) =>
            {
                _settings.RefreshIntervalSeconds = captured;
                _refreshTimer.Interval = TimeSpan.FromSeconds(captured);
                WidgetSettingsStore.Save(_settings);
                BuildContextMenu();
                UpdateCountdownsAndFooter();
            };
            intervalMenu.Items.Add(item);
        }
        menu.Items.Add(intervalMenu);

        var themeMenu = new MenuItem { Header = "Theme" };
        foreach (var (label, mode) in new[] { ("Auto (Antigravity Theme)", "auto"), ("Light", "light"), ("Dark", "dark") })
        {
            string capturedMode = mode;
            var item = new MenuItem
            {
                Header = label,
                IsCheckable = true,
                IsChecked = _settings.ThemeMode == mode
            };
            item.Click += (_, _) =>
            {
                _settings.ThemeMode = capturedMode;
                _lastConfigMtimeUtc = DateTime.MinValue;
                WidgetSettingsStore.Save(_settings);
                ApplyTheme();
                RenderSnapshot();
                BuildContextMenu();
            };
            themeMenu.Items.Add(item);
        }
        menu.Items.Add(themeMenu);

        var opacityMenu = new MenuItem { Header = "Opacity" };
        foreach (int pct in new[] { 100, 90, 80, 70, 60 })
        {
            int capturedPct = pct;
            var item = new MenuItem
            {
                Header = $"{pct}%",
                IsCheckable = true,
                IsChecked = _settings.OpacityPercent == pct
            };
            item.Click += (_, _) =>
            {
                _settings.OpacityPercent = capturedPct;
                WidgetSettingsStore.Save(_settings);
                ApplyOpacity();
                BuildContextMenu();
            };
            opacityMenu.Items.Add(item);
        }
        menu.Items.Add(opacityMenu);

        menu.Items.Add(new Separator());

        var focusOnlyItem = new MenuItem
        {
            Header = "Show only when Antigravity is active",
            IsCheckable = true,
            IsChecked = _settings.OnlyWhenAntigravityActive
        };
        focusOnlyItem.Click += (_, _) =>
        {
            _settings.OnlyWhenAntigravityActive = focusOnlyItem.IsChecked;
            WidgetSettingsStore.Save(_settings);
            if (_settings.OnlyWhenAntigravityActive)
            {
                _focusTimer.Start();
                UpdateFocusVisibility();
            }
            else
            {
                _focusTimer.Stop();
                Visibility = Visibility.Visible;
            }
        };
        menu.Items.Add(focusOnlyItem);

        var startupItem = new MenuItem
        {
            Header = "Start with Windows",
            IsCheckable = true,
            IsChecked = IsStartWithWindowsEnabled()
        };
        startupItem.Click += (_, _) =>
        {
            SetStartWithWindows(startupItem.IsChecked);
            startupItem.IsChecked = IsStartWithWindowsEnabled();
        };
        menu.Items.Add(startupItem);

        var autoExitItem = new MenuItem
        {
            Header = "Auto-exit when Antigravity closes",
            IsCheckable = true,
            IsChecked = _settings.AutoExitWithAntigravity
        };
        autoExitItem.Click += (_, _) =>
        {
            _settings.AutoExitWithAntigravity = autoExitItem.IsChecked;
            WidgetSettingsStore.Save(_settings);
        };
        menu.Items.Add(autoExitItem);

        menu.Items.Add(new Separator());

        var exitItem = new MenuItem { Header = "Exit" };
        exitItem.Click += (_, _) => Close();
        menu.Items.Add(exitItem);

        ContextMenu = menu;
    }

    private void SetupTrayIcon()
    {
        Icon? appIcon = null;
        try
        {
            var exePath = Environment.ProcessPath;
            if (!string.IsNullOrEmpty(exePath) && File.Exists(exePath))
            {
                appIcon = System.Drawing.Icon.ExtractAssociatedIcon(exePath);
            }
        }
        catch { }

        if (appIcon is null)
        {
            using var bmp = new Bitmap(16, 16);
            using (var g = Graphics.FromImage(bmp))
            {
                g.Clear(System.Drawing.Color.FromArgb(24, 24, 27));
                using var gBrush = new SolidBrush(System.Drawing.Color.FromArgb(34, 197, 94));
                using var yBrush = new SolidBrush(System.Drawing.Color.FromArgb(234, 179, 8));
                g.FillRectangle(gBrush, 2, 3, 12, 3);
                g.FillRectangle(yBrush, 2, 7, 8, 3);
                g.FillRectangle(gBrush, 2, 11, 11, 3);
            }
            appIcon = System.Drawing.Icon.FromHandle(bmp.GetHicon());
        }

        var trayMenu = new Forms.ContextMenuStrip();
        trayMenu.Items.Add("Show / Focus", null, (_, _) => Dispatcher.Invoke(() =>
        {
            Visibility = Visibility.Visible;
            Show();
            Activate();
        }));
        trayMenu.Items.Add("Refresh Now", null, async (_, _) => await RefreshQuotaAsync(force: true));
        trayMenu.Items.Add("Snap to Topbar Right", null, (_, _) => Dispatcher.Invoke(SnapToTopbarRight));
        trayMenu.Items.Add("Snap to Bottom-Left", null, (_, _) => Dispatcher.Invoke(SnapToBottomLeftSidebar));
        trayMenu.Items.Add(new Forms.ToolStripSeparator());
        trayMenu.Items.Add("Exit", null, (_, _) => Dispatcher.Invoke(Close));

        _trayIcon = new Forms.NotifyIcon
        {
            Icon = appIcon,
            Text = "Qufu Antigravity Monitor",
            Visible = true,
            ContextMenuStrip = trayMenu
        };
        _trayIcon.DoubleClick += (_, _) => Dispatcher.Invoke(ToggleExpanded);
    }
}
