'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { Static } = require('../lib/static.js');

const root = process.cwd();

const application = {
  path: path.join(root, 'test'),
  absolute(relative) {
    return path.join(this.path, relative);
  },
};

test('lib/static - should initialize and manage files', () => {
  const cache = new Static('lib', application);
  assert.strictEqual(cache.files instanceof Map, true);
  assert.strictEqual(cache.files.size, 0);
  assert.strictEqual(cache.get('/example/add.js'), undefined);

  const data = Buffer.from('test content');
  const stat = { size: data.length };
  const filesMap = new Map([['/example/add.js', { data, stat }]]);
  cache.setFiles(filesMap);
  assert.strictEqual(cache.files.size, 1);
  const file = cache.get('/example/add.js');
  assert.strictEqual(file.data, data);
  assert.strictEqual(file.stat.size, 12);

  // updateFiles adds entries
  const data2 = Buffer.from('more');
  cache.updateFiles(new Map([['/new.js', { data: data2, stat: { size: 4 } }]]));
  assert.strictEqual(cache.files.size, 2);
  assert.ok(cache.get('/new.js'));

  // deleteFiles removes entries
  cache.deleteFiles(['/example/add.js']);
  assert.strictEqual(cache.files.size, 1);
  assert.strictEqual(cache.get('/example/add.js'), undefined);

  // setFiles replaces all
  cache.setFiles(new Map());
  assert.strictEqual(cache.files.size, 0);
});
