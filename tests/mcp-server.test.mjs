import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createMcpHandler,
  UI_MIME_TYPE,
  UI_RESOURCE_URI,
} from '../src/mcp-server.mjs';
import { createSettingsStore } from '../src/settings-store.mjs';
import { createUsageService } from '../src/usage-service.mjs';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

const MOCK_USAGE_STDOUT = JSON.stringify({
  status: 'SUCCESS',
  usage: { total_tokens: 0 },
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-5h', window: '5h', remaining_fraction: 0.8, reset_time: '2026-11-26T10:00:00Z' },
            { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.9, reset_time: '2026-12-02T10:00:00Z' },
          ],
        },
        {
          name: 'Claude and GPT models',
          buckets: [
            { id: '3p-5h', window: '5h', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
            { id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
          ],
        },
      ],
    },
  },
});

test('handles MCP Apps protocol methods, entrypoints, visibility, and UI resource', async () => {
  const usageService = createUsageService({
    runner: { async fetchUsageJson() { return { stdout: MOCK_USAGE_STDOUT }; } },
    settingsStore: createSettingsStore({ dataDir: null }),
  });

  const builtHtml = readFileSync(join(rootDir, 'dist', 'ui.html'), 'utf-8');
  const handler = createMcpHandler({
    usageService,
    loadUiHtml: () => builtHtml,
  });

  // 1. initialize
  const initRes = await handler.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {} },
  });
  assert.equal(initRes.result.protocolVersion, '2025-06-18');
  assert.ok(initRes.result.capabilities.resources);
  assert.ok(initRes.result.capabilities.tools);
  assert.deepEqual(initRes.result.capabilities.extensions['io.modelcontextprotocol/ui'].mimeTypes, [
    UI_MIME_TYPE,
  ]);

  // 2. notifications/initialized produces no response
  const notifRes = await handler.handleMessage({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  assert.equal(notifRes, null);

  // 3. tools/list advertises aux_pane + global entrypoints and app-only tools
  const toolsRes = await handler.handleMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  });
  const tools = toolsRes.result.tools;
  const monitorTool = tools.find((t) => t.name === 'usage_monitor');
  const getUsageTool = tools.find((t) => t.name === 'get_usage');
  const setConfigTool = tools.find((t) => t.name === 'set_config');

  assert.ok(monitorTool);
  assert.equal(monitorTool._meta.ui.resourceUri, UI_RESOURCE_URI);
  assert.deepEqual(monitorTool._meta['com.google.antigravity/ui'].entrypoints, [
    { type: 'aux_pane', title: 'Usage Monitor' },
    { type: 'global', title: 'Usage Monitor' },
  ]);
  assert.deepEqual(getUsageTool._meta.ui.visibility, ['app']);
  assert.deepEqual(setConfigTool._meta.ui.visibility, ['app']);

  // 4. resources/read returns single self-contained HTML under 10 MiB with no external assets
  const resRead = await handler.handleMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'resources/read',
    params: { uri: UI_RESOURCE_URI },
  });
  const content = resRead.result.contents[0];
  assert.equal(content.mimeType, UI_MIME_TYPE);
  assert.ok(content.text.includes('<!doctype html>'));
  assert.ok(Buffer.byteLength(content.text, 'utf-8') < 10 * 1024 * 1024);
  assert.equal(/<script[^>]+src=/i.test(content.text), false);
  assert.equal(/<link[^>]+href=/i.test(content.text), false);

  // 5. tools/call usage_monitor returns structuredContent + plain text
  const callRes = await handler.handleMessage({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'usage_monitor', arguments: {} },
  });
  assert.equal(callRes.result.isError, false);
  assert.equal(callRes.result.structuredContent.ok, true);
  assert.equal(callRes.result.structuredContent.data.groups[0].fiveHour.remainingPercent, 80);
  assert.match(callRes.result.content[0].text, /Gemini Models: 5h 80%/);

  // 6. tools/call set_config updates interval
  const cfgRes = await handler.handleMessage({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'set_config', arguments: { refreshIntervalSeconds: 120 } },
  });
  assert.equal(cfgRes.result.structuredContent.settings.refreshIntervalSeconds, 120);

  // 7. unknown tool returns -32602
  const unknownTool = await handler.handleMessage({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'nonexistent', arguments: {} },
  });
  assert.equal(unknownTool.error.code, -32602);
});

test('bundled dist/mcp-server.mjs responds over stdio and exits cleanly on stdin EOF', async () => {
  const serverPath = join(rootDir, 'dist', 'mcp-server.mjs');
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const responses = [];
  let buffer = '';

  const donePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out waiting for stdio MCP server to exit'));
    }, 10_000);

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) {
          responses.push(JSON.parse(line));
        }
      }
      if (responses.length >= 2) {
        child.stdin.end();
      }
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`
  );
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`);

  const exitCode = await donePromise;
  assert.equal(exitCode, 0);
  assert.equal(responses.length, 2);
  assert.equal(responses[0].result.serverInfo.name, 'qufu-usage-monitor');
  assert.deepEqual(responses[1].result, {});
});
