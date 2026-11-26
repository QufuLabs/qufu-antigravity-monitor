import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_DETAIL_LEN = 240;

/**
 * Checks whether a path exists and is a regular file.
 * @param {string} filePath
 * @returns {boolean}
 */
function isRegularFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves the official Antigravity CLI (`agy`) binary without invoking a shell.
 * Prefers direct executable paths so Windows never flashes a console window.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.platform]
 * @param {string} [options.homeDir]
 * @returns {string | null}
 */
export function resolveAgyBinary(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? homedir();
  const isWin = platform === 'win32';

  // 1. Optional explicit override (must point to an existing file).
  const override = env.QUFU_AGY_PATH?.trim();
  if (override && isRegularFile(override)) {
    return override;
  }

  // 2. Official default installation paths from https://antigravity.google/docs/getting-started
  const candidates = [];
  if (isWin) {
    const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    candidates.push(join(localAppData, 'agy', 'bin', 'agy.exe'));
    candidates.push(join(home, '.local', 'bin', 'agy.exe'));
  } else {
    candidates.push(join(home, '.local', 'bin', 'agy'));
    candidates.push('/usr/local/bin/agy');
  }

  for (const candidate of candidates) {
    if (isRegularFile(candidate)) {
      return candidate;
    }
  }

  // 3. Search PATH entries directly (prefer .exe on Windows to avoid .cmd shell invocation).
  const pathValue = env.PATH || env.Path || '';
  const pathDirs = pathValue.split(delimiter).filter(Boolean);
  const exeNames = isWin ? ['agy.exe'] : ['agy'];

  for (const dir of pathDirs) {
    for (const name of exeNames) {
      const fullPath = join(dir, name);
      if (isRegularFile(fullPath)) {
        return fullPath;
      }
    }
  }

  return null;
}

/**
 * Sanitizes CLI error text so it stays concise and safe to display.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeErrorDetail(text) {
  if (!text || typeof text !== 'string') return '';
  const collapsed = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' | ');
  if (collapsed.length <= MAX_ERROR_DETAIL_LEN) {
    return collapsed;
  }
  return `${collapsed.slice(0, MAX_ERROR_DETAIL_LEN - 3)}...`;
}

/**
 * Classifies an error string into a structured user-facing error object.
 * @param {string} rawText
 * @param {string} [fallbackCode]
 * @returns {{ code: string, message: string, detail: string }}
 */
export function classifyCliErrorText(rawText, fallbackCode = 'CLI_ERROR') {
  const detail = sanitizeErrorDetail(rawText);
  const lower = detail.toLowerCase();

  if (
    lower.includes('authentication required') ||
    lower.includes('not authenticated') ||
    lower.includes('unauthenticated') ||
    lower.includes('unauthorized') ||
    lower.includes('not signed in') ||
    lower.includes('please sign in') ||
    lower.includes('login required') ||
    lower.includes('logged out') ||
    lower.includes('credential') ||
    lower.includes('sign in to antigravity')
  ) {
    return {
      code: 'AUTH_REQUIRED',
      message: 'Antigravity CLI session is not signed in. Run "agy" in a terminal to authenticate.',
      detail,
    };
  }

  if (
    lower.includes('enotfound') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('enetunreach') ||
    lower.includes('ehostunreach') ||
    lower.includes('no such host') ||
    lower.includes('dial tcp') ||
    lower.includes('connectex') ||
    lower.includes('network is unreachable') ||
    lower.includes('offline') ||
    lower.includes('dns') ||
    lower.includes('context deadline exceeded') ||
    lower.includes('service unavailable') ||
    lower.includes('failed to connect')
  ) {
    return {
      code: 'NETWORK_ERROR',
      message: 'Unable to reach Antigravity quota service. Check your internet connection.',
      detail,
    };
  }

  return {
    code: fallbackCode,
    message: detail || 'Antigravity CLI returned an error while fetching quota.',
    detail,
  };
}

