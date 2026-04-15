'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { FileCache } = require('../../lib/cache/FileCache.js');

// Pool tests

test('FileCache pool - createBaseSegment', () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 256,
  });
  const seg = cache.pool.createBaseSegment();
  assert.ok(seg);
  assert.strictEqual(seg.size, 256);
  assert.ok(seg.sab instanceof SharedArrayBuffer);
  assert.strictEqual(cache.totalUsed, 256);
});

test('FileCache pool - budget enforcement', () => {
  const cache = new FileCache({
    limit: 300,
    baseSegmentSize: 256,
    maxFileSize: 256,
  });
  const seg1 = cache.pool.createBaseSegment();
  assert.ok(seg1);
  const seg2 = cache.pool.createBaseSegment();
  assert.strictEqual(seg2, null);
  assert.strictEqual(cache.totalUsed, 256);
});

test('FileCache pool - getSegmentsSnapshot', () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 256,
  });
  cache.pool.createBaseSegment();
  cache.pool.createBaseSegment();
  const snap = cache.pool.getSegmentsSnapshot();
  assert.strictEqual(snap.length, 2);
  assert.ok(snap[0].sab instanceof SharedArrayBuffer);
  assert.ok(snap[1].sab instanceof SharedArrayBuffer);
});

// Registry tests

test('FileCache registry - allocate from tail', () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 256,
  });
  const result = cache.registry.allocate(10);
  assert.ok(result);
  assert.strictEqual(result.offset, 0);
  assert.strictEqual(cache.totalUsed, 256);
  const result2 = cache.registry.allocate(20);
  assert.strictEqual(result2.segmentId, result.segmentId);
  assert.strictEqual(result2.offset, 10);
});

test('FileCache registry - allocate new segment when full', () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 32,
    maxFileSize: 32,
  });
  const r1 = cache.registry.allocate(32);
  assert.ok(r1);
  const r2 = cache.registry.allocate(10);
  assert.ok(r2);
  assert.notStrictEqual(r1.segmentId, r2.segmentId);
});

test('FileCache registry - allocate returns null on budget exhaustion', () => {
  const cache = new FileCache({
    limit: 32,
    baseSegmentSize: 32,
    maxFileSize: 32,
  });
  cache.registry.allocate(32);
  const result = cache.registry.allocate(1);
  assert.strictEqual(result, null);
});

test('FileCache registry - free and reuse extent', () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 256,
  });
  const r1 = cache.registry.allocate(10);
  cache.registry.allocate(20);
  cache.registry.free(r1.segmentId, r1.offset, 10);
  const r3 = cache.registry.allocate(10);
  assert.strictEqual(r3.offset, r1.offset);
});

test('FileCache registry - merge adjacent extents', () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 256,
  });
  const r1 = cache.registry.allocate(10);
  const r2 = cache.registry.allocate(10);
  cache.registry.allocate(10);
  cache.registry.free(r1.segmentId, r1.offset, 10);
  cache.registry.free(r2.segmentId, r2.offset, 10);
  const extents = cache.registry.freeExtents.get(r1.segmentId);
  assert.strictEqual(extents.length, 1);
  assert.strictEqual(extents[0].length, 20);
});

// FileCache.load tests

test('FileCache load - small files into shared memory', async () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 1000,
  });
  const files = new Map([
    ['/a.js', { data: Buffer.from('aaa'), stat: { size: 3 }, path: '/t' }],
    ['/b.js', { data: Buffer.from('bbb'), stat: { size: 3 }, path: '/t' }],
  ]);
  const { entries, segmentIds } = await cache.load('static', files);
  assert.strictEqual(entries.size, 2);
  assert.ok(segmentIds.size > 0);
  const a = entries.get('/a.js');
  assert.strictEqual(a.kind, 'shared');
  assert.strictEqual(a.length, 3);
});

