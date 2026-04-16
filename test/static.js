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

test('lib/static - serve uses fast exact-hit path for regular files', async () => {
  const cache = new Static('lib', application);
  const data = Buffer.from('exact hit');
  cache.setFiles(new Map([['/example/add.js', { data, stat: { size: data.length } }]]));
  cache.find = () => {
    throw new Error('find should not be called for exact hit');
  };

  let written = null;
  const transport = {
    req: { headers: {} },
    write: (...args) => {
      written = args;
    },
  };

  await cache.serve('/example/add.js', transport);
  assert.ok(written);
  assert.strictEqual(written[0], data);
  assert.strictEqual(written[1], 200);
  assert.strictEqual(written[2], 'js');
});

test('lib/static - serve still uses find for fallback paths', async () => {
  const cache = new Static('lib', application);
  const data = Buffer.from('index');
  cache.setFiles(new Map([['/example/index.html', { data, stat: { size: data.length } }]]));

  const originalFind = cache.find.bind(cache);
  let findCalls = 0;
  cache.find = (...args) => {
    findCalls++;
    return originalFind(...args);
  };

  let written = null;
  const transport = {
    req: { headers: {} },
    write: (...args) => {
      written = args;
    },
  };

  await cache.serve('/example/', transport);
  assert.ok(findCalls > 0);
  assert.ok(written);
  assert.strictEqual(written[0], data);
  assert.strictEqual(written[1], 200);
});
