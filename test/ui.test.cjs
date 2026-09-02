const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const styles = fs.readFileSync(path.join(__dirname, '..', 'ui', 'styles.css'), 'utf8');

test('centers the two-number overlay content vertically', () => {
  const match = styles.match(/\.overlay-minimal \.overlay-content\s*\{([^}]*)\}/);
  assert.ok(match, 'minimal overlay content rule should exist');
  assert.match(match[1], /align-items:\s*center/);
  assert.match(match[1], /height:\s*100%/);
});
