import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createSettingsStore } from '../src/settings-store.mjs';
import { createUsageService } from '../src/usage-service.mjs';

function makePayload(gemini5h = 0.72, geminiWeekly = 0.91) {
  return JSON.stringify({
    status: 'SUCCESS',
    usage: { total_tokens: 0 },
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              { id: 'gemini-5h', window: '5h', remaining_fraction: gemini5h, reset_time: '2026-11-26T10:00:00Z' },
              { id: 'gemini-weekly', window: 'weekly', remaining_fraction: geminiWeekly, reset_time: '2026-12-02T10:00:00Z' },
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
}

test('shares cache across multiple panels and prevents concurrent duplicate queries', async () => {
  let currentNow = 1_700_000_000_000;
  let callCount = 0;

  const runner = {
    async fetchUsageJson() {
      callCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { stdout: makePayload(0.75, 0.9) };
    },
  };

  const settingsStore = createSettingsStore({ dataDir: null });
  const service = createUsageService({
    runner,
    settingsStore,
    now: () => currentNow,
  });

  // Single-flight: 5 simultaneous requests must trigger only 1 CLI invocation.
  const results = await Promise.all([
    service.getUsage({ force: true }),
    service.getUsage({ force: true }),
    service.getUsage({ force: false }),
    service.getUsage({ force: false }),
    service.getUsage({ force: true }),
  ]);

  assert.equal(callCount, 1);
  for (const res of results) {
    assert.equal(res.ok, true);
    assert.equal(res.data.groups[0].fiveHour.remainingPercent, 75);
  }

  // Second panel opening 10 seconds later must reuse shared cache.
  currentNow += 10_000;
  const cached = await service.getUsage({ force: false });
  assert.equal(callCount, 1);
  assert.equal(cached.fromCache, true);
  assert.equal(cached.stale, false);

  // After refresh interval (60s), non-forced call refreshes from CLI.
  currentNow += 55_000;
  const refreshed = await service.getUsage({ force: false });
  assert.equal(callCount, 2);
  assert.equal(refreshed.fromCache, false);
});

test('preserves last successful data marked stale during outage and applies exponential backoff', async () => {
  let currentNow = 1_700_000_000_000;
  let shouldFail = false;
  let callCount = 0;

  const runner = {
    async fetchUsageJson() {
      callCount += 1;
      if (shouldFail) {
        const err = new Error('Network unreachable');
        err.code = 'NETWORK_ERROR';
        err.detail = 'dial tcp failed';
        throw err;
      }
      return { stdout: makePayload(0.65, 0.88) };
    },
  };

  const settingsStore = createSettingsStore({ dataDir: null });
  const service = createUsageService({
    runner,
    settingsStore,
    now: () => currentNow,
    baseBackoffMs: 15_000,
    maxBackoffMs: 300_000,
  });

  // Initial successful load.
  const first = await service.getUsage({ force: false });
  assert.equal(first.ok, true);
  assert.equal(first.stale, false);
  assert.equal(callCount, 1);

  // Internet drops after 65s.
  shouldFail = true;
  currentNow += 65_000;
  const fail1 = await service.getUsage({ force: false });
  assert.equal(callCount, 2);
  assert.equal(fail1.ok, false);
  assert.equal(fail1.stale, true); // Must NOT present stale data as fresh.
  assert.equal(fail1.data.groups[0].fiveHour.remainingPercent, 65);
  assert.equal(fail1.error.code, 'NETWORK_ERROR');
  assert.equal(fail1.consecutiveFailures, 1);
  assert.equal(fail1.backoffRemainingMs, 15_000);

  // Auto-refresh within 15s backoff window must NOT hammer CLI.
  currentNow += 5_000;
  const blockedByBackoff = await service.getUsage({ force: false });
  assert.equal(callCount, 2);
  assert.equal(blockedByBackoff.stale, true);
  assert.equal(blockedByBackoff.backoffRemainingMs, 10_000);

  // Second failure doubles backoff to 30s.
  currentNow += 15_000;
  const fail2 = await service.getUsage({ force: false });
  assert.equal(callCount, 3);
  assert.equal(fail2.consecutiveFailures, 2);
  assert.equal(fail2.backoffRemainingMs, 30_000);

  // Manual force refresh bypasses backoff and resets failure counter on recovery.
  shouldFail = false;
  const recovered = await service.getUsage({ force: true });
  assert.equal(callCount, 4);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.stale, false);
  assert.equal(recovered.error, null);
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(recovered.backoffRemainingMs, 0);
});

test('persists refresh interval settings and clamps invalid values', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'qufu-settings-test-'));
  try {
    const store1 = createSettingsStore({ dataDir: tempDir });
    assert.equal(store1.getSettings().refreshIntervalSeconds, 60);

    const updated = store1.updateSettings({ refreshIntervalSeconds: 120 });
    assert.equal(updated.refreshIntervalSeconds, 120);

    // Reload from disk.
    const store2 = createSettingsStore({ dataDir: tempDir });
    assert.equal(store2.getSettings().refreshIntervalSeconds, 120);

    // Clamp out-of-range values safely.
    assert.equal(store2.updateSettings({ refreshIntervalSeconds: 1 }).refreshIntervalSeconds, 15);
    assert.equal(store2.updateSettings({ refreshIntervalSeconds: 99999 }).refreshIntervalSeconds, 3600);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
