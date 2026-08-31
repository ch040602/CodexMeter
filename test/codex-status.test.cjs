const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCodexRateLimits, parseCodexTokenUsage } = require('../dist/codexStatus.js');

test('reads the weekly Codex bucket used by the local status screen', () => {
  const observedAt = Date.parse('2026-08-30T12:00:00.000Z');
  const result = parseCodexRateLimits({
    rateLimits: {
      limitId: 'codex',
      planType: 'pro',
      primary: { usedPercent: 6, windowDurationMins: 10_080, resetsAt: 1_788_656_217 },
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        planType: 'pro',
        primary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: 1_788_656_217 },
      },
      codex_bengalfox: {
        limitId: 'codex_bengalfox',
        primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1_788_108_864 },
        secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 1_788_695_664 },
      },
    },
  }, observedAt);

  assert.deepEqual(result, {
    usedPct: 7,
    resetAt: 1_788_656_217_000,
    planName: 'pro',
    observedAt,
  });
});

test('rejects a response without the main weekly Codex window', () => {
  assert.equal(parseCodexRateLimits({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_788_108_864 },
    },
  }), null);
});

test('parses account token usage buckets from the local app-server', () => {
  assert.deepEqual(parseCodexTokenUsage({
    summary: { lifetimeTokens: 1_000_000 },
    dailyUsageBuckets: [
      { startDate: '2026-08-30', tokens: 4_000 },
      { startDate: 'invalid', tokens: 9_000 },
      { startDate: '2026-08-31', tokens: -2 },
    ],
  }), {
    dailyUsageBuckets: [
      { startDate: '2026-08-30', tokens: 4_000 },
      { startDate: '2026-08-31', tokens: 0 },
    ],
  });
});

test('returns no account token usage when the response has no buckets', () => {
  assert.equal(parseCodexTokenUsage({ summary: { lifetimeTokens: 1_000 } }), null);
});
