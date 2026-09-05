const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('reports startup failure visibly and exits with a code that permits scheduled retries', async () => {
  const file = path.join(__dirname, '..', 'dist', 'main.js');
  const load = createRequire(file);
  let exitCode;
  let errorBox;
  const electron = {
    app: {
      requestSingleInstanceLock: () => true, on() {},
      whenReady: () => Promise.reject(new Error('profile is not writable')),
      quit() {}, exit: code => { exitCode = code; },
    },
    dialog: { showErrorBox: (title, content) => { errorBox = { title, content }; } },
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    exports: {}, __dirname: path.dirname(file),
    require: name => name === 'electron' ? electron : load(name),
    console: { error() {} },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(exitCode, 1);
  assert.match(errorBox.content, /profile is not writable/);
});