test('FileCache load - large files become disk entries', async () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 5,
  });
  const files = new Map([
    [
      '/big.bin',
      {
        data: Buffer.alloc(10),
        stat: { size: 10 },
        path: '/disk/big.bin',
      },
    ],
  ]);
  const { entries } = await cache.load('static', files);
  const entry = entries.get('/big.bin');
  assert.strictEqual(entry.kind, 'disk');
  assert.strictEqual(entry.path, '/disk/big.bin');
  assert.strictEqual(entry.data, null);
});

test('FileCache - baseSegmentSize enforced >= maxFileSize', async () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 32,
    maxFileSize: 200,
  });
  // ceil(200 / 32) * 32 = 224
  assert.strictEqual(cache.baseSegmentSize, 224);
  const data = Buffer.alloc(64, 'x');
  const files = new Map([
    ['/big.js', { data, stat: { size: 64 }, path: '/t' }],
  ]);
  const { entries } = await cache.load('static', files);
  const entry = entries.get('/big.js');
  assert.strictEqual(entry.kind, 'shared');
  const seg = cache.getSegment(entry.segmentId);
  assert.strictEqual(seg.size, 224);
});

test('FileCache load - budget overflow falls back to disk', async () => {
  const cache = new FileCache({
    limit: 32,
    baseSegmentSize: 32,
    maxFileSize: 32,
  });
  const files = new Map([
    ['/a.js', { data: Buffer.alloc(32), stat: { size: 32 }, path: '/t' }],
    ['/b.js', { data: Buffer.alloc(10), stat: { size: 10 }, path: '/t/b' }],
  ]);
  const { entries } = await cache.load('static', files);
  const a = entries.get('/a.js');
  const b = entries.get('/b.js');
  assert.strictEqual(a.kind, 'shared');
  assert.strictEqual(b.kind, 'disk');
});

test('FileCache load-null data without reader falls back to disk', async () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 1000,
  });
  const files = new Map([['/a.js', { stat: { size: 10 }, path: '/tmp/a.js' }]]);
  const { entries } = await cache.load('static', files);
  const entry = entries.get('/a.js');
  assert.strictEqual(entry.kind, 'disk');
});

test('FileCache load - null data with reader reads into SAB', async () => {
  const reader = async (filePath, sab, offset, size) => {
    const view = new Uint8Array(sab, offset, size);
    for (let i = 0; i < size; i++) view[i] = 42;
  };
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 1000,
    reader,
  });
  const files = new Map([['/a.js', { stat: { size: 5 }, path: '/tmp/a.js' }]]);
  const { entries } = await cache.load('static', files);
  const entry = entries.get('/a.js');
  assert.strictEqual(entry.kind, 'shared');
  const seg = cache.getSegment(entry.segmentId);
  const view = new Uint8Array(seg.sab, entry.offset, entry.length);
  assert.strictEqual(view[0], 42);
  assert.strictEqual(view[4], 42);
});

// FileCache.allocate tests

test('FileCache allocate - single file', async () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 1000,
  });
  const entry = await cache.allocate('static', '/a.js', {
    data: Buffer.from('hello'),
    stat: { size: 5 },
    path: '/t',
  });
  assert.strictEqual(entry.kind, 'shared');
  assert.strictEqual(entry.length, 5);
  assert.ok(cache.indexes.static);
  assert.strictEqual(cache.indexes.static.entries.size, 1);
});

test('FileCache allocate - creates index on demand', async () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 1000,
  });
  assert.strictEqual(cache.indexes.custom, undefined);
  await cache.allocate('custom', '/x.txt', {
    data: Buffer.from('x'),
    stat: { size: 1 },
    path: '/t',
  });
  assert.ok(cache.indexes.custom);
  assert.strictEqual(cache.indexes.custom.entries.size, 1);
});

// FileCache.remove tests

