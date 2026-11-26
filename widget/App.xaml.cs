using System.IO;
using System.Threading;
using System.Windows;

namespace QufuUsageWidget;

public partial class App : System.Windows.Application
{
    private Mutex? _singleInstanceMutex;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        DispatcherUnhandledException += (_, args) =>
        {
            LogError("DispatcherUnhandledException", args.Exception);
        };
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
        {
            if (args.ExceptionObject is Exception ex) LogError("UnhandledException", ex);
        };

        _singleInstanceMutex = new Mutex(true, "Local\\QufuUsageMonitorWidget_SingleInstance_v1", out bool createdNew);
        if (!createdNew)
        {
            Shutdown(0);
            return;
        }

        try
        {
            var mainWindow = new MainWindow();
            MainWindow = mainWindow;
            mainWindow.Show();
            mainWindow.Activate();
        }
        catch (Exception ex)
        {
            LogError("OnStartup", ex);
            System.Windows.MessageBox.Show(
                $"Qufu Antigravity Monitor failed to start:\n{ex.Message}",
                "Qufu Antigravity Monitor",
                MessageBoxButton.OK,
                MessageBoxImage.Error
            );
            Shutdown(1);
        }
    }

    private static void LogError(string source, Exception ex)
    {
        try
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var dir = Path.Combine(home, ".gemini", "antigravity", "plugin_data", "qufu-usage-monitor");
            Directory.CreateDirectory(dir);
            var logPath = Path.Combine(dir, "widget-error.log");
            File.AppendAllText(logPath, $"[{DateTimeOffset.Now:O}] {source}: {ex}\n\n");
        }
        catch
        {
            // Ignore logging error.
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        try
        {
            _singleInstanceMutex?.ReleaseMutex();
            _singleInstanceMutex?.Dispose();
        }
        catch
        {
            // Ignore mutex cleanup error on exit.
        }
        base.OnExit(e);
    }
}
