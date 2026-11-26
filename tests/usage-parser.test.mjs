import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatPlainTextSummary,
  formatResetCountdown,
  getSeverityForPercent,
  parseAgyUsageOutput,
} from '../src/usage-parser.mjs';

const REAL_AGY_SAMPLE = JSON.stringify({
  conversation_id: '',
  status: 'SUCCESS',
  response:
    'Gemini Models\tWeekly Limit Remaining\t92%\t2026-12-02T21:21:58Z\n' +
    'Gemini Models\tFive Hour Limit Remaining\t69%\t2026-11-26T09:19:57Z\n' +
    'Claude and GPT models\tWeekly Limit Remaining\t100%\t1970-01-01T00:00:00Z\n' +
    'Claude and GPT models\tFive Hour Limit Remaining\t100%\t1970-01-01T00:00:00Z\n',
  duration_seconds: 0,
  num_turns: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
  },
  command: {
    name: 'usage',
    data: {
      description: 'Shared model limits',
      groups: [
        {
          name: 'Gemini Models',
          description: 'Models within this group: Gemini 4 Neon, Gemini 4 Carbon',
          buckets: [
            {
              id: 'gemini-weekly',
              name: 'Weekly Limit Remaining',
              description: 'Refreshes in 6 days, 16 hours.',
              window: 'weekly',
              remaining_fraction: 0.9174764752388,
              reset_time: '2026-12-02T21:21:58Z',
            },
            {
              id: 'gemini-5h',
              name: 'Five Hour Limit Remaining',
              description: 'Refreshes in 4 hours, 30 minutes.',
              window: '5h',
              remaining_fraction: 0.6927598118782043,
              reset_time: '2026-11-26T09:19:57Z',
            },
          ],
        },
        {
          name: 'Claude and GPT models',
          description: 'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B',
          buckets: [
            {
              id: '3p-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 1,
              reset_time: '1970-01-01T00:00:00Z',
            },
            {
              id: '3p-5h',
              name: 'Five Hour Limit Remaining',
              window: '5h',
              remaining_fraction: 1,
              reset_time: '1970-01-01T00:00:00Z',
            },
          ],
        },
      ],
    },
  },
});

test('parses real agy -p "/usage" --output-format json output accurately', () => {
  const parsed = parseAgyUsageOutput(REAL_AGY_SAMPLE);

  assert.equal(parsed.source, 'agy-cli');
  assert.equal(parsed.tokensConsumed, 0);
  assert.equal(parsed.plan, null);
  assert.equal(parsed.groups.length, 2);

  const [gemini, claudeGpt] = parsed.groups;
  assert.equal(gemini.id, 'gemini');
  assert.equal(gemini.fiveHour.remainingPercent, 69);
  assert.equal(gemini.fiveHour.severity, 'green');
  assert.equal(gemini.fiveHour.resetAt, '2026-11-26T09:19:57.000Z');
  assert.equal(gemini.fiveHour.isUnused, false);

  assert.equal(gemini.weekly.remainingPercent, 92);
  assert.equal(gemini.weekly.severity, 'green');
  assert.equal(gemini.weekly.resetAt, '2026-12-02T21:21:58.000Z');

  assert.equal(claudeGpt.id, 'claude_gpt');
  assert.equal(claudeGpt.fiveHour.remainingPercent, 100);
  assert.equal(claudeGpt.fiveHour.resetAt, null);
  assert.equal(claudeGpt.fiveHour.isUnused, true);
  assert.equal(claudeGpt.weekly.remainingPercent, 100);
  assert.equal(claudeGpt.weekly.resetAt, null);
  assert.equal(claudeGpt.weekly.isUnused, true);
});

test('maps color severity bands strictly (50-100 green, 20-49 yellow, 0-19 red)', () => {
  assert.equal(getSeverityForPercent(100), 'green');
  assert.equal(getSeverityForPercent(50), 'green');
  assert.equal(getSeverityForPercent(49), 'yellow');
  assert.equal(getSeverityForPercent(20), 'yellow');
  assert.equal(getSeverityForPercent(19), 'red');
  assert.equal(getSeverityForPercent(0), 'red');
  assert.equal(getSeverityForPercent(null), 'unknown');
  assert.equal(getSeverityForPercent(Number.NaN), 'unknown');
});

