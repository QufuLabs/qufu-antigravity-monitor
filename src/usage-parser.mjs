import { classifyCliErrorText, sanitizeErrorDetail } from './cli-resolver.mjs';

/**
 * Returns the UI severity color band for a remaining percentage.
 * - 50..100 -> green
 * - 20..49  -> yellow
 * - 0..19   -> red
 * - null    -> unknown
 *
 * @param {number | null} remainingPercent
 * @returns {'green' | 'yellow' | 'red' | 'unknown'}
 */
export function getSeverityForPercent(remainingPercent) {
  if (typeof remainingPercent !== 'number' || !Number.isFinite(remainingPercent)) {
    return 'unknown';
  }
  if (remainingPercent >= 50) return 'green';
  if (remainingPercent >= 20) return 'yellow';
  return 'red';
}

/**
 * Normalizes a reset timestamp ISO string.
 * Note: Antigravity CLI emits "1970-01-01T00:00:00Z" for untouched 100% buckets.
 *
 * @param {unknown} rawResetTime
 * @returns {{ resetAt: string | null, isEpochZero: boolean }}
 */
function parseResetTime(rawResetTime) {
  if (typeof rawResetTime !== 'string' || !rawResetTime.trim()) {
    return { resetAt: null, isEpochZero: false };
  }
  const ms = Date.parse(rawResetTime.trim());
  if (!Number.isFinite(ms)) {
    return { resetAt: null, isEpochZero: false };
  }
  // Treat Unix epoch 0 (1970-01-01T00:00:00Z) as no active cooldown window.
  if (ms <= 0) {
    return { resetAt: null, isEpochZero: true };
  }
  return { resetAt: new Date(ms).toISOString(), isEpochZero: false };
}

/**
 * Normalizes a raw remaining fraction (0..1) into integer percent without fabricating missing data.
 *
 * @param {unknown} rawFraction
 * @returns {{ remainingFraction: number | null, remainingPercent: number | null }}
 */
function normalizeFraction(rawFraction) {
  if (typeof rawFraction !== 'number' || !Number.isFinite(rawFraction)) {
    return { remainingFraction: null, remainingPercent: null };
  }
  if (rawFraction < 0 || rawFraction > 1.0001) {
    return { remainingFraction: null, remainingPercent: null };
  }
  const clamped = Math.min(1, Math.max(0, rawFraction));
  return {
    remainingFraction: clamped,
    remainingPercent: Math.round(clamped * 100),
  };
}

/**
 * Builds a normalized bucket object.
 * @param {object} rawBucket
 * @param {'5h' | 'weekly'} expectedWindow
 */
function normalizeBucket(rawBucket, expectedWindow) {
  if (!rawBucket || typeof rawBucket !== 'object') {
    return createMissingBucket(expectedWindow);
  }

  let remainingFraction = null;
  let remainingPercent = null;

  if (typeof rawBucket.remaining_fraction === 'number') {
    const normalized = normalizeFraction(rawBucket.remaining_fraction);
    remainingFraction = normalized.remainingFraction;
    remainingPercent = normalized.remainingPercent;
  } else if (typeof rawBucket.remaining_percent === 'number' && Number.isFinite(rawBucket.remaining_percent)) {
    const pct = Math.min(100, Math.max(0, Math.round(rawBucket.remaining_percent)));
    remainingFraction = pct / 100;
    remainingPercent = pct;
  }

  const { resetAt, isEpochZero } = parseResetTime(rawBucket.reset_time);
  const isUnused = isEpochZero && remainingPercent === 100;

  return {
    id: typeof rawBucket.id === 'string' ? rawBucket.id : null,
    window: expectedWindow,
    label: expectedWindow === '5h' ? '5-Hour' : 'Weekly',
    remainingFraction,
    remainingPercent,
    resetAt,
    isUnused,
    severity: getSeverityForPercent(remainingPercent),
    description: typeof rawBucket.description === 'string' ? rawBucket.description : null,
  };
}

