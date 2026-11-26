import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_REFRESH_INTERVAL_SECONDS = 60;
export const MIN_REFRESH_INTERVAL_SECONDS = 15;
export const MAX_REFRESH_INTERVAL_SECONDS = 3600;
export const ALLOWED_REFRESH_PRESETS = [30, 60, 120, 300];

/**
 * Validates and clamps a refresh interval value in seconds.
 * @param {unknown} value
 * @returns {number}
 */
export function sanitizeRefreshInterval(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_REFRESH_INTERVAL_SECONDS;
  const rounded = Math.round(num);
  return Math.min(MAX_REFRESH_INTERVAL_SECONDS, Math.max(MIN_REFRESH_INTERVAL_SECONDS, rounded));
}

/**
 * Creates a lightweight settings store backed by `${PLUGIN_DATA}/settings.json`.
 * Falls back cleanly to in-memory storage if no data directory is configured.
 *
 * @param {object} [options]
 * @param {string | null} [options.dataDir]
 */
export function createSettingsStore(options = {}) {
  const dataDir = options.dataDir ?? process.env.PLUGIN_DATA ?? null;
  const settingsPath = dataDir ? join(dataDir, 'settings.json') : null;

  let current = {
    refreshIntervalSeconds: DEFAULT_REFRESH_INTERVAL_SECONDS,
  };

  if (settingsPath && existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        current = {
          refreshIntervalSeconds: sanitizeRefreshInterval(parsed.refreshIntervalSeconds),
        };
      }
    } catch {
      // Corrupt settings file: stay on safe defaults.
    }
  }

  function getSettings() {
    return { ...current };
  }

  function updateSettings(patch) {
    if (!patch || typeof patch !== 'object') {
      return getSettings();
    }

    const next = { ...current };
    if (patch.refreshIntervalSeconds !== undefined) {
      next.refreshIntervalSeconds = sanitizeRefreshInterval(patch.refreshIntervalSeconds);
    }

    current = next;

    if (settingsPath && dataDir) {
      try {
        mkdirSync(dataDir, { recursive: true });
        const tempPath = `${settingsPath}.tmp`;
        writeFileSync(tempPath, `${JSON.stringify(current, null, 2)}\n`, {
          encoding: 'utf-8',
          mode: 0o600,
        });
        renameSync(tempPath, settingsPath);
      } catch {
        // Keep updated value in memory if disk write fails.
      }
    }

    return getSettings();
  }

  return {
    getSettings,
    updateSettings,
  };
}
