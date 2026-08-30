const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  normalizeOverlayOpacity,
  normalizeOverlayPosition,
  readSettings,
  writeSettings,
} = require('../dist/settings.js');

test('keeps overlay opacity within the readable range', () => {
  assert.equal(normalizeOverlayOpacity(86.6), 87);
  assert.equal(normalizeOverlayOpacity(15), 35);
  assert.equal(normalizeOverlayOpacity(120), 100);
  assert.equal(normalizeOverlayOpacity('80'), 90);
});

test('validates and rounds a saved overlay position', () => {
  assert.deepEqual(normalizeOverlayPosition({ x: -219.6, y: 80.4 }), { x: -220, y: 80 });
  assert.equal(normalizeOverlayPosition({ x: '10', y: 20 }), null);
  assert.equal(normalizeOverlayPosition({ x: Number.POSITIVE_INFINITY, y: 20 }), null);
});

test('persists the overlay position with the usage settings', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-meter-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');
  const expected = {
    guardrailPct: 72,
    overlayVisible: true,
    overlayOpacity: 76,
    overlayPosition: { x: -320, y: 48 },
  };
  await writeSettings(file, expected);
  assert.deepEqual(await readSettings(file), expected);
});
