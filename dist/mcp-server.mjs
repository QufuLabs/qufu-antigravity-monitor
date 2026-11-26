// src/mcp-server.mjs
import { readFileSync as readFileSync2 } from "node:fs";
import { dirname, join as join3 } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

// src/cli-resolver.mjs
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
var DEFAULT_TIMEOUT_MS = 15e3;
var MAX_BUFFER_BYTES = 2 * 1024 * 1024;
var MAX_ERROR_DETAIL_LEN = 240;
function isRegularFile(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}
function resolveAgyBinary(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? homedir();
  const isWin = platform === "win32";
  const override = env.QUFU_AGY_PATH?.trim();
  if (override && isRegularFile(override)) {
    return override;
  }
  const candidates = [];
  if (isWin) {
    const localAppData = env.LOCALAPPDATA || join(home, "AppData", "Local");
    candidates.push(join(localAppData, "agy", "bin", "agy.exe"));
    candidates.push(join(home, ".local", "bin", "agy.exe"));
  } else {
    candidates.push(join(home, ".local", "bin", "agy"));
    candidates.push("/usr/local/bin/agy");
  }
  for (const candidate of candidates) {
    if (isRegularFile(candidate)) {
      return candidate;
    }
  }
  const pathValue = env.PATH || env.Path || "";
  const pathDirs = pathValue.split(delimiter).filter(Boolean);
  const exeNames = isWin ? ["agy.exe"] : ["agy"];
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
function sanitizeErrorDetail(text) {
  if (!text || typeof text !== "string") return "";
  const collapsed = text.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean).join(" | ");
  if (collapsed.length <= MAX_ERROR_DETAIL_LEN) {
    return collapsed;
  }
  return `${collapsed.slice(0, MAX_ERROR_DETAIL_LEN - 3)}...`;
}
function classifyCliErrorText(rawText, fallbackCode = "CLI_ERROR") {
  const detail = sanitizeErrorDetail(rawText);
  const lower = detail.toLowerCase();
  if (lower.includes("authentication required") || lower.includes("not authenticated") || lower.includes("unauthenticated") || lower.includes("unauthorized") || lower.includes("not signed in") || lower.includes("please sign in") || lower.includes("login required") || lower.includes("logged out") || lower.includes("credential") || lower.includes("sign in to antigravity")) {
    return {
      code: "AUTH_REQUIRED",
      message: 'Antigravity CLI session is not signed in. Run "agy" in a terminal to authenticate.',
      detail
    };
  }
  if (lower.includes("enotfound") || lower.includes("econnrefused") || lower.includes("econnreset") || lower.includes("etimedout") || lower.includes("enetunreach") || lower.includes("ehostunreach") || lower.includes("no such host") || lower.includes("dial tcp") || lower.includes("connectex") || lower.includes("network is unreachable") || lower.includes("offline") || lower.includes("dns") || lower.includes("context deadline exceeded") || lower.includes("service unavailable") || lower.includes("failed to connect")) {
    return {
      code: "NETWORK_ERROR",
      message: "Unable to reach Antigravity quota service. Check your internet connection.",
      detail
    };
  }
  return {
    code: fallbackCode,
    message: detail || "Antigravity CLI returned an error while fetching quota.",
    detail
  };
}
function createAgyCliRunner(options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const activeChildren = /* @__PURE__ */ new Set();
  async function fetchUsageJson() {
    const binaryPath = resolveAgyBinary(options);
    if (!binaryPath) {
      const error = new Error(
        "Antigravity CLI (agy) was not found. Install it from https://antigravity.google/docs/getting-started and sign in."
      );
      error.code = "CLI_NOT_FOUND";
      error.detail = "Checked %LOCALAPPDATA%\\agy\\bin\\agy.exe and system PATH.";
      throw error;
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      const child = execFile(
        binaryPath,
        ["-p", "/usage", "--output-format", "json"],
        {
          shell: false,
          windowsHide: true,
          timeout: timeoutMs,
          killSignal: "SIGTERM",
          maxBuffer: MAX_BUFFER_BYTES,
          env: options.env ?? process.env
        },
        (err, stdout, stderr) => {
          activeChildren.delete(child);
          if (settled) return;
          settled = true;
          const outText = typeof stdout === "string" ? stdout.trim() : "";
          const errText = typeof stderr === "string" ? stderr.trim() : "";
          if (err) {
            if (err.code === "ENOENT") {
              const notFound = new Error(
                "Antigravity CLI (agy) executable could not be started."
              );
              notFound.code = "CLI_NOT_FOUND";
              notFound.detail = sanitizeErrorDetail(err.message);
              reject(notFound);
              return;
            }
            if (timedOut || err.killed || err.signal === "SIGTERM" || err.code === "ETIMEDOUT") {
              const timeoutErr = new Error(
                `Quota query timed out after ${Math.round(timeoutMs / 1e3)}s.`
              );
              timeoutErr.code = "TIMEOUT";
              timeoutErr.detail = sanitizeErrorDetail(errText || err.message);
              reject(timeoutErr);
              return;
            }
            let combinedErrorText = errText;
            if (outText.startsWith("{")) {
              try {
                const envelope = JSON.parse(outText);
                if (typeof envelope?.error === "string" && envelope.error.trim()) {
                  combinedErrorText = envelope.error;
                }
              } catch {
              }
            }
            const classified = classifyCliErrorText(
              combinedErrorText || outText || err.message,
              "CLI_ERROR"
            );
            const wrapped = new Error(classified.message);
            wrapped.code = classified.code;
            wrapped.detail = classified.detail;
            reject(wrapped);
            return;
          }
          if (!outText) {
            const emptyErr = new Error("Antigravity CLI returned an empty quota response.");
            emptyErr.code = "PARSE_ERROR";
            emptyErr.detail = sanitizeErrorDetail(errText);
            reject(emptyErr);
            return;
          }
          resolve({ stdout: outText, binaryPath });
        }
      );
      activeChildren.add(child);
      const hardTimer = setTimeout(() => {
        if (!settled) {
          timedOut = true;
          try {
            child.kill("SIGKILL");
          } catch {
          }
        }
      }, timeoutMs + 1500);
      hardTimer.unref?.();
      child.once("exit", () => clearTimeout(hardTimer));
      child.once("error", () => clearTimeout(hardTimer));
    });
  }
  function abortAll() {
    for (const child of activeChildren) {
      try {
        child.kill("SIGTERM");
      } catch {
      }
    }
    activeChildren.clear();
  }
  return {
    fetchUsageJson,
    abortAll
  };
}

