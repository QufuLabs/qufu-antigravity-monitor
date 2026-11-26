import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(rootDir, 'dist');
mkdirSync(distDir, { recursive: true });

// 1. Bundle the MCP stdio server into a single self-contained Node.js ESM file (zero runtime deps).
await build({
  entryPoints: [join(rootDir, 'src', 'mcp-server.mjs')],
  outfile: join(distDir, 'mcp-server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  minify: false,
  legalComments: 'none',
});

// 2. Bundle the MCP App UI script with official @modelcontextprotocol/ext-apps SDK.
const uiBundleResult = await build({
  entryPoints: [join(rootDir, 'src', 'ui', 'app.mjs')],
  bundle: true,
  write: false,
  platform: 'browser',
  target: ['es2022'],
  format: 'esm',
  minify: true,
  legalComments: 'none',
});

const jsCode = uiBundleResult.outputFiles[0].text;
const cssCode = readFileSync(join(rootDir, 'src', 'ui', 'styles.css'), 'utf-8');
const templateHtml = readFileSync(join(rootDir, 'src', 'ui', 'template.html'), 'utf-8');

// Escape closing script/style tags defensively when inlining.
const safeJs = jsCode.replace(/<\/script/gi, '<\\/script');
const safeCss = cssCode.replace(/<\/style/gi, '<\\/style');

const singleFileHtml = templateHtml
  .replace('/*__INLINE_CSS__*/', () => safeCss)
  .replace('/*__INLINE_JS__*/', () => safeJs);

writeFileSync(join(distDir, 'ui.html'), singleFileHtml, 'utf-8');

const serverBytes = Buffer.byteLength(readFileSync(join(distDir, 'mcp-server.mjs')));
const htmlBytes = Buffer.byteLength(singleFileHtml, 'utf-8');
console.log(
  `Built dist/mcp-server.mjs (${(serverBytes / 1024).toFixed(1)} KiB) and dist/ui.html (${(htmlBytes / 1024).toFixed(1)} KiB)`
);