test('never fabricates fake percentages when buckets or groups are missing', () => {
  const partialPayload = JSON.stringify({
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        plan_tier: 'Google AI Pro',
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              {
                id: 'gemini-5h',
                window: '5h',
                remaining_fraction: 0.18,
                reset_time: '2026-11-26T10:00:00Z',
              },
              {
                id: 'gemini-weekly',
                window: 'weekly',
                remaining_fraction: null,
                reset_time: '',
              },
            ],
          },
        ],
      },
    },
  });

  const parsed = parseAgyUsageOutput(partialPayload);
  assert.equal(parsed.plan, 'Google AI Pro');

  const [gemini, claudeGpt] = parsed.groups;
  assert.equal(gemini.fiveHour.remainingPercent, 18);
  assert.equal(gemini.fiveHour.severity, 'red');
  assert.equal(gemini.weekly.remainingPercent, null);
  assert.equal(gemini.weekly.severity, 'unknown');

  assert.equal(claudeGpt.fiveHour.remainingPercent, null);
  assert.equal(claudeGpt.weekly.remainingPercent, null);
  assert.equal(claudeGpt.fiveHour.severity, 'unknown');
});

test('falls back to TSV response parsing when command.data.groups is absent', () => {
  const tsvOnly = JSON.stringify({
    status: 'SUCCESS',
    response:
      'Gemini Models\tFive Hour Limit Remaining\t44%\t2026-11-26T09:00:00Z\n' +
      'Claude and GPT models\tWeekly Limit Remaining\t12%\t2026-12-01T00:00:00Z\n',
  });

  const parsed = parseAgyUsageOutput(tsvOnly);
  assert.equal(parsed.groups[0].fiveHour.remainingPercent, 44);
  assert.equal(parsed.groups[0].fiveHour.severity, 'yellow');
  assert.equal(parsed.groups[1].weekly.remainingPercent, 12);
  assert.equal(parsed.groups[1].weekly.severity, 'red');
});

test('throws classified errors for auth failures, network failures, and malformed JSON', () => {
  assert.throws(
    () => parseAgyUsageOutput(''),
    (err) => err.code === 'PARSE_ERROR'
  );

  assert.throws(
    () => parseAgyUsageOutput('not-json'),
    (err) => err.code === 'PARSE_ERROR'
  );

  assert.throws(
    () =>
      parseAgyUsageOutput(
        JSON.stringify({ status: 'ERROR', error: 'authentication required: please sign in' })
      ),
    (err) => err.code === 'AUTH_REQUIRED'
  );

  assert.throws(
    () =>
      parseAgyUsageOutput(
        JSON.stringify({ status: 'ERROR', error: 'dial tcp: no such host' })
      ),
    (err) => err.code === 'NETWORK_ERROR'
  );
});

test('formats reset countdowns and plain-text summaries accurately', () => {
  const baseMs = Date.parse('2026-11-26T05:00:00Z');
  assert.equal(formatResetCountdown(null, true, baseMs), 'Full');
  assert.equal(formatResetCountdown(null, false, baseMs), '-');
  assert.equal(formatResetCountdown('2026-11-26T05:00:00Z', false, baseMs), 'Refreshing');
  assert.equal(formatResetCountdown('2026-11-26T05:00:45Z', false, baseMs), '45s');
  assert.equal(formatResetCountdown('2026-11-26T05:12:05Z', false, baseMs), '12m 05s');
  assert.equal(formatResetCountdown('2026-11-26T09:30:00Z', false, baseMs), '4h 30m');
  assert.equal(formatResetCountdown('2026-11-28T08:00:00Z', false, baseMs), '2d 3h');

  const parsed = parseAgyUsageOutput(REAL_AGY_SAMPLE);
  const summary = formatPlainTextSummary(
    {
      data: parsed,
      stale: false,
      error: null,
      lastSuccessAt: '2026-11-26T05:00:00Z',
    },
    baseMs
  );
  assert.match(summary, /Gemini Models: 5h 69%/);
  assert.match(summary, /Claude & GPT Models: 5h 100% \(Full\)/);
});