test('FileCache remove - returns old entry', async () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 1000,
  });
  await cache.allocate('static', '/a.js', {
    data: Buffer.from('aaa'),
    stat: { size: 3 },
    path: '/t',
  });
  const old = cache.remove('static', '/a.js');
  assert.ok(old);
  assert.strictEqual(old.kind, 'shared');
  assert.strictEqual(cache.indexes.static.entries.size, 0);
});

test('FileCache remove - returns null for missing', () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 256,
  });
  assert.strictEqual(cache.remove('static', '/nope'), null);
  assert.strictEqual(cache.remove('missing', '/nope'), null);
});

// FileCache.free tests

test('FileCache free - no-op for disk entry', () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 256,
  });
  cache.free({ kind: 'disk', path: '/t', stat: { size: 1 } });
  cache.free(null);
  assert.strictEqual(cache.totalUsed, 0);
});

// FileCache.snapshot tests

test('FileCache snapshot - serializable format', async () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 1000,
  });
  await cache.load(
    'static',
    new Map([
      ['/a.js', { data: Buffer.from('a'), stat: { size: 1 }, path: '/t' }],
    ]),
  );
  await cache.load(
    'resources',
    new Map([
      ['/r.txt', { data: Buffer.from('r'), stat: { size: 1 }, path: '/t' }],
    ]),
  );
  const snap = cache.snapshot();
  assert.ok(Array.isArray(snap.segments));
  assert.ok(snap.indexes.static);
  assert.ok(snap.indexes.resources);
  assert.ok(Array.isArray(snap.indexes.static.entries));
  assert.ok(Array.isArray(snap.indexes.resources.entries));
});

// FileCache.project tests

test('FileCache project - shared entry produces Uint8Array', async () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 1000,
  });
  const content = 'hello projection';
  const data = Buffer.from(content);
  await cache.load(
    'static',
    new Map([['/a.js', { data, stat: { size: data.length }, path: '/t' }]]),
  );
  const segmentsMap = new Map();
  for (const seg of cache.pool.getSegmentsSnapshot()) {
    segmentsMap.set(seg.id, seg.sab);
  }
  const projected = FileCache.project(cache.indexes.static, segmentsMap);
  assert.strictEqual(projected.size, 1);
  const file = projected.get('/a.js');
  assert.ok(file.data instanceof Uint8Array);
  const text = Buffer.from(file.data).toString();
  assert.strictEqual(text, content);
});

test('FileCache project - disk entry produces null data', async () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 5,
  });
  await cache.load(
    'static',
    new Map([
      [
        '/big.bin',
        {
          data: Buffer.alloc(10),
          stat: { size: 10 },
          path: '/disk/big.bin',
        },
      ],
    ]),
  );
  const segmentsMap = new Map();
  const projected = FileCache.project(cache.indexes.static, segmentsMap);
  const file = projected.get('/big.bin');
  assert.strictEqual(file.data, null);
  assert.strictEqual(file.path, '/disk/big.bin');
});

test('FileCache projectEntry - shared entry', async () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 1000,
  });
  await cache.allocate('static', '/x.js', {
    data: Buffer.from('test'),
    stat: { size: 4 },
    path: '/t',
  });
  const segmentsMap = new Map();
  for (const seg of cache.pool.getSegmentsSnapshot()) {
    segmentsMap.set(seg.id, seg.sab);
  }
  const entry = cache.indexes.static.entries.get('/x.js');
  const projected = FileCache.projectEntry(entry, segmentsMap);
  assert.ok(projected.data instanceof Uint8Array);
  assert.strictEqual(Buffer.from(projected.data).toString(), 'test');
});

test('FileCache projectEntry - disk entry', () => {
  const entry = { kind: 'disk', path: '/f.bin', stat: { size: 99 } };
  const projected = FileCache.projectEntry(entry, new Map());
  assert.strictEqual(projected.data, null);
  assert.strictEqual(projected.path, '/f.bin');
});

// Separate namespaces