// src/settings-store.mjs
import { existsSync as existsSync2, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join as join2 } from "node:path";
var DEFAULT_REFRESH_INTERVAL_SECONDS = 60;
var MIN_REFRESH_INTERVAL_SECONDS = 15;
var MAX_REFRESH_INTERVAL_SECONDS = 3600;
function sanitizeRefreshInterval(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_REFRESH_INTERVAL_SECONDS;
  const rounded = Math.round(num);
  return Math.min(MAX_REFRESH_INTERVAL_SECONDS, Math.max(MIN_REFRESH_INTERVAL_SECONDS, rounded));
}
function createSettingsStore(options = {}) {
  const dataDir = options.dataDir ?? process.env.PLUGIN_DATA ?? null;
  const settingsPath = dataDir ? join2(dataDir, "settings.json") : null;
  let current = {
    refreshIntervalSeconds: DEFAULT_REFRESH_INTERVAL_SECONDS
  };
  if (settingsPath && existsSync2(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        current = {
          refreshIntervalSeconds: sanitizeRefreshInterval(parsed.refreshIntervalSeconds)
        };
      }
    } catch {
    }
  }
  function getSettings() {
    return { ...current };
  }
  function updateSettings(patch) {
    if (!patch || typeof patch !== "object") {
      return getSettings();
    }
    const next = { ...current };
    if (patch.refreshIntervalSeconds !== void 0) {
      next.refreshIntervalSeconds = sanitizeRefreshInterval(patch.refreshIntervalSeconds);
    }
    current = next;
    if (settingsPath && dataDir) {
      try {
        mkdirSync(dataDir, { recursive: true });
        const tempPath = `${settingsPath}.tmp`;
        writeFileSync(tempPath, `${JSON.stringify(current, null, 2)}
`, {
          encoding: "utf-8",
          mode: 384
        });
        renameSync(tempPath, settingsPath);
      } catch {
      }
    }
    return getSettings();
  }
  return {
    getSettings,
    updateSettings
  };
}

