'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { Static } = require('../../lib/static.js');
const { FileCache } = require('../../lib/cache/FileCache.js');
const { StaticSource } = require('../../lib/cache/StaticSource.js');

const { promises: fsp } = require('node:fs');

const root = process.cwd();

const mockApp = {
  path: path.join(root, 'test'),
  watcher: { watch() {} },
  absolute(relative) {
    return path.join(this.path, relative);
  },
};

const workerApp = {
  path: path.join(root, 'test'),
  absolute(relative) {
    return path.join(this.path, relative);
  },
};

const reader = async (filePath, sab, offset, size) => {
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.from(sab, offset, size);
    await fh.read(buf, 0, size, 0);
  } finally {
    await fh.close();
  }
};

const createCache = () => new FileCache({
  limit: 1024 * 1024,
  baseSegmentSize: 64 * 1024,
  maxFileSize: 64 * 1024,
  reader,
});

test('Integration - initial load and setFiles', async () => {
  const cache = createCache();
  const staticSource = new StaticSource('lib', mockApp);
  await staticSource.load();
  const { entries } = await cache.load('lib', staticSource.files);
  assert.ok(entries.size > 0);

  const segmentsMap = new Map();
  for (const seg of cache.pool.getSegmentsSnapshot()) {
    segmentsMap.set(seg.id, seg.sab);
  }
  const files = FileCache.project(cache.indexes.lib, segmentsMap);
  const workerStatic = new Static('lib', workerApp);
  workerStatic.setFiles(files);
  assert.strictEqual(workerStatic.files.size, entries.size);

  const file = workerStatic.get('/example/add.js');
  assert.ok(file);
  assert.ok(file.data instanceof Uint8Array);
  assert.ok(file.data.length > 0);
});

test('Integration - shared pool between placements', async () => {
  const cache = createCache();
  const staticSource = new StaticSource('lib', mockApp);
  await staticSource.load();
  await cache.load('static', staticSource.files);
  const usedAfterStatic = cache.totalUsed;

  const resFiles = new Map([
    ['/r.txt', { data: Buffer.from('res'), stat: { size: 3 }, path: '/t' }],
  ]);
  await cache.load('resources', resFiles);
  assert.ok(cache.totalUsed >= usedAfterStatic);

  const segmentsMap = new Map();
  for (const seg of cache.pool.getSegmentsSnapshot()) {
    segmentsMap.set(seg.id, seg.sab);
  }
  const sp = FileCache.project(cache.indexes.static, segmentsMap);
  const rp = FileCache.project(cache.indexes.resources, segmentsMap);
  assert.ok(!rp.has('/example/add.js'));
  assert.ok(!sp.has('/r.txt'));
});

test('Integration - updateFiles adds entries', async () => {
  const cache = createCache();
  const initial = new Map([
    ['/a.js', { data: Buffer.from('aaa'), stat: { size: 3 }, path: '/t' }],
  ]);
  await cache.load('static', initial);
  const segmentsMap = new Map();
  for (const seg of cache.pool.getSegmentsSnapshot()) {
    segmentsMap.set(seg.id, seg.sab);
  }
  const files = FileCache.project(cache.indexes.static, segmentsMap);
  const workerStatic = new Static('lib', workerApp);
  workerStatic.setFiles(files);

  const newEntry = await cache.allocate(
    'static', '/b.js',
    { data: Buffer.from('bbb'), stat: { size: 3 }, path: '/t' },
  );
  for (const seg of cache.pool.getSegmentsSnapshot()) {
    segmentsMap.set(seg.id, seg.sab);
  }
  const projected = FileCache.projectEntry(newEntry, segmentsMap);
  workerStatic.updateFiles(new Map([['/b.js', projected]]));
  assert.strictEqual(workerStatic.files.size, 2);
  assert.ok(workerStatic.get('/a.js'));
  assert.ok(workerStatic.get('/b.js'));
});

test('Integration - deleteFiles removes entries', async () => {
  const cache = createCache();
  const initial = new Map([
    ['/a.js', { data: Buffer.from('aaa'), stat: { size: 3 }, path: '/t' }],
    ['/b.js', { data: Buffer.from('bbb'), stat: { size: 3 }, path: '/t' }],
  ]);
  await cache.load('static', initial);
  const segmentsMap = new Map();
  for (const seg of cache.pool.getSegmentsSnapshot()) {
    segmentsMap.set(seg.id, seg.sab);
  }
  const files = FileCache.project(cache.indexes.static, segmentsMap);
  const workerStatic = new Static('lib', workerApp);
  workerStatic.setFiles(files);

  workerStatic.deleteFiles(['/a.js']);
  assert.strictEqual(workerStatic.files.size, 1);
  assert.strictEqual(workerStatic.get('/a.js'), undefined);
  assert.ok(workerStatic.get('/b.js'));
});

test('Integration - worker-side Static API', () => {
  const workerStatic = new Static('lib', workerApp);
  assert.strictEqual(typeof workerStatic.load, 'undefined');
  assert.strictEqual(typeof workerStatic.change, 'undefined');
  assert.strictEqual(typeof workerStatic.delete, 'undefined');
  assert.strictEqual(typeof workerStatic.get, 'function');
  assert.strictEqual(typeof workerStatic.find, 'function');
  assert.strictEqual(typeof workerStatic.serve, 'function');
  assert.strictEqual(typeof workerStatic.setFiles, 'function');
  assert.strictEqual(typeof workerStatic.updateFiles, 'function');
  assert.strictEqual(typeof workerStatic.deleteFiles, 'function');
});
