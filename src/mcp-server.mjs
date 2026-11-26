import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

import { createAgyCliRunner } from './cli-resolver.mjs';
import { createSettingsStore } from './settings-store.mjs';
import { formatPlainTextSummary } from './usage-parser.mjs';
import { createUsageService } from './usage-service.mjs';

export const SERVER_NAME = 'qufu-usage-monitor';
export const SERVER_VERSION = '1.0.0';
export const UI_RESOURCE_URI = 'ui://qufu-usage-monitor/index.html';
export const UI_MIME_TYPE = 'text/html;profile=mcp-app';

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

/**
 * Tool definitions advertised over MCP `tools/list`.
 * Includes Antigravity `aux_pane` and `global` entrypoints on the main view tool,
 * plus app-only helper tools hidden from the model.
 */
export function getToolDefinitions() {
  return [
    {
      name: 'usage_monitor',
      title: 'Usage Monitor',
      description:
        'Open Qufu Usage Monitor to display real-time Gemini, Claude, and GPT 5-hour and weekly quota limits.',
      inputSchema: {
        type: 'object',
        properties: {
          force: {
            type: 'boolean',
            description: 'Bypass cache and run a fresh quota check immediately.',
          },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: UI_RESOURCE_URI,
          visibility: ['model', 'app'],
        },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: 'Usage Monitor' },
            { type: 'global', title: 'Usage Monitor' },
          ],
        },
      },
    },
    {
      name: 'get_usage',
      title: 'Get Usage Quota',
      description: 'Read cached or refreshed quota data for the Usage Monitor view.',
      inputSchema: {
        type: 'object',
        properties: {
          force: {
            type: 'boolean',
            description: 'When true, bypass cache TTL and backoff to refresh immediately.',
          },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    {
      name: 'set_config',
      title: 'Set Monitor Configuration',
      description: 'Persist auto-refresh interval settings for Qufu Usage Monitor.',
      inputSchema: {
        type: 'object',
        properties: {
          refreshIntervalSeconds: {
            type: 'integer',
            minimum: 15,
            maximum: 3600,
            description: 'Auto-refresh interval in seconds (default 60).',
          },
        },
        required: ['refreshIntervalSeconds'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
  ];
}

/**
 * Creates a testable MCP JSON-RPC 2.0 request handler.
 *
 * @param {object} options
 * @param {ReturnType<typeof createUsageService>} options.usageService
 * @param {() => string} options.loadUiHtml
 */
export function createMcpHandler({ usageService, loadUiHtml }) {
  async function handleMessage(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
      return {
        jsonrpc: '2.0',
        id: msg?.id ?? null,
        error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request.' },
      };
    }

    const { id, method, params } = msg;
    const isNotification = id === undefined;

    if (typeof method !== 'string') {
      if (isNotification) return null;
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32600, message: 'Missing method name.' },
      };
    }

    // Notifications require no JSON-RPC response.
    if (isNotification) {
      return null;
    }

    try {
      switch (method) {
        case 'initialize': {
          const requestedVersion =
            typeof params?.protocolVersion === 'string' && params.protocolVersion.trim()
              ? params.protocolVersion.trim()
              : DEFAULT_PROTOCOL_VERSION;
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: requestedVersion,
              capabilities: {
                tools: { listChanged: false },
                resources: { listChanged: false },
                extensions: {
                  'io.modelcontextprotocol/ui': {
                    mimeTypes: [UI_MIME_TYPE],
                  },
                },
              },
              serverInfo: {
                name: SERVER_NAME,
                version: SERVER_VERSION,
              },
            },
          };
        }

        case 'ping': {
          return { jsonrpc: '2.0', id, result: {} };
        }

        case 'tools/list': {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              tools: getToolDefinitions(),
            },
          };
        }

        case 'tools/call': {
          const toolName = params?.name;
          const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};

          if (toolName === 'usage_monitor' || toolName === 'get_usage') {
            const snapshot = await usageService.getUsage({ force: Boolean(args.force) });
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: formatPlainTextSummary(snapshot),
                  },
                ],
                structuredContent: snapshot,
                isError: false,
              },
            };
          }

          if (toolName === 'set_config') {
            const updated = usageService.updateConfig({
              refreshIntervalSeconds: args.refreshIntervalSeconds,
            });
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: `Auto-refresh interval set to ${updated.settings.refreshIntervalSeconds}s.`,
                  },
                ],
                structuredContent: updated,
                isError: false,
              },
            };
          }

          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32602,
              message: `Unknown tool: ${String(toolName)}`,
            },
          };
        }

        case 'resources/list': {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              resources: [
                {
                  uri: UI_RESOURCE_URI,
                  name: 'Qufu Usage Monitor',
                  description: 'Compact local model quota monitor interface.',
                  mimeType: UI_MIME_TYPE,
                  _meta: {
                    ui: {
                      prefersBorder: false,
                    },
                  },
                },
              ],
            },
          };
        }

        case 'resources/templates/list': {
          return {
            jsonrpc: '2.0',
            id,
            result: { resourceTemplates: [] },
          };
        }

        case 'resources/read': {
          const uri = params?.uri;
          if (uri !== UI_RESOURCE_URI) {
            return {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32002,
                message: `Resource not found: ${String(uri)}`,
              },
            };
          }

          const html = loadUiHtml();
          return {
            jsonrpc: '2.0',
            id,
            result: {
              contents: [
                {
                  uri: UI_RESOURCE_URI,
                  mimeType: UI_MIME_TYPE,
                  text: html,
                  _meta: {
                    ui: {
                      prefersBorder: false,
                    },
                  },
                },
              ],
            },
          };
        }

        case 'prompts/list': {
          return {
            jsonrpc: '2.0',
            id,
            result: { prompts: [] },
          };
        }

        default: {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          };
        }
      }
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : 'Internal server error.',
        },
      };
    }
  }

  return { handleMessage };
}

/**
 * Starts the newline-delimited JSON-RPC 2.0 MCP stdio server.
 */
export function startStdioServer(options = {}) {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const uiHtmlPath = options.uiHtmlPath ?? process.env.QUFU_UI_HTML ?? join(currentDir, 'ui.html');

  const settingsStore = createSettingsStore({ dataDir: options.dataDir });
  const runner = createAgyCliRunner({ timeoutMs: options.timeoutMs });
  const usageService = createUsageService({ runner, settingsStore });

  const loadUiHtml = () => {
    return readFileSync(uiHtmlPath, 'utf-8');
  };

  const handler = createMcpHandler({ usageService, loadUiHtml });

  function writeMessage(payload) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      writeMessage({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON.' },
      });
      return;
    }

    handler
      .handleMessage(parsed)
      .then((response) => {
        if (response !== null) {
          writeMessage(response);
        }
      })
      .catch((err) => {
        if (parsed?.id !== undefined) {
          writeMessage({
            jsonrpc: '2.0',
            id: parsed.id,
            error: {
              code: -32603,
              message: err instanceof Error ? err.message : 'Unhandled server error.',
            },
          });
        }
      });
  });

  let exiting = false;
  function shutdown() {
    if (exiting) return;
    exiting = true;
    try {
      rl.close();
    } catch {
      // Ignore close error.
    }
    usageService.shutdown();
    process.exit(0);
  }

  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Auto-start when executed directly as the MCP stdio server entrypoint.
const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase();

if (isDirectRun) {
  startStdioServer();
}
