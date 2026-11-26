# Qufu Antigravity Monitor

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform: Windows 10/11](https://img.shields.io/badge/Platform-Windows%2010%2F11-blue.svg)](#requirements)
[![Antigravity 2.0](https://img.shields.io/badge/Antigravity-2.0%20Desktop-informational.svg)](https://antigravity.google)

Local, lightweight, zero-telemetry model quota monitor plugin (**MCP Apps**) and optional Windows always-on-top mini bar for **Google Antigravity 2.0 Desktop**.

Displays real-time remaining usage percentages and local 1-second reset countdowns for:

- **Gemini Models** — 5-Hour Limit and Weekly Limit
- **Claude & GPT Models** — 5-Hour Limit and Weekly Limit

## Features

- **Zero model tokens consumed:** Uses the official `agy -p "/usage" --output-format json` command (`num_turns: 0`, `total_tokens: 0`).
- **Two integrated views:**
  - **Native Antigravity MCP App Plugin:** Open beside any conversation in the Auxiliary Side Panel (`aux_pane`, pinnable via Right-click → **Pin Tab**) or full-width from **Plugins** in the left sidebar (`global`).
  - **Windows Always-on-Top Mini Bar:** Borderless single-line bar that blends into Antigravity's top bar or sidebar area — always visible without clicking away from your chat.
- **Automatic Antigravity Theme Sync:** Reads Antigravity's active theme mode and custom color palette (`customThemeSeedsDark` / `customThemeSeedsLight`) to match your exact Antigravity theme automatically.
- **Right-Click Controls:**
  - Double-click anywhere on the bar to expand/collapse detailed 4-bar view.
  - **Position:** Topbar Right, Bottom-Left (Above Settings), Bottom-Right, or drag anywhere.
  - **Theme:** Auto (Antigravity Theme), Light, or Dark.
  - **Opacity:** `100%`, `90%`, `80%`, `70%`, `60%` (restores to `100%` on hover).
  - **Refresh Interval:** `30s`, `60s` (default), `2m`, `5m`.
  - **Show only when Antigravity is active:** Auto-hides when switching to other apps.
  - **Start with Windows:** Optional user-level startup toggle (no admin rights required).
  - **Auto-exit when Antigravity closes:** Leaves no lingering background processes.

> **Note on Subscription Plan:** On Antigravity CLI `v1.5.17`, `agy -p "/usage" --output-format json` returns quota groups and buckets without a subscription tier field. Qufu Antigravity Monitor displays the plan automatically if exposed by future CLI versions and never fabricates missing data.

## Requirements

- **Google Antigravity 2.0 Desktop** (`v2.34.0+`) on Windows 10/11
- **Google Antigravity CLI (`agy`)** installed and signed in (shares Antigravity's OS keyring):
  ```powershell
  irm https://antigravity.google/cli/install.ps1 | iex
  ```
- **.NET 8 Desktop Runtime** (for the Windows Always-on-Top mini bar)
- **Node.js 20+** (only required when building from source)

## Installation

### Option 1: Direct Install (Recommended)

- **Antigravity MCP App Plugin (1 command):**
  ```powershell
  agy plugin install https://github.com/QufuLabs/qufu-antigravity-monitor
  ```
- **Windows Always-on-Top Mini Bar:** Download and run `QufuAntigravityMonitor-win-x64.exe` from [GitHub Releases](https://github.com/QufuLabs/qufu-antigravity-monitor/releases) (no installer or admin rights required).

### Option 2: Build & Install from Source

```powershell
git clone https://github.com/QufuLabs/qufu-antigravity-monitor.git
cd qufu-antigravity-monitor

# 1. Build, strictly validate, and install the Antigravity MCP App plugin
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1

# 2. Build and launch the Windows Always-on-Top mini bar
powershell -ExecutionPolicy Bypass -File .\scripts\start-widget.ps1

# 3. Create Desktop and Start Menu shortcuts
powershell -ExecutionPolicy Bypass -File .\scripts\create-shortcuts.ps1
```

### Uninstall

Removes the plugin, Desktop/Start Menu shortcuts, and Windows startup entry (if enabled):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

## Development & Testing

```powershell
npm install
npm run build
npm test
dotnet build .\widget\QufuUsageWidget.csproj -c Release
```

## Security & Privacy

- **Zero third-party servers, telemetry, or analytics.**
- **Zero credential access:** Never reads OAuth tokens, refresh tokens, cookies, passwords, or API keys.
- **Zero workspace/chat access:** Never reads project files or conversation history.
- **Non-invasive:** Never modifies Antigravity binaries, `app.asar`, or model limits; never uses DevTools or remote debugging.
- **No auto-downloads or auto-updates.**
- **No console window flashes:** Spawns `agy` directly with `shell: false` / `windowsHide: true` / `CreateNoWindow = true`.
- **Resilient polling:** Single-flight concurrency lock, shared cache, `15s` timeout, exponential backoff (`15s`–`300s`), and honest stale indicators when offline.

## FAQ

**Does Qufu Antigravity Monitor consume model tokens or create background AI chats?**
No. It runs the official `agy -p "/usage" --output-format json` command, which is handled directly by the Antigravity CLI with `num_turns: 0` and `total_tokens: 0`.

**Does it modify Antigravity's `app.asar` or executable files?**
No. The plugin uses Antigravity's official MCP Apps API (`aux_pane` and `global` entrypoints), and the optional Windows mini bar is a standalone read-only overlay that never patches or injects into Antigravity.

**Which AI model quotas are tracked?**
Both **Gemini Models** (5-hour and weekly limits) and **Claude & GPT Models** (5-hour and weekly limits), along with local 1-second reset countdowns.

**Does it work on macOS and Linux?**
The Antigravity **MCP App plugin** (`dist/mcp-server.mjs` + `dist/ui.html`) is cross-platform Node.js and works on Windows, macOS, and Linux. The optional always-on-top mini bar (`QufuUsageWidget.exe`) is Windows 10/11 only.

**Why does it match my custom Antigravity theme automatically?**
In `Auto (Antigravity Theme)` mode, the mini bar reads only your local appearance preference (`themeMode`, `customThemeSeedsDark`, `customThemeSeedsLight`) from `~/.gemini/config/config.json` and adapts its surface, border, and hover palette in real time.

## License

[MIT](LICENSE) © QufuLabs
