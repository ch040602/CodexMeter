const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSnapshot, parseLocalUsageLine, WEEK_MS } = require('../dist/usage.js');

function line(timestamp, usedPct, resetAt, tokens = 120) {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: new Date(timestamp).toISOString(),
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: tokens - 20,
          cached_input_tokens: 40,
          output_tokens: 20,
          total_tokens: tokens,
        },
      },
      rate_limits: {
        plan_type: 'pro',
        primary: { window_minutes: 10_080, used_percent: usedPct, resets_at: resetAt / 1_000 },
      },
    },
  });
}

test('parses local token totals and provider-reported weekly percentage', () => {
  const now = Date.parse('2026-08-30T06:00:00.000Z');
  const resetAt = now + 4 * 24 * 60 * 60 * 1_000;
  const parsed = parseLocalUsageLine(line(now, 37, resetAt, 500), 'one');
  assert.equal(parsed.usage.totalTokens, 500);
  assert.equal(parsed.usage.cachedInputTokens, 40);
  assert.equal(parsed.weekly.usedPct, 37);
  assert.equal(parsed.weekly.planName, 'pro');
});

test('keeps account percentage and this-PC tokens as separate measurements', () => {
  const now = Date.parse('2026-08-30T06:00:00.000Z');
  const resetAt = now + 4 * 24 * 60 * 60 * 1_000;
  const current = parseLocalUsageLine(line(now - 1_000, 61, resetAt, 500), 'current');
  const beforeWindow = parseLocalUsageLine(line(resetAt - WEEK_MS - 1, 2, resetAt, 900), 'old');
  const snapshot = buildSnapshot([beforeWindow, current], 60, now);
  assert.equal(snapshot.accountUsedPct, 61);
  assert.equal(snapshot.accountRemainingPct, 39);
  assert.equal(snapshot.local.tokens, 500);
  assert.equal(snapshot.guardrailExceeded, true);
  assert.equal(snapshot.level, 'danger');
});

test('does not present an expired quota sample as current', () => {
  const now = Date.parse('2026-08-30T06:00:00.000Z');
  const expired = parseLocalUsageLine(line(now - WEEK_MS, 92, now - 1, 500), 'expired');
  const snapshot = buildSnapshot([expired], 80, now);
  assert.equal(snapshot.status, 'expired');
  assert.equal(snapshot.accountUsedPct, null);
  assert.equal(snapshot.level, 'unknown');
});

test('prefers the Codex local status percentage over a lagging JSONL sample', () => {
  const now = Date.parse('2026-08-30T12:00:00.000Z');
  const resetAt = now + 5 * 24 * 60 * 60 * 1_000;
  const lagging = parseLocalUsageLine(line(now - 10_000, 6, resetAt, 500), 'lagging');
  const snapshot = buildSnapshot([lagging], 80, now, {
    accountRateLimit: { usedPct: 7, resetAt, planName: 'pro', observedAt: now - 500 },
  });

  assert.equal(snapshot.accountUsedPct, 7);
  assert.equal(snapshot.accountRemainingPct, 93);
  assert.equal(snapshot.accountObservedAt, now - 500);
  assert.equal(snapshot.source, 'codex-local-status');
  assert.equal(snapshot.local.tokens, 500);
});

test('separates this-PC usage today from the active weekly window', () => {
  const now = new Date(2026, 7, 30, 18, 0, 0, 0).getTime();
  const resetAt = now + 2 * 24 * 60 * 60 * 1_000;
  const yesterday = parseLocalUsageLine(
    line(new Date(2026, 7, 29, 23, 30, 0, 0).getTime(), 7, resetAt, 300),
    'yesterday',
  );
  const today = parseLocalUsageLine(
    line(new Date(2026, 7, 30, 9, 0, 0, 0).getTime(), 7, resetAt, 500),
    'today',
  );

  const snapshot = buildSnapshot([yesterday, today], 80, now);

  assert.equal(snapshot.local.tokens, 800);
  assert.equal(snapshot.local.requests, 2);
  assert.equal(snapshot.localToday.tokens, 500);
  assert.equal(snapshot.localToday.requests, 1);
});

