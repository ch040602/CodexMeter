const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalUsageScanner } = require('../dist/scanner.js');

function row(timestamp, usedPct, resetAt, totalTokens) {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: new Date(timestamp).toISOString(),
    payload: {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: totalTokens - 10, output_tokens: 10, total_tokens: totalTokens } },
      rate_limits: {
        plan_type: 'pro',
        primary: { window_minutes: 10_080, used_percent: usedPct, resets_at: resetAt / 1_000 },
      },
    },
  });
}

test('reuses unchanged files and reads only appended JSONL bytes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-meter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  const now = Date.now();
  const resetAt = now + 3 * 24 * 60 * 60 * 1_000;
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: 'session-one' } })}\n${row(now - 2_000, 10, resetAt, 100)}\n`);

  const scanner = new LocalUsageScanner([root]);
  const first = await scanner.scan(80, now);
  assert.equal(first.local.tokens, 100);
  assert.ok(first.bytesRead > 0);

  const unchanged = await scanner.scan(80, now);
  assert.equal(unchanged.local.tokens, 100);
  assert.equal(unchanged.bytesRead, 0);

  fs.appendFileSync(file, `${row(now - 1_000, 11, resetAt, 200)}\n`);
  const appended = await scanner.scan(80, now);
  assert.equal(appended.local.tokens, 300);
  assert.equal(appended.local.requests, 2);
  assert.ok(appended.bytesRead > 0);
});

test('keeps tracking a live session whose filesystem mtime is stale', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-meter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  const now = Date.parse('2026-08-31T12:00:00.000Z');
  const resetAt = now + 3 * 24 * 60 * 60 * 1_000;
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: 'stale-session' } })}\n${row(now - 1_000, 10, resetAt, 100)}\n`);
  const stale = new Date(now - 10 * 24 * 60 * 60 * 1_000);
  fs.utimesSync(file, stale, stale);

  const scanner = new LocalUsageScanner([root]);
  const first = await scanner.scan(80, now);
  assert.equal(first.local.tokens, 100);

  fs.appendFileSync(file, row(now, 11, resetAt, 200) + '\n');
  const appended = await scanner.scan(80, now);
  assert.equal(appended.local.tokens, 300);
  assert.equal(appended.local.requests, 2);
});
