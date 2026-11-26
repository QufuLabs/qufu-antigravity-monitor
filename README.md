# Qufu Antigravity Monitor

Local, lightweight, zero-telemetry model quota monitor plugin and Windows always-on-top mini bar for **Google Antigravity 2.0 Desktop**.

Displays real-time remaining usage percentages and local 1-second reset countdowns for:

- **Gemini Models** (5-Hour Limit and Weekly Limit)
- **Claude & GPT Models** (5-Hour Limit and Weekly Limit)

## Architecture

Qufu Usage Monitor uses Antigravity's official **Native Plugin + MCP Apps** (`io.modelcontextprotocol/ui` + `com.google.antigravity/ui`) architecture:

- **Zero-dependency runtime MCP server** (`dist/mcp-server.mjs`): Local `stdio` JSON-RPC 2.0 server managed directly by Antigravity Desktop. Exits cleanly when Antigravity closes.
- **Official zero-token CLI data source**: Executes `agy -p "/usage" --output-format json` directly via `execFile` (`shell: false`, `windowsHide: true`). Consumes `0` model tokens and creates no AI chats.
- **Single-file MCP App UI** (`dist/ui.html`): Built with the official `@modelcontextprotocol/ext-apps` SDK (`2.0.4`), adapts automatically to Light and Dark Mode via host CSS variables, and runs under Antigravity's default-deny CSP.
- **Dual official entrypoints**:
  - **Auxiliary Side Panel (`aux_pane`)**: Open beside any conversation via **Overview > Plugins > Usage Monitor** or side panel **`+`** menu, and right-click the tab to **Pin Tab**.
  - **Left Sidebar Global View (`global`)**: Open full-width from **Plugins > Usage Monitor** in the left sidebar.

> **Note on Subscription Plan**: On Antigravity CLI `v1.5.17`, `agy -p "/usage" --output-format json` returns quota groups and buckets but does not expose a subscription tier field. Qufu Usage Monitor displays the plan label automatically if returned by the CLI and otherwise displays `Plan: --` without fabricating data.

## Requirements

- **Google Antigravity 2.0 Desktop** (`v2.34.0+`) on Windows 10/11
- **Google Antigravity CLI (`agy`)** installed and signed in (uses Antigravity's unified OS keyring session):
  ```powershell
  irm https://antigravity.google/cli/install.ps1 | iex
  ```
- **Node.js 20+** (only required for building from source; Antigravity Desktop also provides a bundled Node.js fallback for `"command": "node"` MCP servers)

## Install / Uninstall

Run from PowerShell (no administrator privileges required):

```powershell
# Build, strictly validate, and install globally across all workspaces
powershell -ExecutionPolicy Bypass -File D:\QufuUsageMonitor\scripts\install.ps1

# Uninstall
powershell -ExecutionPolicy Bypass -File D:\QufuUsageMonitor\scripts\uninstall.ps1
```

## Always-on-Top Mini Bar (Windows)

Because Antigravity 2.0 Desktop does not officially expose a left-sidebar status slot or top title-bar slot for third-party plugins, Qufu Usage Monitor also includes an optional, zero-dependency native Windows WPF Always-on-Top mini bar (`widget/QufuUsageWidget.csproj`):

- Aligns neatly to Antigravity's top bar (right of menu, left of window controls) or snaps to bottom-left above **Settings** via right-click menu.
- Draggable anywhere; remembers its position, theme (`Auto` / `Light` / `Dark`), and refresh interval (`30s` / `60s` / `2m` / `5m`).
- Uses the exact same zero-token `agy -p "/usage" --output-format json` command (`CreateNoWindow = true`, zero Antigravity file modifications).
- Automatically exits when Antigravity Desktop closes (toggleable via right-click menu).

```powershell
# Start the Always-on-Top mini bar
powershell -ExecutionPolicy Bypass -File D:\QufuUsageMonitor\scripts\start-widget.ps1

# Stop the mini bar
powershell -ExecutionPolicy Bypass -File D:\QufuUsageMonitor\scripts\stop-widget.ps1
```

## Development & Tests

```powershell
cd D:\QufuUsageMonitor
npm install
npm run build
npm test
```

## Security Guarantees

- No third-party servers, telemetry, or analytics.
- Never reads OAuth tokens, refresh tokens, cookies, passwords, or API keys.
- Never reads workspace files or conversation history.
- Never modifies Antigravity binaries, source files, or quota limits.
- Never uses remote debugging or DevTools injection.
- Never auto-downloads or auto-updates code.
- Never spawns visible CMD/PowerShell windows (`shell: false`, `windowsHide: true`).
- Shared single-flight cache with timeout (`15s`) and exponential backoff (`15s` up to `300s`).
