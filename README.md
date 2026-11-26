# Qufu Antigravity Monitor

Local, lightweight, zero-telemetry model quota monitor plugin (**MCP Apps**) and optional Windows always-on-top mini bar for **Google Antigravity 2.0 Desktop**.

Displays real-time remaining usage percentages and local 1-second reset countdowns for:

- **Gemini Models** (5-Hour Limit and Weekly Limit)
- **Claude & GPT Models** (5-Hour Limit and Weekly Limit)

## Highlights

- **Zero model tokens consumed:** Reads official `agy -p "/usage" --output-format json` (`num_turns: 0`, `total_tokens: 0`).
- **Two seamless views:**
  - **Native Antigravity MCP App Plugin:** Open in the right-hand Auxiliary Side Panel (`aux_pane`, pinnable via Right-click → **Pin Tab**) or full-width from **Plugins** in the left sidebar (`global`).
  - **Windows Always-on-Top Mini Bar (`QufuUsageWidget.exe`):** Compact single-line bar that sits cleanly in Antigravity's top bar or sidebar area — zero clicks required while coding.
- **Automatic Antigravity Theme Sync:** Reads Antigravity's active theme mode and custom theme color palette (`customThemeSeedsDark` / `customThemeSeedsLight`) to match your exact Antigravity theme automatically.
- **Customizable Right-Click Menu:**
  - Double-click anywhere on the bar to expand/collapse detailed 4-bar view.
  - **Position presets:** Topbar Right, Bottom-Left (Above Settings), Bottom-Right, or drag anywhere.
  - **Theme:** Auto (Antigravity Theme), Light, or Dark.
  - **Opacity:** `100%`, `90%`, `80%`, `70%`, `60%` (automatically restores to `100%` on hover).
  - **Refresh Interval:** `30s`, `60s` (default), `2m`, `5m`.
  - **Show only when Antigravity is active:** Auto-hide when switching to other apps, reappear when Antigravity is focused.
  - **Start with Windows:** Optional single-click user-level startup toggle (no admin required).
  - **Auto-exit when Antigravity closes:** Prevents lingering background processes.

> **Note on Subscription Plan:** On Antigravity CLI `v1.5.17`, `agy -p "/usage" --output-format json` returns quota groups and buckets without a subscription tier field. Qufu Antigravity Monitor displays the plan automatically if returned by future CLI versions and never fabricates data.

## Requirements

- **Google Antigravity 2.0 Desktop** (`v2.34.0+`) on Windows 10/11
- **Google Antigravity CLI (`agy`)** installed and signed in (shares Antigravity's OS keyring):
  ```powershell
  irm https://antigravity.google/cli/install.ps1 | iex
  ```
- **Node.js 20+** (for building the MCP plugin from source) and **.NET 8 Desktop Runtime / SDK** (for the Windows mini bar)

## Quick Install (Windows)

```powershell
# 1. Build, strictly validate, and install the Antigravity MCP App plugin globally
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1

# 2. Build & start the Always-on-Top mini bar
powershell -ExecutionPolicy Bypass -File .\scripts\start-widget.ps1

# 3. Create Desktop & Start Menu shortcuts (with custom icon)
powershell -ExecutionPolicy Bypass -File .\scripts\create-shortcuts.ps1
```

To uninstall completely (plugin, shortcuts, and Windows startup entry):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

## Development & Tests

```powershell
npm install
npm run build
npm test
dotnet build .\widget\QufuUsageWidget.csproj -c Release
```

## Security Guarantees

- No third-party servers, telemetry, or analytics.
- Never reads OAuth tokens, refresh tokens, cookies, passwords, or API keys.
- Never reads workspace files or conversation history.
- Never modifies Antigravity binaries, `app.asar`, source files, or quota limits.
- Never uses remote debugging or DevTools injection.
- Never auto-downloads or auto-updates code.
- Never flashes visible CMD/PowerShell windows (`shell: false`, `windowsHide: true`, `CreateNoWindow = true`).
- Shared single-flight cache with timeout (`15s`) and exponential backoff (`15s` up to `300s`).

## Credits

Built with [Google Antigravity](https://github.com/google-antigravity). Licensed under the [MIT License](LICENSE).