// src/usage-parser.mjs
function getSeverityForPercent(remainingPercent) {
  if (typeof remainingPercent !== "number" || !Number.isFinite(remainingPercent)) {
    return "unknown";
  }
  if (remainingPercent >= 50) return "green";
  if (remainingPercent >= 20) return "yellow";
  return "red";
}
function parseResetTime(rawResetTime) {
  if (typeof rawResetTime !== "string" || !rawResetTime.trim()) {
    return { resetAt: null, isEpochZero: false };
  }
  const ms = Date.parse(rawResetTime.trim());
  if (!Number.isFinite(ms)) {
    return { resetAt: null, isEpochZero: false };
  }
  if (ms <= 0) {
    return { resetAt: null, isEpochZero: true };
  }
  return { resetAt: new Date(ms).toISOString(), isEpochZero: false };
}
function normalizeFraction(rawFraction) {
  if (typeof rawFraction !== "number" || !Number.isFinite(rawFraction)) {
    return { remainingFraction: null, remainingPercent: null };
  }
  if (rawFraction < 0 || rawFraction > 1.0001) {
    return { remainingFraction: null, remainingPercent: null };
  }
  const clamped = Math.min(1, Math.max(0, rawFraction));
  return {
    remainingFraction: clamped,
    remainingPercent: Math.round(clamped * 100)
  };
}
function normalizeBucket(rawBucket, expectedWindow) {
  if (!rawBucket || typeof rawBucket !== "object") {
    return createMissingBucket(expectedWindow);
  }
  let remainingFraction = null;
  let remainingPercent = null;
  if (typeof rawBucket.remaining_fraction === "number") {
    const normalized = normalizeFraction(rawBucket.remaining_fraction);
    remainingFraction = normalized.remainingFraction;
    remainingPercent = normalized.remainingPercent;
  } else if (typeof rawBucket.remaining_percent === "number" && Number.isFinite(rawBucket.remaining_percent)) {
    const pct = Math.min(100, Math.max(0, Math.round(rawBucket.remaining_percent)));
    remainingFraction = pct / 100;
    remainingPercent = pct;
  }
  const { resetAt, isEpochZero } = parseResetTime(rawBucket.reset_time);
  const isUnused = isEpochZero && remainingPercent === 100;
  return {
    id: typeof rawBucket.id === "string" ? rawBucket.id : null,
    window: expectedWindow,
    label: expectedWindow === "5h" ? "5-Hour" : "Weekly",
    remainingFraction,
    remainingPercent,
    resetAt,
    isUnused,
    severity: getSeverityForPercent(remainingPercent),
    description: typeof rawBucket.description === "string" ? rawBucket.description : null
  };
}
function createMissingBucket(window) {
  return {
    id: null,
    window,
    label: window === "5h" ? "5-Hour" : "Weekly",
    remainingFraction: null,
    remainingPercent: null,
    resetAt: null,
    isUnused: false,
    severity: "unknown",
    description: null
  };
}
function identifyGroupKey(name, buckets = []) {
  const lowerName = (name || "").toLowerCase();
  const bucketIds = buckets.map((b) => String(b?.id || "").toLowerCase());
  if (lowerName.includes("gemini") || bucketIds.some((id) => id.startsWith("gemini-"))) {
    return "gemini";
  }
  if (lowerName.includes("claude") || lowerName.includes("gpt") || lowerName.includes("third") || bucketIds.some((id) => id.startsWith("3p-"))) {
    return "claude_gpt";
  }
  return null;
}
function identifyWindow(bucket) {
  const win = String(bucket?.window || "").toLowerCase().trim();
  const id = String(bucket?.id || "").toLowerCase().trim();
  const name = String(bucket?.name || "").toLowerCase().trim();
  if (win === "5h" || win === "five_hour" || id.endsWith("-5h") || name.includes("five hour") || name.includes("5-hour") || name.includes("5 hour")) {
    return "5h";
  }
  if (win === "weekly" || win === "7d" || id.endsWith("-weekly") || name.includes("weekly")) {
    return "weekly";
  }
  return null;
}
function parseTsvFallback(responseText) {
  if (typeof responseText !== "string" || !responseText.trim()) {
    return [];
  }
  const groupMap = /* @__PURE__ */ new Map();
  const lines = responseText.replace(/\r\n/g, "\n").split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split("	");
    if (parts.length < 3) continue;
    const groupName = parts[0].trim();
    const bucketName = parts[1].trim();
    const pctMatch = parts[2].trim().match(/^(\d+(?:\.\d+)?)%$/);
    const resetTime = parts[3]?.trim() || "";
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
      reset_time: resetTime
    });
  }
  return Array.from(groupMap.values());
}
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
    envelope?.plan
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
function parseAgyUsageOutput(rawStdout) {
  if (typeof rawStdout !== "string" || !rawStdout.trim()) {
    const err = new Error("Empty output from Antigravity CLI.");
    err.code = "PARSE_ERROR";
    err.detail = "stdout was empty";
    throw err;
  }
  let envelope;
  try {
    envelope = JSON.parse(rawStdout.trim());
  } catch (parseErr) {
    const err = new Error("Could not parse JSON output from Antigravity CLI.");
    err.code = "PARSE_ERROR";
    err.detail = sanitizeErrorDetail(parseErr.message);
    throw err;
  }
  if (!envelope || typeof envelope !== "object") {
    const err = new Error("Unexpected JSON structure from Antigravity CLI.");
    err.code = "PARSE_ERROR";
    err.detail = "Top-level value is not an object";
    throw err;
  }
  if (typeof envelope.status === "string" && envelope.status !== "SUCCESS") {
    const classified = classifyCliErrorText(
      envelope.error || `CLI returned status ${envelope.status}`,
      "CLI_ERROR"
    );
    const err = new Error(classified.message);
    err.code = classified.code;
    err.detail = classified.detail;
    throw err;
  }
  const commandData = envelope.command && typeof envelope.command === "object" ? envelope.command.data ?? null : null;
  let rawGroups = [];
  if (Array.isArray(commandData?.groups) && commandData.groups.length > 0) {
    rawGroups = commandData.groups;
  } else if (Array.isArray(envelope.groups) && envelope.groups.length > 0) {
    rawGroups = envelope.groups;
  } else if (typeof envelope.response === "string" && envelope.response.trim()) {
    rawGroups = parseTsvFallback(envelope.response);
  }
  if (rawGroups.length === 0) {
    const err = new Error("Antigravity CLI response did not contain any model quota groups.");
    err.code = "PARSE_ERROR";
    err.detail = "Missing command.data.groups and TSV response lines.";
    throw err;
  }
  const canonical = {
    gemini: {
      id: "gemini",
      name: "Gemini Models",
      modelsDescription: null,
      fiveHour: createMissingBucket("5h"),
      weekly: createMissingBucket("weekly")
    },
    claude_gpt: {
      id: "claude_gpt",
      name: "Claude & GPT Models",
      modelsDescription: null,
      fiveHour: createMissingBucket("5h"),
      weekly: createMissingBucket("weekly")
    }
  };
  const extraGroups = [];
  let matchedAnyBucket = false;
  for (const rawGroup of rawGroups) {
    if (!rawGroup || typeof rawGroup !== "object") continue;
    const rawBuckets = Array.isArray(rawGroup.buckets) ? rawGroup.buckets : [];
    const groupKey = identifyGroupKey(rawGroup.name, rawBuckets);
    if (groupKey) {
      const target = canonical[groupKey];
      if (typeof rawGroup.description === "string" && rawGroup.description.trim()) {
        target.modelsDescription = rawGroup.description.trim();
      }
      for (const rawBucket of rawBuckets) {
        const win = identifyWindow(rawBucket);
        if (win === "5h") {
          target.fiveHour = normalizeBucket(rawBucket, "5h");
          if (target.fiveHour.remainingPercent !== null) matchedAnyBucket = true;
        } else if (win === "weekly") {
          target.weekly = normalizeBucket(rawBucket, "weekly");
          if (target.weekly.remainingPercent !== null) matchedAnyBucket = true;
        }
      }
    } else {
      const extra = {
        id: String(rawGroup.name || "other").toLowerCase().replace(/[^a-z0-9]+/g, "_"),
        name: String(rawGroup.name || "Other Models"),
        modelsDescription: typeof rawGroup.description === "string" ? rawGroup.description.trim() : null,
        fiveHour: createMissingBucket("5h"),
        weekly: createMissingBucket("weekly")
      };
      for (const rawBucket of rawBuckets) {
        const win = identifyWindow(rawBucket);
        if (win === "5h") {
          extra.fiveHour = normalizeBucket(rawBucket, "5h");
          if (extra.fiveHour.remainingPercent !== null) matchedAnyBucket = true;
        } else if (win === "weekly") {
          extra.weekly = normalizeBucket(rawBucket, "weekly");
          if (extra.weekly.remainingPercent !== null) matchedAnyBucket = true;
        }
      }
      extraGroups.push(extra);
    }
  }
  if (!matchedAnyBucket) {
    const err = new Error("No valid quota percentages were found in Antigravity CLI output.");
    err.code = "PARSE_ERROR";
    err.detail = "All parsed quota buckets had missing or invalid remaining_fraction values.";
    throw err;
  }
  const totalTokens = typeof envelope.usage?.total_tokens === "number" ? envelope.usage.total_tokens : 0;
  return {
    source: "agy-cli",
    plan: extractPlanName(envelope, commandData),
    tokensConsumed: totalTokens,
    groups: [canonical.gemini, canonical.claude_gpt, ...extraGroups]
  };
}
function formatResetCountdown(resetAt, isUnused, nowMs = Date.now()) {
  if (isUnused) return "Full";
  if (!resetAt) return "-";
  const targetMs = Date.parse(resetAt);
  if (!Number.isFinite(targetMs)) return "-";
  const diffSec = Math.max(0, Math.floor((targetMs - nowMs) / 1e3));
  if (diffSec === 0) return "Refreshing";
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor(diffSec % 86400 / 3600);
  const minutes = Math.floor(diffSec % 3600 / 60);
  const seconds = diffSec % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}