test('FileCache - separate placements do not interfere', async () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 1000,
  });
  await cache.load(
    'static',
    new Map([
      ['/s.js', { data: Buffer.from('s'), stat: { size: 1 }, path: '/t' }],
    ]),
  );
  await cache.load(
    'resources',
    new Map([
      ['/r.txt', { data: Buffer.from('r'), stat: { size: 1 }, path: '/t' }],
    ]),
  );
  assert.ok(cache.indexes.static.entries.has('/s.js'));
  assert.ok(!cache.indexes.static.entries.has('/r.txt'));
  assert.ok(cache.indexes.resources.entries.has('/r.txt'));
  assert.ok(!cache.indexes.resources.entries.has('/s.js'));
});

// Data integrity

test('FileCache - data integrity after write', async () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 1000,
  });
  const content = 'hello world 12345';
  const data = Buffer.from(content);
  await cache.load(
    'static',
    new Map([['/a.js', { data, stat: { size: data.length }, path: '/t' }]]),
  );
  const entry = cache.indexes.static.entries.get('/a.js');
  const seg = cache.getSegment(entry.segmentId);
  const view = new Uint8Array(seg.sab, entry.offset, entry.length);
  assert.strictEqual(Buffer.from(view).toString(), content);
});

// Registry helper methods

test('FileCache registry - segmentUsed tracks allocations', async () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 1000,
  });
  await cache.allocate('s', '/a', {
    data: Buffer.from('aaa'),
    stat: { size: 3 },
    path: '/t',
  });
  const segId = cache.indexes.s.entries.get('/a').segmentId;
  assert.strictEqual(cache.registry.segmentUsed(segId), 3);
  await cache.allocate('s', '/b', {
    data: Buffer.from('bb'),
    stat: { size: 2 },
    path: '/t',
  });
  assert.strictEqual(cache.registry.segmentUsed(segId), 5);
});

// Recycling empty base segments

test('FileCache free - recycles empty base segment', async () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 256,
  });
  const e1 = await cache.allocate('s', '/a', {
    data: Buffer.from('aaa'),
    stat: { size: 3 },
    path: '/t',
  });
  const segId = e1.segmentId;
  assert.ok(cache.pool.getSegment(segId));
  cache.free(e1);
  // Slab retention: segment stays, marked clean
  assert.ok(cache.pool.getSegment(segId));
  assert.ok(cache.pool.cleanSegmentIds.has(segId));
  assert.strictEqual(cache.totalUsed, 256);
});

test('FileCache pool - retireSegment and reuse clean segment', async () => {
  const cache = new FileCache({
    limit: 512,
    baseSegmentSize: 256,
    maxFileSize: 256,
  });
  const e1 = await cache.allocate('s', '/a', {
    data: Buffer.from('aaa'),
    stat: { size: 3 },
    path: '/t',
  });
  const segId = e1.segmentId;
  const segSab = cache.pool.getSegment(segId).sab;
  cache.free(e1);
  assert.ok(cache.pool.cleanSegmentIds.has(segId));
  // Allocate new file — reuses the clean segment
  const e2 = await cache.allocate('s', '/b', {
    data: Buffer.from('bbb'),
    stat: { size: 3 },
    path: '/t',
  });
  assert.strictEqual(e2.segmentId, segId);
  assert.strictEqual(cache.pool.getSegment(segId).sab, segSab);
  assert.ok(!cache.pool.cleanSegmentIds.has(segId));
  assert.strictEqual(cache.totalUsed, 256);
});

test('FileCache free - keeps segment with remaining files', async () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 256,
  });
  const e1 = await cache.allocate('s', '/a', {
    data: Buffer.from('aaa'),
    stat: { size: 3 },
    path: '/t',
  });
  await cache.allocate('s', '/b', {
    data: Buffer.from('bb'),
    stat: { size: 2 },
    path: '/t',
  });
  const segId = e1.segmentId;
  cache.free(e1);
  assert.ok(cache.pool.getSegment(segId));
  assert.strictEqual(cache.totalUsed, 256);
});

// Compaction

