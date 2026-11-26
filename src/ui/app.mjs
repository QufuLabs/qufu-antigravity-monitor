import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps/app-with-deps';

const DEFAULT_INTERVAL_SECONDS = 60;
const PRESET_INTERVALS = [30, 60, 120, 300];

const elements = {
  planTag: document.getElementById('plan-tag'),
  titleLabel: document.getElementById('title-label'),
  intervalSelect: document.getElementById('interval-select'),
  refreshBtn: document.getElementById('refresh-btn'),
  noticeBox: document.getElementById('notice-box'),
  loadingView: document.getElementById('loading-view'),
  groupsContainer: document.getElementById('groups-container'),
  statusDot: document.getElementById('status-dot'),
  updatedText: document.getElementById('updated-text'),
  nextSyncText: document.getElementById('next-sync-text'),
};

const state = {
  snapshot: null,
  loading: false,
  intervalSeconds: DEFAULT_INTERVAL_SECONDS,
  nextRefreshAtMs: null,
  clockOffsetMs: 0,
  renderedResets: [],
  triggeredResetKeys: new Set(),
  autoRefreshTimer: null,
  initialFetchTimer: null,
  resetRefreshTimer: null,
};

function applyHostContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
    document.documentElement.setAttribute('data-theme', ctx.theme);
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  if (ctx.styles?.css?.fonts) {
    applyHostFonts(ctx.styles.css.fonts);
  }
}

function getSyncedNowMs() {
  return Date.now() + state.clockOffsetMs;
}

