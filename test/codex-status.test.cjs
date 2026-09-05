const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findCodexBinary, codexHome, CodexStatusClient, parseCodexRateLimits, parseCodexTokenUsage } = require('../dist/codexStatus.js');

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

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-meter-discovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return file;
}

test('finds a desktop-only Codex installation without npm or PATH shims', t => {
  const local = temporaryDirectory(t);
  const binary = touch(path.join(local, 'OpenAI', 'Codex', 'bin', 'build-hash', 'codex.exe'));
  assert.equal(findCodexBinary({ LOCALAPPDATA: local, PATH: '' }, 'win32', 'x64'), binary);
});

test('uses the newest installed desktop build and skips incomplete builds', t => {
  const local = temporaryDirectory(t);
  const old = touch(path.join(local, 'OpenAI', 'Codex', 'bin', 'zzz-old', 'codex.exe'));
  const recent = touch(path.join(local, 'OpenAI', 'Codex', 'bin', 'aaa-new', 'codex.exe'));
  fs.utimesSync(old, new Date(0), new Date(0));
  fs.mkdirSync(path.join(local, 'OpenAI', 'Codex', 'bin', 'incomplete'));
  assert.equal(findCodexBinary({ LOCALAPPDATA: local, PATH: '' }, 'win32', 'x64'), recent);
});

test('honors an explicit executable path and never treats a directory as an executable', t => {
  const root = temporaryDirectory(t);
  const binary = touch(path.join(root, 'custom', 'codex.exe'));
  assert.equal(findCodexBinary({ CODEX_METER_CODEX_PATH: binary, PATH: '' }, 'win32', 'x64'), binary);
  assert.equal(findCodexBinary({ CODEX_METER_CODEX_PATH: root, PATH: '' }, 'win32', 'x64'), null);
});

test('uses CODEX_HOME for local session discovery', () => {
  assert.equal(codexHome({ CODEX_HOME: 'C:\\codex-data' }), path.resolve('C:\\codex-data'));
  assert.equal(codexHome({}), path.join(os.homedir(), '.codex'));
});

function serverClient(t, mode = 'ready', delay = 0) {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const root = temporaryDirectory(t);
  const binary = touch(path.join(root, 'codex.exe'));
  const env = { CODEX_METER_CODEX_PATH: binary, PATH: '' };
  let child;
  t.mock.method(childProcess, 'spawn', (_file, _args, options) => {
    child = originalSpawn(process.execPath, [path.join(__dirname, 'fixtures', 'status-server.cjs'),
      typeof mode === 'function' ? mode() : mode, String(delay)], options);
    return child;
  });
  const client = new CodexStatusClient(env);
  t.after(() => client.close());
  return { client, env, binary, getChild: () => child };
}

test('completes the documented handshake before querying both status methods', async t => {
  const { client } = serverClient(t);
  const [rate, usage] = await Promise.all([client.readWeeklyLimit(), client.readTokenUsage()]);
  assert.equal(rate?.usedPct, 42);
  assert.equal(usage?.dailyUsageBuckets[0].tokens, 1000);
  assert.equal(client.getDiagnostics().tokenUsageError, null);
});

test('allows a slow cold start instead of repeatedly killing it at five seconds', async t => {
  const { client } = serverClient(t, 'ready', 5500);
  assert.equal((await client.readTokenUsage())?.dailyUsageBuckets[0].tokens, 1000);
});

test('reports unsupported token usage while keeping account percentage available', async t => {
  const { client } = serverClient(t, 'unsupported');
  const [rate, usage] = await Promise.all([client.readWeeklyLimit(), client.readTokenUsage()]);
  assert.equal(rate?.usedPct, 42);
  assert.equal(usage, null);
  assert.match(client.getDiagnostics().tokenUsageError, /지원하지|업데이트/);
});

test('a failed rate-limit request does not cancel the concurrent token request', async t => {
  const { client } = serverClient(t, 'rate-error');
  const [rate, usage] = await Promise.all([client.readWeeklyLimit(), client.readTokenUsage()]);
  assert.equal(rate, null);
  assert.equal(usage?.dailyUsageBuckets[0].tokens, 1000);
  assert.match(client.getDiagnostics().rateLimitError, /로그인/);
});

test('discovers Codex installed after the meter has already started', async t => {
  const { client, env, binary } = serverClient(t);
  fs.unlinkSync(binary);
  assert.equal(await client.readWeeklyLimit(), null);
  assert.match(client.getDiagnostics().rateLimitError, /찾지 못/);
  touch(binary);
  assert.equal((await client.readWeeklyLimit())?.usedPct, 42);
  assert.equal(client.getDiagnostics().rateLimitError, null);
});

test('reconnects after an unsupported query so updating Codex takes effect on refresh', async t => {
  let launches = 0;
  const { client } = serverClient(t, () => ++launches === 1 ? 'unsupported' : 'ready');
  assert.equal(await client.readTokenUsage(), null);
  assert.equal((await client.readTokenUsage())?.dailyUsageBuckets[0].tokens, 1000);
  assert.equal(client.getDiagnostics().tokenUsageError, null);
});

test('handles a broken input pipe and reconnects without crashing the meter', async t => {
  const { client, getChild } = serverClient(t);
  assert.equal((await client.readWeeklyLimit())?.usedPct, 42);
  const previous = getChild();
  assert.doesNotThrow(() => previous.stdin.emit('error', new Error('EPIPE')));
  assert.equal((await client.readWeeklyLimit())?.usedPct, 42);
  assert.notEqual(getChild(), previous);
});

for (const stream of ['stdout', 'stderr']) {
  test(`handles a broken ${stream} pipe without crashing the meter`, async t => {
    const { client, getChild } = serverClient(t);
    assert.equal((await client.readWeeklyLimit())?.usedPct, 42);
    assert.doesNotThrow(() => getChild()[stream].emit('error', new Error('EIO')));
    assert.equal((await client.readWeeklyLimit())?.usedPct, 42);
  });
}