test('FileCache compact-moves files from low-utilization segment', async () => {
  const cache = new FileCache({
    limit: 2048,
    baseSegmentSize: 256,
    maxFileSize: 256,
  });
  // Fill segment 1: two 128-byte files
  const eFill1 = await cache.allocate('s', '/f1', {
    data: Buffer.alloc(128, 'a'),
    stat: { size: 128 },
    path: '/t',
  });
  await cache.allocate('s', '/f2', {
    data: Buffer.alloc(128, 'b'),
    stat: { size: 128 },
    path: '/t',
  });
  const segA = eFill1.segmentId;
  // Segment 2: small file + filler
  const e1 = await cache.allocate('s', '/a', {
    data: Buffer.from('aaaa'),
    stat: { size: 4 },
    path: '/t',
  });
  const eFiller = await cache.allocate('s', '/x', {
    data: Buffer.alloc(200, 'x'),
    stat: { size: 200 },
    path: '/t',
  });
  const segB = e1.segmentId;
  assert.notStrictEqual(segA, segB);
  // Remove + free filler from seg2 → 1.5% util
  cache.remove('s', '/x');
  cache.free(eFiller);
  // Remove + free half of seg1 → 50% util (target space)
  cache.remove('s', '/f1');
  cache.free(eFill1);
  const result = cache.compact(0.3);
  assert.ok(result);
  assert.ok(result.updates.length > 0);
  // After compact: target segment still in pool (not freed/retired yet)
  assert.ok(cache.pool.getSegment(segB));
  // Simulate post-ACK free of old entries → retires the target segment
  for (const entry of result.oldEntries) cache.free(entry);
  assert.ok(cache.pool.cleanSegmentIds.has(segB));
  const newEntry = cache.indexes.s.entries.get('/a');
  assert.notStrictEqual(newEntry.segmentId, segB);
  const seg = cache.pool.getSegment(newEntry.segmentId);
  const view = new Uint8Array(seg.sab, newEntry.offset, newEntry.length);
  assert.strictEqual(Buffer.from(view).toString(), 'aaaa');
});

test('FileCache compact-returns null when all segments above threshold',
  async () => {
  const cache = new FileCache({
    limit: 4096,
    baseSegmentSize: 256,
    maxFileSize: 1000,
  });
  await cache.allocate('s', '/a', {
    data: Buffer.alloc(200, 'x'),
    stat: { size: 200 },
    path: '/t',
  });
  // 200/256 = 78% utilization > 30% threshold
  const result = cache.compact(0.3);
  assert.strictEqual(result, null);
});

test('FileCache compact - rollback preserves state on allocation failure',
  async () => {
  const cache = new FileCache({
    limit: 512,
    baseSegmentSize: 256,
    maxFileSize: 256,
  });
  // Segment 1: fill completely
  await cache.allocate('s', '/big', {
    data: Buffer.alloc(256, 'b'),
    stat: { size: 256 },
    path: '/t',
  });
  // Segment 2: small file + filler
  const eSmall = await cache.allocate('s', '/small', {
    data: Buffer.from('ss'),
    stat: { size: 2 },
    path: '/t',
  });
  const eFill = await cache.allocate('s', '/fill', {
    data: Buffer.alloc(200, 'f'),
    stat: { size: 200 },
    path: '/t',
  });
  const segLow = eSmall.segmentId;
  // Remove filler → seg2 ~0.8% util (below threshold)
  cache.remove('s', '/fill');
  cache.free(eFill);
  // No free space in seg1, no budget for new segment → compact must fail
  const usedBefore = cache.totalUsed;
  const result = cache.compact(0.3);
  assert.strictEqual(result, null);
  // Target segment still exists and is usable
  assert.ok(cache.pool.getSegment(segLow));
  assert.strictEqual(cache.totalUsed, usedBefore);
  // Entry preserved
  const entry = cache.indexes.s.entries.get('/small');
  assert.strictEqual(entry.segmentId, segLow);
});