/**
 * Creates an explicitly empty/missing bucket (never fabricates fake percentages).
 * @param {'5h' | 'weekly'} window
 */
export function createMissingBucket(window) {
  return {
    id: null,
    window,
    label: window === '5h' ? '5-Hour' : 'Weekly',
    remainingFraction: null,
    remainingPercent: null,
    resetAt: null,
    isUnused: false,
    severity: 'unknown',
    description: null,
  };
}

/**
 * Identifies canonical group key (`gemini` or `claude_gpt`) from group name or bucket IDs.
 * @param {string} name
 * @param {Array<{ id?: string }>} buckets
 * @returns {'gemini' | 'claude_gpt' | null}
 */
function identifyGroupKey(name, buckets = []) {
  const lowerName = (name || '').toLowerCase();
  const bucketIds = buckets.map((b) => String(b?.id || '').toLowerCase());

  if (
    lowerName.includes('gemini') ||
    bucketIds.some((id) => id.startsWith('gemini-'))
  ) {
    return 'gemini';
  }

  if (
    lowerName.includes('claude') ||
    lowerName.includes('gpt') ||
    lowerName.includes('third') ||
    bucketIds.some((id) => id.startsWith('3p-'))
  ) {
    return 'claude_gpt';
  }

  return null;
}

/**
 * Identifies window type (`5h` or `weekly`) from raw bucket object.
 * @param {object} bucket
 * @returns {'5h' | 'weekly' | null}
 */
function identifyWindow(bucket) {
  const win = String(bucket?.window || '').toLowerCase().trim();
  const id = String(bucket?.id || '').toLowerCase().trim();
  const name = String(bucket?.name || '').toLowerCase().trim();

  if (win === '5h' || win === 'five_hour' || id.endsWith('-5h') || name.includes('five hour') || name.includes('5-hour') || name.includes('5 hour')) {
    return '5h';
  }
  if (win === 'weekly' || win === '7d' || id.endsWith('-weekly') || name.includes('weekly')) {
    return 'weekly';
  }
  return null;
}

/**
 * Parses TSV lines from `response` field as a secondary fallback if `command.data.groups` is absent.
 * Format observed from agy:
 * `Gemini Models\tWeekly Limit Remaining\t92%\t2026-12-02T21:21:58Z`
 *
 * @param {string} responseText
 */
function parseTsvFallback(responseText) {
  if (typeof responseText !== 'string' || !responseText.trim()) {
    return [];
  }

  const groupMap = new Map();
  const lines = responseText.replace(/\r\n/g, '\n').split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;

    const groupName = parts[0].trim();
    const bucketName = parts[1].trim();
    const pctMatch = parts[2].trim().match(/^(\d+(?:\.\d+)?)%$/);
    const resetTime = parts[3]?.trim() || '';

    if (!groupName || !bucketName || !pctMatch) continue;
    const pctValue = Number(pctMatch[1]);
    if (!Number.isFinite(pctValue) || pctValue < 0 || pctValue > 100) continue;

    if (!groupMap.has(groupName)) {
      groupMap.set(groupName, { name: groupName, description: null, buckets: [] });
    }

    groupMap.get(groupName).buckets.push({
      id: null,
      name: bucketName,
      window: null,
      remaining_fraction: pctValue / 100,
      reset_time: resetTime,
    });
  }

  return Array.from(groupMap.values());
}

/**
 * Extracts subscription plan name ONLY when explicitly present in CLI output.
 * Never invents or guesses a plan name.
 *
 * @param {object} envelope
 * @param {object | null} commandData
 * @returns {string | null}
 */
