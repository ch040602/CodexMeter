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
  assert.equal(snapshot.localCapacityPct, null);
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
});
