'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { StaticSource } = require('../../lib/cache/StaticSource.js');

const root = process.cwd();

const application = {
  path: path.join(root, 'test'),
  watcher: { watch() {} },
  absolute(relative) {
    return path.join(this.path, relative);
  },
};

test('StaticSource - should load files from disk', async () => {
  const source = new StaticSource('lib', application);
  assert.strictEqual(source.files instanceof Map, true);
  assert.strictEqual(source.files.size, 0);
  await source.load();
  assert.ok(source.files.size > 0);
  const file = source.files.get('/example/add.js');
  assert.ok(file);
  assert.ok(file.stat);
  assert.ok(file.path);
});

test('StaticSource - file entries include path field', async () => {
  const source = new StaticSource('lib', application);
  await source.load();
  for (const [, file] of source.files) {
    assert.ok(file.path, 'file must have path');
    assert.ok(file.stat, 'file must have stat');
  }
});