function formatPlainTextSummary(snapshot, nowMs = Date.now()) {
  if (!snapshot) return "Qufu Antigravity Monitor: No data available.";
  const lines = ["Qufu Antigravity Monitor"];
  if (snapshot.data?.plan) {
    lines.push(`Plan: ${snapshot.data.plan}`);
  }
  if (snapshot.data?.groups) {
    for (const group of snapshot.data.groups) {
      const fivePct = group.fiveHour?.remainingPercent !== null && group.fiveHour?.remainingPercent !== void 0 ? `${group.fiveHour.remainingPercent}%` : "N/A";
      const fiveReset = formatResetCountdown(
        group.fiveHour?.resetAt ?? null,
        Boolean(group.fiveHour?.isUnused),
        nowMs
      );
      const weekPct = group.weekly?.remainingPercent !== null && group.weekly?.remainingPercent !== void 0 ? `${group.weekly.remainingPercent}%` : "N/A";
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
    lines.push(`Status: Stale (last updated ${snapshot.lastSuccessAt ?? "unknown"}) - ${snapshot.error.message}`);
  } else if (snapshot.error && !snapshot.data) {
    lines.push(`Error (${snapshot.error.code}): ${snapshot.error.message}`);
  } else if (snapshot.lastSuccessAt) {
    lines.push(`Updated: ${snapshot.lastSuccessAt}`);
  }
  return lines.join("\n");
}

// src/usage-service.mjs
var DEFAULT_BASE_BACKOFF_MS = 15e3;
var DEFAULT_MAX_BACKOFF_MS = 3e5;
var MIN_CACHE_TTL_MS = 1e4;
function createUsageService(options) {
  const {
    runner,
    settingsStore,
    now = () => Date.now(),
    baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS
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
    return refreshIntervalSeconds * 1e3;
  }
  function getCacheTtlMs() {
    return Math.max(MIN_CACHE_TTL_MS, getRefreshIntervalMs() - 5e3);
  }
  function buildResponse(fromCache) {
    const currentMs = now();
    const refreshIntervalMs = getRefreshIntervalMs();
    const ageMs = lastSuccessMs !== null ? Math.max(0, currentMs - lastSuccessMs) : null;
    const isStaleByError = cachedData !== null && lastError !== null;
    const isStaleByAge = cachedData !== null && ageMs !== null && ageMs > Math.max(refreshIntervalMs * 2, 12e4);
    const backoffRemainingMs = nextRetryMs !== null && nextRetryMs > currentMs ? nextRetryMs - currentMs : 0;
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
      error: lastError
    };
  }
  async function getUsage(params = {}) {
    const force = Boolean(params?.force);
    const currentMs = now();
    if (inFlightPromise) {
      return inFlightPromise;
    }
    if (!force && cachedData !== null && lastSuccessMs !== null && lastError === null) {
      const ageMs = currentMs - lastSuccessMs;
      if (ageMs < getCacheTtlMs()) {
        return buildResponse(true);
      }
    }
    if (!force && nextRetryMs !== null && currentMs < nextRetryMs) {
      return buildResponse(true);
    }
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
          code: typeof err?.code === "string" ? err.code : "CLI_ERROR",
          message: typeof err?.message === "string" && err.message.trim() ? err.message.trim() : "Failed to retrieve model usage quota.",
          detail: typeof err?.detail === "string" ? err.detail : ""
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
      snapshot: buildResponse(true)
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
    shutdown
  };
}