test('does not count pre-reset activity in today usage after a weekly reset', () => {
  const now = new Date(2026, 7, 30, 18, 0, 0, 0).getTime();
  const windowStart = new Date(2026, 7, 30, 12, 0, 0, 0).getTime();
  const resetAt = windowStart + WEEK_MS;
  const beforeReset = parseLocalUsageLine(
    line(new Date(2026, 7, 30, 9, 0, 0, 0).getTime(), 7, resetAt, 300),
    'before-reset',
  );
  const afterReset = parseLocalUsageLine(
    line(new Date(2026, 7, 30, 13, 0, 0, 0).getTime(), 7, resetAt, 500),
    'after-reset',
  );

  const snapshot = buildSnapshot([beforeReset, afterReset], 80, now);

  assert.equal(snapshot.local.tokens, 500);
  assert.equal(snapshot.localToday.tokens, 500);
  assert.equal(snapshot.accountTodayUsedPct, 7);
  assert.equal(snapshot.accountTodayBasis, 'reset');
});

test('calculates today account usage from a recent local baseline', () => {
  const now = new Date(2026, 7, 30, 18, 0, 0, 0).getTime();
  const resetAt = now + 4 * 24 * 60 * 60 * 1_000;
  const baseline = parseLocalUsageLine(
    line(new Date(2026, 7, 29, 23, 50, 0, 0).getTime(), 31, resetAt, 300),
    'baseline',
  );
  const today = parseLocalUsageLine(
    line(new Date(2026, 7, 30, 17, 0, 0, 0).getTime(), 37, resetAt, 500),
    'today-current',
  );

  const snapshot = buildSnapshot([baseline, today], 80, now);

  assert.equal(snapshot.accountTodayUsedPct, 6);
  assert.equal(snapshot.accountTodayBasis, 'observed');
  assert.equal(snapshot.accountTodayBaselineAt, baseline.timestampMs);
});

test('waits for a trustworthy daily baseline instead of inventing a percentage', () => {
  const now = new Date(2026, 7, 30, 18, 0, 0, 0).getTime();
  const resetAt = now + 4 * 24 * 60 * 60 * 1_000;
  const today = parseLocalUsageLine(
    line(new Date(2026, 7, 30, 17, 0, 0, 0).getTime(), 37, resetAt, 500),
    'today-only',
  );

  const snapshot = buildSnapshot([today], 80, now);

  assert.equal(snapshot.accountTodayUsedPct, null);
  assert.equal(snapshot.accountTodayBasis, 'unavailable');
  assert.equal(snapshot.accountTodayBaselineAt, null);
});

test('infers the weekly token limit and this-PC plan percentage from matching current-window data', () => {
  const now = new Date(2026, 7, 31, 18, 0, 0, 0).getTime();
  const resetAt = new Date(2026, 8, 7, 16, 0, 0, 0).getTime();
  const current = parseLocalUsageLine(
    line(new Date(2026, 7, 31, 17, 0, 0, 0).getTime(), 20, resetAt, 2_000),
    'current',
  );

  const snapshot = buildSnapshot([current], 80, now, {
    accountRateLimit: { usedPct: 20, resetAt, planName: 'pro', observedAt: now },
    accountTokenUsage: {
      dailyUsageBuckets: [{ startDate: '2026-08-31', tokens: 10_000 }],
    },
  });

  assert.equal(snapshot.accountWindowTokens, 10_000);
  assert.equal(snapshot.accountTokenBasis, 'current-window');
  assert.equal(snapshot.accountWeeklyLimitTokens, 50_000);
  assert.equal(snapshot.localQuotaUsedPct, 4);
  assert.equal(snapshot.localQuotaUsedTodayPct, 4);
  assert.equal(snapshot.accountQuotaBasis, 'inferred');
});