/**
 * Creates a CLI runner that executes `agy -p "/usage" --output-format json`
 * directly via `execFile` with `windowsHide: true` and tracks child processes
 * for clean shutdown.
 */
export function createAgyCliRunner(options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const activeChildren = new Set();

  /**
   * Executes the official zero-token quota command and returns raw stdout.
   * @returns {Promise<{ stdout: string, binaryPath: string }>}
   */
  async function fetchUsageJson() {
    const binaryPath = resolveAgyBinary(options);
    if (!binaryPath) {
      const error = new Error(
        'Antigravity CLI (agy) was not found. Install it from https://antigravity.google/docs/getting-started and sign in.'
      );
      error.code = 'CLI_NOT_FOUND';
      error.detail = 'Checked %LOCALAPPDATA%\\agy\\bin\\agy.exe and system PATH.';
      throw error;
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;

      const child = execFile(
        binaryPath,
        ['-p', '/usage', '--output-format', 'json'],
        {
          shell: false,
          windowsHide: true,
          timeout: timeoutMs,
          killSignal: 'SIGTERM',
          maxBuffer: MAX_BUFFER_BYTES,
          env: options.env ?? process.env,
        },
        (err, stdout, stderr) => {
          activeChildren.delete(child);
          if (settled) return;
          settled = true;

          const outText = typeof stdout === 'string' ? stdout.trim() : '';
          const errText = typeof stderr === 'string' ? stderr.trim() : '';

          // Even on non-zero exit, agy may write a JSON error envelope to stdout.
          if (err) {
            if (err.code === 'ENOENT') {
              const notFound = new Error(
                'Antigravity CLI (agy) executable could not be started.'
              );
              notFound.code = 'CLI_NOT_FOUND';
              notFound.detail = sanitizeErrorDetail(err.message);
              reject(notFound);
              return;
            }

            if (timedOut || err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') {
              const timeoutErr = new Error(
                `Quota query timed out after ${Math.round(timeoutMs / 1000)}s.`
              );
              timeoutErr.code = 'TIMEOUT';
              timeoutErr.detail = sanitizeErrorDetail(errText || err.message);
              reject(timeoutErr);
              return;
            }

            // Try extracting structured error field from JSON stdout if available.
            let combinedErrorText = errText;
            if (outText.startsWith('{')) {
              try {
                const envelope = JSON.parse(outText);
                if (typeof envelope?.error === 'string' && envelope.error.trim()) {
                  combinedErrorText = envelope.error;
                }
              } catch {
                // Ignore JSON parse errors here; fall back to stderr.
              }
            }

            const classified = classifyCliErrorText(
              combinedErrorText || outText || err.message,
              'CLI_ERROR'
            );
            const wrapped = new Error(classified.message);
            wrapped.code = classified.code;
            wrapped.detail = classified.detail;
            reject(wrapped);
            return;
          }

          if (!outText) {
            const emptyErr = new Error('Antigravity CLI returned an empty quota response.');
            emptyErr.code = 'PARSE_ERROR';
            emptyErr.detail = sanitizeErrorDetail(errText);
            reject(emptyErr);
            return;
          }

          resolve({ stdout: outText, binaryPath });
        }
      );

      activeChildren.add(child);

      // Guard against hung child process on Windows if SIGTERM does not exit immediately.
      const hardTimer = setTimeout(() => {
        if (!settled) {
          timedOut = true;
          try {
            child.kill('SIGKILL');
          } catch {
            // Process may already have exited.
          }
        }
      }, timeoutMs + 1500);
      hardTimer.unref?.();

      child.once('exit', () => clearTimeout(hardTimer));
      child.once('error', () => clearTimeout(hardTimer));
    });
  }

  /**
   * Terminates any in-flight CLI child processes during server shutdown.
   */
  function abortAll() {
    for (const child of activeChildren) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore already-exited process.
      }
    }
    activeChildren.clear();
  }

  return {
    fetchUsageJson,
    abortAll,
  };
}
