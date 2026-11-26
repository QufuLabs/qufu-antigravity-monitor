using System.Diagnostics;
using System.Drawing;
using System.IO;
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

public partial class MainWindow : Window
{
    private readonly AgyQuotaClient _client = new();
    private readonly CancellationTokenSource _shutdownCts = new();
    private readonly DispatcherTimer _tickTimer;
    private readonly DispatcherTimer _refreshTimer;
    private readonly DispatcherTimer _watchTimer;
    private readonly WidgetSettings _settings;

    private Forms.NotifyIcon? _trayIcon;
    private QuotaSnapshot? _snapshot;
    private bool _isFetching;
    private bool _sawAntigravityRunning;
    private bool _isDark;
    private DateTime _lastConfigMtimeUtc = DateTime.MinValue;
    private bool? _cachedAntigravityDark;

    public MainWindow()
    {
        InitializeComponent();

        _settings = WidgetSettingsStore.Load();
        _sawAntigravityRunning = IsAntigravityRunning();

        ApplyExpandedState(_settings.Expanded);
        ApplyTheme();
        BuildContextMenu();
        SetupTrayIcon();

        Loaded += MainWindow_Loaded;
        Closing += MainWindow_Closing;

        _tickTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _tickTimer.Tick += (_, _) => UpdateCountdownsAndFooter();
        _tickTimer.Start();

        _refreshTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(_settings.RefreshIntervalSeconds) };
        _refreshTimer.Tick += async (_, _) => await RefreshQuotaAsync(force: false);
        _refreshTimer.Start();

        _watchTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
        _watchTimer.Tick += (_, _) => CheckThemeAndLifecycle();
        _watchTimer.Start();
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

    private void CheckThemeAndLifecycle()
    {
        if (_settings.ThemeMode == "auto")
        {
            bool nextDark = DetectAutoDarkMode();
            if (nextDark != _isDark)
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
    /// Reads ONLY Antigravity's public appearance preference (`userSettings.themeMode`)
    /// from ~/.gemini/config/config.json (read-only, zero credentials).
    /// Falls back to Windows AppsUseLightTheme when Antigravity is set to system/unspecified.
    /// </summary>
    private bool DetectAutoDarkMode()
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
                    _cachedAntigravityDark = ReadAntigravityThemeMode(cfgPath);
                }
                if (_cachedAntigravityDark.HasValue)
                {
                    return _cachedAntigravityDark.Value;
                }
            }
        }
        catch
        {
            // Fall back to Windows theme.
        }

        return DetectWindowsDarkMode();
    }

    private static bool? ReadAntigravityThemeMode(string cfgPath)
    {
        try
        {
            var json = File.ReadAllText(cfgPath);
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("userSettings", out var userSettings) &&
                userSettings.ValueKind == JsonValueKind.Object &&
                userSettings.TryGetProperty("themeMode", out var themeProp) &&
                themeProp.ValueKind == JsonValueKind.String)
            {
                var mode = (themeProp.GetString() ?? string.Empty).ToUpperInvariant();
                if (mode.Contains("LIGHT")) return false;
                if (mode.Contains("DARK")) return true;
            }
        }
        catch
        {
            // Ignore malformed or locked file during write.
        }
        return null;
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

    private void Window_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ChangedButton == MouseButton.Left)
        {
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
    }

    private async void RefreshBtn_Click(object sender, RoutedEventArgs e)
    {
        e.Handled = true;
        await RefreshQuotaAsync(force: true);
    }

    private void ExpandBtn_Click(object sender, RoutedEventArgs e)
    {
        e.Handled = true;
        _settings.Expanded = !_settings.Expanded;
        ApplyExpandedState(_settings.Expanded);
        WidgetSettingsStore.Save(_settings);
        RenderSnapshot();
    }

    private void ApplyExpandedState(bool expanded)
    {
        DetailPanel.Visibility = expanded ? Visibility.Visible : Visibility.Collapsed;
        ExpandIcon.Data = Geometry.Parse(expanded ? "M 2,8 L 6,4 L 10,8" : "M 2,4 L 6,8 L 10,4");
        ExpandBtn.ToolTip = expanded
            ? "Hide detailed progress bars"
            : "Show detailed progress bars and countdowns";
    }

    private void ApplyTheme()
    {
        _isDark = _settings.ThemeMode switch
        {
            "dark" => true,
            "light" => false,
            _ => DetectAutoDarkMode()
        };

        Resources["IconBtnHoverBrush"] = BrushFromHex(_isDark ? "#1FFFFFFF" : "#12000000");
        Resources["IconBtnPressedBrush"] = BrushFromHex(_isDark ? "#33FFFFFF" : "#22000000");

        var bg = BrushFromHex(_isDark ? "#F218181B" : "#F7FAFAFA");
        var border = BrushFromHex(_isDark ? "#3F3F46" : "#E4E4E7");
        var divider = BrushFromHex(_isDark ? "#2E2E33" : "#E4E4E7");
        var fg = BrushFromHex(_isDark ? "#F4F4F5" : "#18181B");
        var fgMuted = BrushFromHex(_isDark ? "#A1A1AA" : "#52525B");
        var fgSubtle = BrushFromHex(_isDark ? "#71717A" : "#71717A");
        var track = BrushFromHex(_isDark ? "#27272A" : "#E4E4E7");

        RootBorder.Background = bg;
        RootBorder.BorderBrush = border;

        SepMid.Background = divider;
        DetailDividerTop.Background = divider;
        DetailDividerMid.Background = divider;
        DetailDividerBot.Background = divider;

        PlanCompactText.Foreground = fgMuted;
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
        var brush = new MediaBrush(color);
        brush.Freeze();
        return brush;
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
        StatusDot.ToolTip = $"{statusLine}\nRight-click bar for Theme, Position & Interval";
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
        expandItem.Click += (_, _) =>
        {
            _settings.Expanded = !_settings.Expanded;
            ApplyExpandedState(_settings.Expanded);
            WidgetSettingsStore.Save(_settings);
            RenderSnapshot();
        };
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
        foreach (var (label, mode) in new[] { ("Auto (Antigravity)", "auto"), ("Light", "light"), ("Dark", "dark") })
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
                WidgetSettingsStore.Save(_settings);
                ApplyTheme();
                RenderSnapshot();
                BuildContextMenu();
            };
            themeMenu.Items.Add(item);
        }
        menu.Items.Add(themeMenu);

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
        catch
        {
            // Fall back to generated icon below.
        }

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
        trayMenu.Items.Add("Show / Focus", null, (_, _) =>
        {
            Show();
            Activate();
        });
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
        _trayIcon.DoubleClick += (_, _) => Dispatcher.Invoke(() =>
        {
            _settings.Expanded = !_settings.Expanded;
            ApplyExpandedState(_settings.Expanded);
            RenderSnapshot();
        });
    }
}