function extractPlanName(envelope, commandData) {
  const candidates = [
    commandData?.plan_tier,
    commandData?.plan_name,
    commandData?.subscription_plan,
    commandData?.plan,
    commandData?.tier,
    envelope?.plan_tier,
    envelope?.plan_name,
    envelope?.subscription_plan,
    envelope?.plan,
  ];

  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

/**
 * Parses the raw stdout JSON string returned by `agy -p "/usage" --output-format json`.
 *
 * @param {string} rawStdout
 * @returns {object}
 */
export function parseAgyUsageOutput(rawStdout) {
  if (typeof rawStdout !== 'string' || !rawStdout.trim()) {
    const err = new Error('Empty output from Antigravity CLI.');
    err.code = 'PARSE_ERROR';
    err.detail = 'stdout was empty';
    throw err;
  }

  let envelope;
  try {
    envelope = JSON.parse(rawStdout.trim());
  } catch (parseErr) {
    const err = new Error('Could not parse JSON output from Antigravity CLI.');
    err.code = 'PARSE_ERROR';
    err.detail = sanitizeErrorDetail(parseErr.message);
    throw err;
  }

  if (!envelope || typeof envelope !== 'object') {
    const err = new Error('Unexpected JSON structure from Antigravity CLI.');
    err.code = 'PARSE_ERROR';
    err.detail = 'Top-level value is not an object';
    throw err;
  }

  if (typeof envelope.status === 'string' && envelope.status !== 'SUCCESS') {
    const classified = classifyCliErrorText(
      envelope.error || `CLI returned status ${envelope.status}`,
      'CLI_ERROR'
    );
    const err = new Error(classified.message);
    err.code = classified.code;
    err.detail = classified.detail;
    throw err;
  }

  const commandData =
    envelope.command && typeof envelope.command === 'object'
      ? envelope.command.data ?? null
      : null;

  let rawGroups = [];
  if (Array.isArray(commandData?.groups) && commandData.groups.length > 0) {
    rawGroups = commandData.groups;
  } else if (Array.isArray(envelope.groups) && envelope.groups.length > 0) {
    rawGroups = envelope.groups;
  } else if (typeof envelope.response === 'string' && envelope.response.trim()) {
    rawGroups = parseTsvFallback(envelope.response);
  }

  if (rawGroups.length === 0) {
    const err = new Error('Antigravity CLI response did not contain any model quota groups.');
    err.code = 'PARSE_ERROR';
    err.detail = 'Missing command.data.groups and TSV response lines.';
    throw err;
  }

  const canonical = {
    gemini: {
      id: 'gemini',
      name: 'Gemini Models',
      modelsDescription: null,
      fiveHour: createMissingBucket('5h'),
      weekly: createMissingBucket('weekly'),
    },
    claude_gpt: {
      id: 'claude_gpt',
      name: 'Claude & GPT Models',
      modelsDescription: null,
      fiveHour: createMissingBucket('5h'),
      weekly: createMissingBucket('weekly'),
    },
  };

  const extraGroups = [];
  let matchedAnyBucket = false;

  for (const rawGroup of rawGroups) {
    if (!rawGroup || typeof rawGroup !== 'object') continue;
    const rawBuckets = Array.isArray(rawGroup.buckets) ? rawGroup.buckets : [];
    const groupKey = identifyGroupKey(rawGroup.name, rawBuckets);

    if (groupKey) {
      const target = canonical[groupKey];
      if (typeof rawGroup.description === 'string' && rawGroup.description.trim()) {
        target.modelsDescription = rawGroup.description.trim();
      }
      for (const rawBucket of rawBuckets) {
        const win = identifyWindow(rawBucket);
        if (win === '5h') {
          target.fiveHour = normalizeBucket(rawBucket, '5h');
          if (target.fiveHour.remainingPercent !== null) matchedAnyBucket = true;
        } else if (win === 'weekly') {
          target.weekly = normalizeBucket(rawBucket, 'weekly');
          if (target.weekly.remainingPercent !== null) matchedAnyBucket = true;
        }
      }
    } else {
      const extra = {
        id: String(rawGroup.name || 'other').toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        name: String(rawGroup.name || 'Other Models'),
        modelsDescription: typeof rawGroup.description === 'string' ? rawGroup.description.trim() : null,
        fiveHour: createMissingBucket('5h'),
        weekly: createMissingBucket('weekly'),
      };
      for (const rawBucket of rawBuckets) {
        const win = identifyWindow(rawBucket);
        if (win === '5h') {
          extra.fiveHour = normalizeBucket(rawBucket, '5h');
          if (extra.fiveHour.remainingPercent !== null) matchedAnyBucket = true;
        } else if (win === 'weekly') {
          extra.weekly = normalizeBucket(rawBucket, 'weekly');
          if (extra.weekly.remainingPercent !== null) matchedAnyBucket = true;
        }
      }
      extraGroups.push(extra);
    }
  }

  if (!matchedAnyBucket) {
    const err = new Error('No valid quota percentages were found in Antigravity CLI output.');
    err.code = 'PARSE_ERROR';
    err.detail = 'All parsed quota buckets had missing or invalid remaining_fraction values.';
    throw err;
  }

  const totalTokens =
    typeof envelope.usage?.total_tokens === 'number' ? envelope.usage.total_tokens : 0;

  return {
    source: 'agy-cli',
    plan: extractPlanName(envelope, commandData),
    tokensConsumed: totalTokens,
    groups: [canonical.gemini, canonical.claude_gpt, ...extraGroups],
  };
}

/**
 * Formats a human-readable countdown string for plain-text clients.
 * @param {string | null} resetAt
 * @param {boolean} isUnused
 * @param {number} [nowMs]
 * @returns {string}
 */
export function formatResetCountdown(resetAt, isUnused, nowMs = Date.now()) {
  if (isUnused) return 'Full';
  if (!resetAt) return '-';
  const targetMs = Date.parse(resetAt);
  if (!Number.isFinite(targetMs)) return '-';
  const diffSec = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  if (diffSec === 0) return 'Refreshing';

  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  const seconds = diffSec % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/**
 * Renders a concise plain-text summary for non-UI MCP clients (such as Antigravity CLI).
 * @param {object} snapshot
 * @param {number} [nowMs]
 * @returns {string}
 */
export function formatPlainTextSummary(snapshot, nowMs = Date.now()) {
  if (!snapshot) return 'Qufu Usage Monitor: No data available.';

  const lines = ['Qufu Usage Monitor'];
  if (snapshot.data?.plan) {
    lines.push(`Plan: ${snapshot.data.plan}`);
  }

  if (snapshot.data?.groups) {
    for (const group of snapshot.data.groups) {
      const fivePct =
        group.fiveHour?.remainingPercent !== null && group.fiveHour?.remainingPercent !== undefined
          ? `${group.fiveHour.remainingPercent}%`
          : 'N/A';
      const fiveReset = formatResetCountdown(
        group.fiveHour?.resetAt ?? null,
        Boolean(group.fiveHour?.isUnused),
        nowMs
      );
      const weekPct =
        group.weekly?.remainingPercent !== null && group.weekly?.remainingPercent !== undefined
          ? `${group.weekly.remainingPercent}%`
          : 'N/A';
      const weekReset = formatResetCountdown(
        group.weekly?.resetAt ?? null,
        Boolean(group.weekly?.isUnused),
        nowMs
      );
      lines.push(
        `${group.name}: 5h ${fivePct} (${fiveReset}) | Weekly ${weekPct} (${weekReset})`
      );
    }
  }

  if (snapshot.stale && snapshot.error) {
    lines.push(`Status: Stale (last updated ${snapshot.lastSuccessAt ?? 'unknown'}) - ${snapshot.error.message}`);
  } else if (snapshot.error && !snapshot.data) {
    lines.push(`Error (${snapshot.error.code}): ${snapshot.error.message}`);
  } else if (snapshot.lastSuccessAt) {
    lines.push(`Updated: ${snapshot.lastSuccessAt}`);
  }

  return lines.join('\n');
}
