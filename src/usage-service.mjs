import { parseAgyUsageOutput } from './usage-parser.mjs';

const DEFAULT_BASE_BACKOFF_MS = 15_000;
const DEFAULT_MAX_BACKOFF_MS = 300_000;
const MIN_CACHE_TTL_MS = 10_000;

/**
 * Shared usage quota service providing:
 * - Single-flight concurrency lock (at most 1 CLI invocation in flight)
 * - Shared cache across multiple open views (aux_pane + global)
 * - Exponential backoff on consecutive errors
 * - Honest stale-data reporting during outages
 *
 * @param {object} options
 * @param {{ fetchUsageJson: () => Promise<{ stdout: string }>, abortAll?: () => void }} options.runner
 * @param {{ getSettings: () => { refreshIntervalSeconds: number }, updateSettings: (patch: object) => { refreshIntervalSeconds: number } }} options.settingsStore
 * @param {() => number} [options.now]
 * @param {number} [options.baseBackoffMs]
 * @param {number} [options.maxBackoffMs]
 */
export function createUsageService(options) {
  const {
    runner,
    settingsStore,
    now = () => Date.now(),
    baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  } = options;

  let cachedData = null;
  let lastSuccessMs = null;
  let lastAttemptMs = null;
  let lastError = null;
  let consecutiveFailures = 0;
  let nextRetryMs = null;
  let inFlightPromise = null;

  function getRefreshIntervalMs() {
    const { refreshIntervalSeconds } = settingsStore.getSettings();
    return refreshIntervalSeconds * 1000;
  }

  function getCacheTtlMs() {
    // Allow slight jitter so a 60s client timer triggers a fresh read on tick,
    // while multiple panels opening within seconds share the cached result.
    return Math.max(MIN_CACHE_TTL_MS, getRefreshIntervalMs() - 5_000);
  }

  function buildResponse(fromCache) {
    const currentMs = now();
    const refreshIntervalMs = getRefreshIntervalMs();
    const ageMs = lastSuccessMs !== null ? Math.max(0, currentMs - lastSuccessMs) : null;
    const isStaleByError = cachedData !== null && lastError !== null;
    const isStaleByAge =
      cachedData !== null &&
      ageMs !== null &&
      ageMs > Math.max(refreshIntervalMs * 2, 120_000);

    const backoffRemainingMs =
      nextRetryMs !== null && nextRetryMs > currentMs ? nextRetryMs - currentMs : 0;

    return {
      ok: cachedData !== null && lastError === null,
      stale: isStaleByError || isStaleByAge,
      fromCache,
      serverNow: new Date(currentMs).toISOString(),
      lastSuccessAt: lastSuccessMs !== null ? new Date(lastSuccessMs).toISOString() : null,
      lastAttemptAt: lastAttemptMs !== null ? new Date(lastAttemptMs).toISOString() : null,
      consecutiveFailures,
      backoffUntil: backoffRemainingMs > 0 ? new Date(nextRetryMs).toISOString() : null,
      backoffRemainingMs,
      settings: settingsStore.getSettings(),
      data: cachedData,
      error: lastError,
    };
  }

  /**
   * Fetches quota data, deduplicating concurrent requests and honoring cache/backoff.
   * @param {{ force?: boolean }} [params]
   */
  async function getUsage(params = {}) {
    const force = Boolean(params?.force);
    const currentMs = now();

    // 1. Deduplicate concurrent calls (single-flight).
    if (inFlightPromise) {
      return inFlightPromise;
    }

    // 2. Serve shared cache when fresh and not forced.
    if (!force && cachedData !== null && lastSuccessMs !== null && lastError === null) {
      const ageMs = currentMs - lastSuccessMs;
      if (ageMs < getCacheTtlMs()) {
        return buildResponse(true);
      }
    }

    // 3. Respect exponential backoff for background/auto refreshes.
    if (!force && nextRetryMs !== null && currentMs < nextRetryMs) {
      return buildResponse(true);
    }

    // 4. Execute CLI fetch under single-flight lock.
    inFlightPromise = (async () => {
      lastAttemptMs = now();
      try {
        const { stdout } = await runner.fetchUsageJson();
        const parsed = parseAgyUsageOutput(stdout);

        cachedData = parsed;
        lastSuccessMs = now();
        lastError = null;
        consecutiveFailures = 0;
        nextRetryMs = null;

        return buildResponse(false);
      } catch (err) {
        consecutiveFailures += 1;
        const backoffDelay = Math.min(
          baseBackoffMs * Math.pow(2, consecutiveFailures - 1),
          maxBackoffMs
        );
        nextRetryMs = now() + backoffDelay;
        lastError = {
          code: typeof err?.code === 'string' ? err.code : 'CLI_ERROR',
          message:
            typeof err?.message === 'string' && err.message.trim()
              ? err.message.trim()
              : 'Failed to retrieve model usage quota.',
          detail: typeof err?.detail === 'string' ? err.detail : '',
        };

        return buildResponse(false);
      } finally {
        inFlightPromise = null;
      }
    })();

    return inFlightPromise;
  }

  function updateConfig(patch) {
    const settings = settingsStore.updateSettings(patch);
    return {
      settings,
      snapshot: buildResponse(true),
    };
  }

  function getCachedSnapshot() {
    return buildResponse(true);
  }

  function shutdown() {
    runner.abortAll?.();
  }

  return {
    getUsage,
    updateConfig,
    getCachedSnapshot,
    shutdown,
  };
}
