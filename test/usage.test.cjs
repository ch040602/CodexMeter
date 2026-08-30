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
