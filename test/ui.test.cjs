const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSnapshot } = require('../dist/usage');
const { DEFAULT_SETTINGS } = require('../dist/contracts');

const styles = fs.readFileSync(path.join(__dirname, '..', 'ui', 'styles.css'), 'utf8');

test('centers the two-number overlay content vertically', () => {
  const match = styles.match(/\.overlay-minimal \.overlay-content\s*\{([^}]*)\}/);
  assert.ok(match, 'minimal overlay content rule should exist');
  assert.match(match[1], /align-items:\s*center/);
  assert.match(match[1], /height:\s*100%/);
});

test('shows an actionable connection failure while retaining measured local tokens', async () => {
  const snapshot = buildSnapshot([], 80);
  snapshot.local.tokens = 12000;
  snapshot.connection = {
    binaryPath: null, codexHome: 'C:\\custom-codex', rateLimitError: null,
    tokenUsageError: 'Codex 실행 파일을 찾지 못했습니다. Codex를 설치한 뒤 새로고침하세요.',
  };
  const elements = new Map();
  const getElementById = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, addEventListener() {} });
    return elements.get(id);
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8'), {
    window: { meter: {
      getSnapshot: async () => snapshot, getSettings: async () => DEFAULT_SETTINGS, onUpdate() {},
    } },
    document: { getElementById, documentElement: { dataset: {} } },
    location: { search: '' }, URLSearchParams,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(getElementById('connectionNotice').textContent, /찾지 못.*설치/);
  assert.equal(getElementById('connectionNotice').hidden, false);
  assert.equal(getElementById('localTokens').textContent, '12.0K');
  assert.equal(getElementById('localAccountUsageShareWeek').textContent, '계산 불가');
});