function formatCountdown(resetAt, isUnused, nowMs) {
  if (isUnused) return 'Full';
  if (!resetAt) return '--';
  const targetMs = Date.parse(resetAt);
  if (!Number.isFinite(targetMs)) return '--';

  const diffSec = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  if (diffSec === 0) return 'Refreshing';

  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  const seconds = diffSec % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

function formatTimeShort(isoString) {
  if (!isoString) return '--';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatRelativeAge(isoString, nowMs) {
  if (!isoString) return '';
  const ts = Date.parse(isoString);
  if (!Number.isFinite(ts)) return '';
  const ageSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (ageSec < 5) return 'just now';
  if (ageSec < 60) return `${ageSec}s ago`;
  const mins = Math.floor(ageSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

function setLoading(isLoading) {
  state.loading = isLoading;
  elements.refreshBtn.disabled = isLoading;
  elements.refreshBtn.classList.toggle('loading', isLoading);
}

function syncIntervalSelect(seconds) {
  const value = String(seconds);
  if (!PRESET_INTERVALS.includes(seconds)) {
    const existing = Array.from(elements.intervalSelect.options).find((o) => o.value === value);
    if (!existing) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = `${seconds}s`;
      elements.intervalSelect.appendChild(opt);
    }
  }
  elements.intervalSelect.value = value;
}

function renderNotice(snapshot) {
  const box = elements.noticeBox;
  box.textContent = '';

  if (!snapshot?.error) {
    box.className = 'notice hidden';
    return;
  }

  const hasData = Boolean(snapshot.data);
  box.className = hasData ? 'notice stale' : 'notice error';

  const header = document.createElement('div');
  header.className = 'notice-header';

  const title = document.createElement('span');
  if (hasData) {
    const lastTime = formatTimeShort(snapshot.lastSuccessAt);
    title.textContent = `Stale data (last updated ${lastTime})`;
  } else {
    title.textContent = getErrorHeading(snapshot.error.code);
  }

  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'retry-link';
  retryBtn.textContent = 'Retry';
  retryBtn.addEventListener('click', () => {
    void fetchUsage(true);
  });

  header.appendChild(title);
  header.appendChild(retryBtn);

  const detail = document.createElement('div');
  detail.className = 'notice-detail';
  detail.textContent = snapshot.error.message || 'Unable to refresh quota.';

  box.appendChild(header);
  box.appendChild(detail);
}

function getErrorHeading(code) {
  switch (code) {
    case 'CLI_NOT_FOUND':
      return 'Antigravity CLI not found';
    case 'AUTH_REQUIRED':
      return 'Sign-in required';
    case 'NETWORK_ERROR':
      return 'Connection unavailable';
    case 'TIMEOUT':
      return 'Request timed out';
    case 'PARSE_ERROR':
      return 'Unexpected CLI output';
    default:
      return 'Quota check failed';
  }
}

function createBucketRow(bucket, nowMs) {
  const wrapper = document.createElement('div');
  wrapper.className = 'bucket';

  const row = document.createElement('div');
  row.className = 'bucket-row';

  const label = document.createElement('span');
  label.className = 'bucket-label';
  label.textContent = bucket.window === '5h' ? '5-Hour' : 'Weekly';

  const meta = document.createElement('div');
  meta.className = 'bucket-meta';

  const resetEl = document.createElement('span');
  resetEl.className = 'bucket-reset';
  resetEl.textContent = formatCountdown(bucket.resetAt, Boolean(bucket.isUnused), nowMs);
  if (bucket.resetAt) {
    resetEl.title = `Resets at ${new Date(bucket.resetAt).toLocaleString()}`;
  }

  const pctEl = document.createElement('span');
  const severity = bucket.severity || 'unknown';
  pctEl.className = `bucket-pct ${severity}`;
  const hasPct = typeof bucket.remainingPercent === 'number' && Number.isFinite(bucket.remainingPercent);
  pctEl.textContent = hasPct ? `${bucket.remainingPercent}%` : '--';

  meta.appendChild(resetEl);
  meta.appendChild(pctEl);
  row.appendChild(label);
  row.appendChild(meta);

  const track = document.createElement('div');
  track.className = 'bar-track';
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  if (hasPct) {
    track.setAttribute('aria-valuenow', String(bucket.remainingPercent));
  }

  const fill = document.createElement('div');
  fill.className = `bar-fill ${severity}`;
  fill.style.width = hasPct ? `${Math.min(100, Math.max(0, bucket.remainingPercent))}%` : '0%';
  track.appendChild(fill);

  wrapper.appendChild(row);
  wrapper.appendChild(track);

  state.renderedResets.push({
    el: resetEl,
    resetAt: bucket.resetAt,
    isUnused: Boolean(bucket.isUnused),
  });

  return wrapper;
}

function renderGroups(snapshot) {
  const container = elements.groupsContainer;
  container.textContent = '';
  state.renderedResets = [];

  const groups = snapshot?.data?.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    container.classList.add('hidden');
    return;
  }

  const nowMs = getSyncedNowMs();
  for (const group of groups) {
    const section = document.createElement('div');
    section.className = 'group';

    const title = document.createElement('div');
    title.className = 'group-name';
    title.textContent = group.name;
    if (group.modelsDescription) {
      title.title = group.modelsDescription;
    }

    section.appendChild(title);
    if (group.fiveHour) {
      section.appendChild(createBucketRow(group.fiveHour, nowMs));
    }
    if (group.weekly) {
      section.appendChild(createBucketRow(group.weekly, nowMs));
    }

    container.appendChild(section);
  }

  container.classList.remove('hidden');
}

function updateFooterAndCountdowns() {
  const nowMs = getSyncedNowMs();
  let resetJustReached = false;

  for (const item of state.renderedResets) {
    item.el.textContent = formatCountdown(item.resetAt, item.isUnused, nowMs);
    if (item.resetAt && !item.isUnused) {
      const targetMs = Date.parse(item.resetAt);
      if (Number.isFinite(targetMs) && targetMs <= nowMs && !state.triggeredResetKeys.has(item.resetAt)) {
        state.triggeredResetKeys.add(item.resetAt);
        resetJustReached = true;
      }
    }
  }

  if (resetJustReached && !document.hidden && !state.resetRefreshTimer) {
    state.resetRefreshTimer = setTimeout(() => {
      state.resetRefreshTimer = null;
      void fetchUsage(false);
    }, 3000);
  }

  const snap = state.snapshot;
  if (!snap) {
    elements.statusDot.className = 'status-dot loading';
    elements.updatedText.textContent = state.loading ? 'Refreshing...' : 'Waiting for data...';
    elements.nextSyncText.textContent = '';
    return;
  }

  if (snap.error && !snap.data) {
    elements.statusDot.className = 'status-dot error';
    elements.updatedText.textContent = 'Unavailable';
  } else if (snap.stale) {
    elements.statusDot.className = 'status-dot stale';
    const timeStr = formatTimeShort(snap.lastSuccessAt);
    const ageStr = formatRelativeAge(snap.lastSuccessAt, nowMs);
    elements.updatedText.textContent = ageStr ? `Stale · ${timeStr} (${ageStr})` : `Stale · ${timeStr}`;
  } else {
    elements.statusDot.className = 'status-dot';
    const timeStr = formatTimeShort(snap.lastSuccessAt);
    const ageStr = formatRelativeAge(snap.lastSuccessAt, nowMs);
    elements.updatedText.textContent = ageStr ? `Updated ${timeStr} (${ageStr})` : `Updated ${timeStr}`;
  }

  if (state.loading) {
    elements.nextSyncText.textContent = 'Syncing...';
  } else if (snap.backoffUntil) {
    const retryMs = Date.parse(snap.backoffUntil);
    const leftSec = Math.max(0, Math.ceil((retryMs - nowMs) / 1000));
    elements.nextSyncText.textContent = leftSec > 0 ? `Retry in ${leftSec}s` : '';
  } else if (state.nextRefreshAtMs) {
    const leftSec = Math.max(0, Math.ceil((state.nextRefreshAtMs - Date.now()) / 1000));
    elements.nextSyncText.textContent = `${leftSec}s`;
  } else {
    elements.nextSyncText.textContent = '';
  }
}

function scheduleNextAutoRefresh(snapshot) {
  if (state.autoRefreshTimer) {
    clearTimeout(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }

  const baseDelayMs = state.intervalSeconds * 1000;
  let delayMs = baseDelayMs;

  if (snapshot?.backoffRemainingMs && snapshot.backoffRemainingMs > 0) {
    delayMs = Math.max(snapshot.backoffRemainingMs + 500, 5000);
  }

  state.nextRefreshAtMs = Date.now() + delayMs;
  state.autoRefreshTimer = setTimeout(() => {
    state.autoRefreshTimer = null;
    if (document.hidden) {
      state.nextRefreshAtMs = null;
      return;
    }
    void fetchUsage(false);
  }, delayMs);
}

function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;

  if (state.initialFetchTimer) {
    clearTimeout(state.initialFetchTimer);
    state.initialFetchTimer = null;
  }

  if (snapshot.serverNow) {
    const srvMs = Date.parse(snapshot.serverNow);
    if (Number.isFinite(srvMs)) {
      state.clockOffsetMs = srvMs - Date.now();
    }
  }

  state.snapshot = snapshot;

  if (snapshot.settings?.refreshIntervalSeconds) {
    state.intervalSeconds = snapshot.settings.refreshIntervalSeconds;
    syncIntervalSelect(state.intervalSeconds);
  }

  const plan = snapshot.data?.plan;
  if (plan) {
    elements.planTag.textContent = plan;
    elements.planTag.title = `Active subscription plan: ${plan}`;
    elements.planTag.classList.remove('hidden');
    elements.titleLabel.classList.add('hidden');
  } else {
    elements.planTag.classList.add('hidden');
    elements.titleLabel.classList.remove('hidden');
  }

  elements.loadingView.classList.add('hidden');
  renderNotice(snapshot);
  renderGroups(snapshot);
  scheduleNextAutoRefresh(snapshot);
  updateFooterAndCountdowns();
}

const app = new App({ name: 'Qufu Antigravity Monitor', version: '1.0.0' }, {});

async function fetchUsage(force) {
  if (state.loading) return;
  setLoading(true);
  updateFooterAndCountdowns();

  try {
    const result = await app.callServerTool({
      name: 'get_usage',
      arguments: { force: Boolean(force) },
    });
    if (result?.structuredContent) {
      applySnapshot(result.structuredContent);
    }
  } catch (err) {
    const fallbackError = {
      ...(state.snapshot ?? {
        ok: false,
        stale: Boolean(state.snapshot?.data),
        lastSuccessAt: state.snapshot?.lastSuccessAt ?? null,
        data: state.snapshot?.data ?? null,
        settings: { refreshIntervalSeconds: state.intervalSeconds },
      }),
      ok: false,
      stale: Boolean(state.snapshot?.data),
      error: {
        code: 'BRIDGE_ERROR',
        message: err instanceof Error ? err.message : 'Failed to communicate with local MCP server.',
        detail: '',
      },
    };
    applySnapshot(fallbackError);
  } finally {
    setLoading(false);
    updateFooterAndCountdowns();
  }
}

async function updateRefreshInterval(seconds) {
  state.intervalSeconds = seconds;
  try {
    const result = await app.callServerTool({
      name: 'set_config',
      arguments: { refreshIntervalSeconds: seconds },
    });
    const updatedSnapshot = result?.structuredContent?.snapshot;
    if (updatedSnapshot) {
      applySnapshot(updatedSnapshot);
    } else {
      scheduleNextAutoRefresh(state.snapshot);
      updateFooterAndCountdowns();
    }
  } catch {
    scheduleNextAutoRefresh(state.snapshot);
    updateFooterAndCountdowns();
  }
}

// Register MCP Apps lifecycle handlers BEFORE connect() so initial tool results are never missed.
app.ontoolinput = () => {
  if (!state.snapshot) {
    elements.loadingView.classList.remove('hidden');
  }
};

app.ontoolresult = (result) => {
  if (result?.structuredContent) {
    applySnapshot(result.structuredContent);
  }
};

app.ontoolcancelled = () => {
  setLoading(false);
  updateFooterAndCountdowns();
};

app.onhostcontextchanged = (ctx) => {
  applyHostContext(ctx);
};

elements.refreshBtn.addEventListener('click', () => {
  void fetchUsage(true);
});

elements.intervalSelect.addEventListener('change', () => {
  const nextSec = Number(elements.intervalSelect.value);
  if (Number.isFinite(nextSec) && nextSec >= 15) {
    void updateRefreshInterval(nextSec);
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.snapshot) {
    const lastMs = state.snapshot.lastAttemptAt ? Date.parse(state.snapshot.lastAttemptAt) : 0;
    const elapsedMs = Date.now() - lastMs;
    if (!state.autoRefreshTimer || elapsedMs >= state.intervalSeconds * 1000) {
      void fetchUsage(false);
    }
  }
});

// Local 1-second tick for countdowns and relative timestamps (zero CLI polling).
setInterval(() => {
  if (!document.hidden) {
    updateFooterAndCountdowns();
  }
}, 1000);

async function bootstrap() {
  try {
    await app.connect();
    applyHostContext(app.getHostContext());

    // Fallback fetch if host mounts the view without delivering an initial tool result.
    state.initialFetchTimer = setTimeout(() => {
      state.initialFetchTimer = null;
      if (!state.snapshot) {
        void fetchUsage(false);
      }
    }, 600);
  } catch (err) {
    elements.loadingView.classList.add('hidden');
    renderNotice({
      data: null,
      error: {
        code: 'BRIDGE_ERROR',
        message: err instanceof Error ? err.message : 'Unable to connect to Antigravity host.',
      },
    });
  }
}

void bootstrap();
