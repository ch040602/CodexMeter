const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findCodexBinary, parseCodexRateLimits, parseCodexTokenUsage } = require('../dist/codexStatus.js');

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

test('finds the Codex binary from the managed package root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-meter-managed-'));
  const binary = path.join(
    root,
    'node_modules',
    '@openai',
    'codex-win32-x64',
    'vendor',
    'x86_64-pc-windows-msvc',
    'bin',
    'codex.exe',
  );
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '');

  assert.equal(findCodexBinary({ CODEX_MANAGED_PACKAGE_ROOT: root, PATH: '' }, 'win32', 'x64'), binary);
});

test('finds the Codex binary next to a PATH shim without APPDATA', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-meter-path-'));
  const shimDirectory = path.join(root, 'bin');
  const binary = path.join(
    root,
    'node_modules',
    '@openai',
    'codex',
    'node_modules',
    '@openai',
    'codex-win32-x64',
    'vendor',
    'x86_64-pc-windows-msvc',
    'bin',
    'codex.exe',
  );
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.mkdirSync(shimDirectory, { recursive: true });
  fs.writeFileSync(binary, '');
  fs.writeFileSync(path.join(shimDirectory, 'codex.cmd'), '');

  assert.equal(findCodexBinary({ PATH: shimDirectory }, 'win32', 'x64'), binary);
});