// src/mcp-server.mjs
var SERVER_NAME = "qufu-usage-monitor";
var SERVER_VERSION = "1.0.0";
var UI_RESOURCE_URI = "ui://qufu-usage-monitor/index.html";
var UI_MIME_TYPE = "text/html;profile=mcp-app";
var DEFAULT_PROTOCOL_VERSION = "2025-06-18";
function getToolDefinitions() {
  return [
    {
      name: "usage_monitor",
      title: "Usage Monitor",
      description: "Open Qufu Antigravity Monitor to display real-time Gemini, Claude, and GPT 5-hour and weekly quota limits.",
      inputSchema: {
        type: "object",
        properties: {
          force: {
            type: "boolean",
            description: "Bypass cache and run a fresh quota check immediately."
          }
        },
        additionalProperties: false
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: {
        ui: {
          resourceUri: UI_RESOURCE_URI,
          visibility: ["model", "app"]
        },
        "com.google.antigravity/ui": {
          entrypoints: [
            { type: "aux_pane", title: "Usage Monitor" },
            { type: "global", title: "Usage Monitor" }
          ]
        }
      }
    },
    {
      name: "get_usage",
      title: "Get Usage Quota",
      description: "Read cached or refreshed quota data for the Usage Monitor view.",
      inputSchema: {
        type: "object",
        properties: {
          force: {
            type: "boolean",
            description: "When true, bypass cache TTL and backoff to refresh immediately."
          }
        },
        additionalProperties: false
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    {
      name: "set_config",
      title: "Set Monitor Configuration",
      description: "Persist auto-refresh interval settings for Qufu Antigravity Monitor.",
      inputSchema: {
        type: "object",
        properties: {
          refreshIntervalSeconds: {
            type: "integer",
            minimum: 15,
            maximum: 3600,
            description: "Auto-refresh interval in seconds (default 60)."
          }
        },
        required: ["refreshIntervalSeconds"],
        additionalProperties: false
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    }
  ];
}
function createMcpHandler({ usageService, loadUiHtml }) {
  async function handleMessage(msg) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
      return {
        jsonrpc: "2.0",
        id: msg?.id ?? null,
        error: { code: -32600, message: "Invalid JSON-RPC 2.0 request." }
      };
    }
    const { id, method, params } = msg;
    const isNotification = id === void 0;
    if (typeof method !== "string") {
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Missing method name." }
      };
    }
    if (isNotification) {
      return null;
    }
    try {
      switch (method) {
        case "initialize": {
          const requestedVersion = typeof params?.protocolVersion === "string" && params.protocolVersion.trim() ? params.protocolVersion.trim() : DEFAULT_PROTOCOL_VERSION;
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: requestedVersion,
              capabilities: {
                tools: { listChanged: false },
                resources: { listChanged: false },
                extensions: {
                  "io.modelcontextprotocol/ui": {
                    mimeTypes: [UI_MIME_TYPE]
                  }
                }
              },
              serverInfo: {
                name: SERVER_NAME,
                version: SERVER_VERSION
              }
            }
          };
        }
        case "ping": {
          return { jsonrpc: "2.0", id, result: {} };
        }
        case "tools/list": {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              tools: getToolDefinitions()
            }
          };
        }
        case "tools/call": {
          const toolName = params?.name;
          const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
          if (toolName === "usage_monitor" || toolName === "get_usage") {
            const snapshot = await usageService.getUsage({ force: Boolean(args.force) });
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: formatPlainTextSummary(snapshot)
                  }
                ],
                structuredContent: snapshot,
                isError: false
              }
            };
          }
          if (toolName === "set_config") {
            const updated = usageService.updateConfig({
              refreshIntervalSeconds: args.refreshIntervalSeconds
            });
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: `Auto-refresh interval set to ${updated.settings.refreshIntervalSeconds}s.`
                  }
                ],
                structuredContent: updated,
                isError: false
              }
            };
          }
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: `Unknown tool: ${String(toolName)}`
            }
          };
        }
        case "resources/list": {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              resources: [
                {
                  uri: UI_RESOURCE_URI,
                  name: "Qufu Antigravity Monitor",
                  description: "Compact local model quota monitor interface.",
                  mimeType: UI_MIME_TYPE,
                  _meta: {
                    ui: {
                      prefersBorder: false
                    }
                  }
                }
              ]
            }
          };
        }
        case "resources/templates/list": {
          return {
            jsonrpc: "2.0",
            id,
            result: { resourceTemplates: [] }
          };
        }
        case "resources/read": {
          const uri = params?.uri;
          if (uri !== UI_RESOURCE_URI) {
            return {
              jsonrpc: "2.0",
              id,
              error: {
                code: -32002,
                message: `Resource not found: ${String(uri)}`
              }
            };
          }
          const html = loadUiHtml();
          return {
            jsonrpc: "2.0",
            id,
            result: {
              contents: [
                {
                  uri: UI_RESOURCE_URI,
                  mimeType: UI_MIME_TYPE,
                  text: html,
                  _meta: {
                    ui: {
                      prefersBorder: false
                    }
                  }
                }
              ]
            }
          };
        }
        case "prompts/list": {
          return {
            jsonrpc: "2.0",
            id,
            result: { prompts: [] }
          };
        }
        default: {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`
            }
          };
        }
      }
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : "Internal server error."
        }
      };
    }
  }
  return { handleMessage };
}
function startStdioServer(options = {}) {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const uiHtmlPath = options.uiHtmlPath ?? process.env.QUFU_UI_HTML ?? join3(currentDir, "ui.html");
  const settingsStore = createSettingsStore({ dataDir: options.dataDir });
  const runner = createAgyCliRunner({ timeoutMs: options.timeoutMs });
  const usageService = createUsageService({ runner, settingsStore });
  const loadUiHtml = () => {
    return readFileSync2(uiHtmlPath, "utf-8");
  };
  const handler = createMcpHandler({ usageService, loadUiHtml });
  function writeMessage(payload) {
    process.stdout.write(`${JSON.stringify(payload)}
`);
  }
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      writeMessage({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: invalid JSON." }
      });
      return;
    }
    handler.handleMessage(parsed).then((response) => {
      if (response !== null) {
        writeMessage(response);
      }
    }).catch((err) => {
      if (parsed?.id !== void 0) {
        writeMessage({
          jsonrpc: "2.0",
          id: parsed.id,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : "Unhandled server error."
          }
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
    }
    usageService.shutdown();
    process.exit(0);
  }
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
var isDirectRun = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase();
if (isDirectRun) {
  startStdioServer();
}
export {
  SERVER_NAME,
  SERVER_VERSION,
  UI_MIME_TYPE,
  UI_RESOURCE_URI,
  createMcpHandler,
  getToolDefinitions,
  startStdioServer
};