test('calculates this-PC share of account usage separately from plan quota usage', () => {
  const now = new Date(2026, 7, 31, 18, 0, 0, 0).getTime();
  const resetAt = new Date(2026, 8, 7, 16, 0, 0, 0).getTime();
  const current = parseLocalUsageLine(
    line(new Date(2026, 7, 31, 17, 0, 0, 0).getTime(), 20, resetAt, 2_000),
    'current',
  );

  const snapshot = buildSnapshot([current], 80, now, {
    accountRateLimit: { usedPct: 20, resetAt, planName: 'pro', observedAt: now },
    accountTokenUsage: {
      dailyUsageBuckets: [{ startDate: '2026-08-31', tokens: 10_000 }],
    },
  });

  assert.equal(snapshot.localAccountUsageSharePct, 20);
  assert.equal(snapshot.localAccountUsageShareTodayPct, 20);
  assert.equal(snapshot.localQuotaUsedPct, 4);
  assert.equal(snapshot.localQuotaUsedTodayPct, 4);
});

test('does not infer a plan limit without recent account token data', () => {
  const now = new Date(2026, 7, 31, 16, 0, 0, 0).getTime();
  const resetAt = new Date(2026, 8, 7, 16, 0, 0, 0).getTime();
  const current = parseLocalUsageLine(line(now, 20, resetAt, 2_000), 'current');
  const snapshot = buildSnapshot([current], 80, now, {
    accountRateLimit: { usedPct: 20, resetAt, planName: 'pro', observedAt: now },
    accountTokenUsage: {
      dailyUsageBuckets: [{ startDate: '2026-08-20', tokens: 10_000 }],
    },
  });

  assert.equal(snapshot.accountWindowTokens, null);
  assert.equal(snapshot.accountTokenBasis, 'unavailable');
  assert.equal(snapshot.accountWeeklyLimitTokens, null);
  assert.equal(snapshot.localAccountUsageSharePct, null);
  assert.equal(snapshot.localAccountUsageShareTodayPct, null);
  assert.equal(snapshot.localQuotaUsedPct, null);
  assert.equal(snapshot.accountQuotaBasis, 'unavailable');
});

test('keeps local percentage values available while the current account day bucket is pending', () => {
  const now = new Date(2026, 7, 31, 18, 0, 0, 0).getTime();
  const resetAt = new Date(2026, 8, 7, 16, 0, 0, 0).getTime();
  const current = parseLocalUsageLine(
    line(new Date(2026, 7, 31, 17, 0, 0, 0).getTime(), 20, resetAt, 2_000),
    'current',
  );

  const snapshot = buildSnapshot([current], 80, now, {
    accountRateLimit: { usedPct: 20, resetAt, planName: 'pro', observedAt: now },
    accountTokenUsage: {
      dailyUsageBuckets: [
        { startDate: '2026-08-25', tokens: 10_000 },
        { startDate: '2026-08-30', tokens: 5_000 },
      ],
    },
  });

  assert.equal(snapshot.accountTokenBasis, 'recent-estimate');
  assert.equal(snapshot.accountWindowTokens, 15_000);
  assert.equal(snapshot.accountWeeklyLimitTokens, 75_000);
  assert.equal(snapshot.localAccountUsageSharePct, 13.3);
  assert.equal(snapshot.localQuotaUsedPct, 2.67);
  assert.equal(snapshot.localAccountUsageShareTodayPct, 13.3);
  assert.match(snapshot.accountUsageShareReason, /추정/);
  assert.match(snapshot.accountQuotaReason, /추정/);
});

test('does not infer a plan limit from a zero rate-limit percentage', () => {
  const now = new Date(2026, 7, 31, 16, 0, 0, 0).getTime();
  const resetAt = new Date(2026, 8, 7, 16, 0, 0, 0).getTime();
  const current = parseLocalUsageLine(line(now, 0, resetAt, 2_000), 'current');
  const snapshot = buildSnapshot([current], 80, now, {
    accountRateLimit: { usedPct: 0, resetAt, planName: 'pro', observedAt: now },
    accountTokenUsage: {
      dailyUsageBuckets: [{ startDate: '2026-08-31', tokens: 10_000 }],
    },
  });

  assert.equal(snapshot.accountWindowTokens, 10_000);
  assert.equal(snapshot.accountWeeklyLimitTokens, null);
  assert.equal(snapshot.localQuotaUsedPct, null);
  assert.equal(snapshot.accountQuotaBasis, 'unavailable');
});
