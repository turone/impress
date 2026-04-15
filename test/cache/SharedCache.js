'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { SharedCache } = require('../../lib/cache/SharedCache.js');

const createConfig = () => ({
  cache: {
    sab: { limit: 1024 * 1024, baseSegmentSize: 64 * 1024 },
    maxFileSize: 64 * 1024,
  },
  server: { timeouts: { watch: 500 } },
});

const createSharedCache = () => {
  const logs = [];
  const mockConsole = {
    info: (...args) => logs.push(args.join(' ')),
    error: (...args) => logs.push(args.join(' ')),
  };
  const sc = new SharedCache({
    config: createConfig(),
    dir: process.cwd(),
    console: mockConsole,
  });
  sc.app = { threads: new Map() };
  return { sc, logs };
};

const makeFile = (size) => ({
  data: Buffer.alloc(size, 0x41),
  stat: { size },
  path: '/tmp/test',
});

// handleAck tests

test('SharedCache handleAck - unknown updateId is no-op', async () => {
  const { sc } = createSharedCache();
  sc.handleAck(999, 1);
  assert.strictEqual(sc.pendingFrees.size, 0);
});

test('SharedCache handleAck - single worker frees entries', async () => {
  const { sc } = createSharedCache();
  const file = makeFile(100);
  const entry = await sc.cache.allocate('static', '/a.js', file);
  assert.strictEqual(entry.kind, 'shared');
  const usedBefore = sc.cache.totalUsed;

  sc.pendingFrees.set(1, {
    workerIds: new Set([10]),
    entries: [entry],
  });
  sc.handleAck(1, 10);
  assert.strictEqual(sc.pendingFrees.size, 0);
  assert.strictEqual(sc.cache.totalUsed, usedBefore);
});

test('SharedCache handleAck - partial ACK does not free', async () => {
  const { sc } = createSharedCache();
  const file = makeFile(100);
  const entry = await sc.cache.allocate('static', '/a.js', file);

  sc.pendingFrees.set(1, {
    workerIds: new Set([10, 20]),
    entries: [entry],
  });
  sc.handleAck(1, 10);
  assert.strictEqual(sc.pendingFrees.size, 1);
  const pending = sc.pendingFrees.get(1);
  assert.strictEqual(pending.workerIds.size, 1);
  assert.ok(pending.workerIds.has(20));
});

test('SharedCache handleAck - all workers ACK frees entries', async () => {
  const { sc, logs } = createSharedCache();
  const file = makeFile(100);
  const entry = await sc.cache.allocate('static', '/a.js', file);

  sc.pendingFrees.set(1, {
    workerIds: new Set([10, 20]),
    entries: [entry],
  });
  sc.handleAck(1, 10);
  assert.strictEqual(sc.pendingFrees.size, 1);
  sc.handleAck(1, 20);
  assert.strictEqual(sc.pendingFrees.size, 0);
  assert.ok(logs.some((l) => l.includes('freeEntries')));
});

test('SharedCache handleAck - multiple updates independent', async () => {
  const { sc } = createSharedCache();
  const e1 = await sc.cache.allocate('static', '/a.js', makeFile(50));
  const e2 = await sc.cache.allocate('static', '/b.js', makeFile(50));

  sc.pendingFrees.set(1, {
    workerIds: new Set([10]),
    entries: [e1],
  });
  sc.pendingFrees.set(2, {
    workerIds: new Set([10]),
    entries: [e2],
  });

  sc.handleAck(1, 10);
  assert.strictEqual(sc.pendingFrees.size, 1);
  assert.ok(sc.pendingFrees.has(2));

  sc.handleAck(2, 10);
  assert.strictEqual(sc.pendingFrees.size, 0);
});

// handleWorkerExit tests

test('SharedCache handleWorkerExit - removes worker from all pending', async () => {
  const { sc } = createSharedCache();
  const e1 = await sc.cache.allocate('static', '/a.js', makeFile(50));
  const e2 = await sc.cache.allocate('static', '/b.js', makeFile(50));

  sc.pendingFrees.set(1, {
    workerIds: new Set([10, 20]),
    entries: [e1],
  });
  sc.pendingFrees.set(2, {
    workerIds: new Set([10, 20]),
    entries: [e2],
  });

  sc.handleWorkerExit(10);
  assert.strictEqual(sc.pendingFrees.size, 2);
  for (const [, pending] of sc.pendingFrees) {
    assert.strictEqual(pending.workerIds.size, 1);
    assert.ok(pending.workerIds.has(20));
  }
});

test('SharedCache handleWorkerExit - last worker frees all', async () => {
  const { sc, logs } = createSharedCache();
  const e1 = await sc.cache.allocate('static', '/a.js', makeFile(50));
  const e2 = await sc.cache.allocate('static', '/b.js', makeFile(50));

  sc.pendingFrees.set(1, {
    workerIds: new Set([10]),
    entries: [e1],
  });
  sc.pendingFrees.set(2, {
    workerIds: new Set([10]),
    entries: [e2],
  });

  sc.handleWorkerExit(10);
  assert.strictEqual(sc.pendingFrees.size, 0);
  const freeCount = logs.filter((l) => l.includes('freeEntries')).length;
  assert.strictEqual(freeCount, 2);
});

test('SharedCache handleWorkerExit - unknown worker is no-op', async () => {
  const { sc } = createSharedCache();
  sc.pendingFrees.set(1, {
    workerIds: new Set([10]),
    entries: [],
  });
  sc.handleWorkerExit(999);
  assert.strictEqual(sc.pendingFrees.size, 1);
  assert.strictEqual(sc.pendingFrees.get(1).workerIds.size, 1);
});

test('SharedCache handleWorkerExit - no pending is no-op', async () => {
  const { sc } = createSharedCache();
  sc.handleWorkerExit(10);
  assert.strictEqual(sc.pendingFrees.size, 0);
});

// snapshot tests

test('SharedCache snapshot - returns serializable data', async () => {
  const { sc } = createSharedCache();
  await sc.cache.allocate('static', '/a.js', makeFile(100));
  const snap = sc.snapshot();
  assert.ok(snap.segments);
  assert.ok(snap.indexes);
  assert.ok(snap.indexes.static);
});

test('SharedCache snapshot - empty cache', () => {
  const { sc } = createSharedCache();
  const snap = sc.snapshot();
  assert.ok(snap.segments);
  assert.deepStrictEqual(snap.indexes, {});
});

// handleAck triggers compact broadcast

test('SharedCache handleAck - compact after free broadcasts', async () => {
  const { sc } = createSharedCache();
  const messages = [];
  sc.app = {
    threads: new Map([
      [1, { postMessage: (m) => messages.push(m) }],
    ]),
  };

  // Fill two segments, then free most of one to trigger compact
  const segSize = sc.cache.baseSegmentSize;
  const fileSize = Math.floor(segSize / 4);

  // Segment 1: 4 files fill it
  const entries1 = [];
  for (let i = 0; i < 4; i++) {
    entries1.push(
      await sc.cache.allocate('static', `/s1-${i}.js`, makeFile(fileSize)),
    );
  }
  // Segment 2: 1 small file (low utilization after seg1 free)
  const e2 = await sc.cache.allocate('static', '/s2-0.js', makeFile(100));
  assert.ok(e2.kind === 'shared');

  // Remove entries from index so they become "old"
  for (let i = 0; i < 3; i++) {
    sc.cache.remove('static', `/s1-${i}.js`);
  }

  // Put old entries in pendingFrees
  sc.pendingFrees.set(1, {
    workerIds: new Set([1]),
    entries: entries1.slice(0, 3),
  });

  sc.handleAck(1, 1);
  assert.strictEqual(sc.pendingFrees.size, 0);
});

// Mixed entry types (disk entries are no-op for free)

test('SharedCache handleAck - disk entry free is no-op', async () => {
  const { sc } = createSharedCache();
  const diskEntry = { kind: 'disk', path: '/tmp/big.bin', stat: { size: 999 } };
  sc.pendingFrees.set(1, {
    workerIds: new Set([10]),
    entries: [diskEntry],
  });
  sc.handleAck(1, 10);
  assert.strictEqual(sc.pendingFrees.size, 0);
});

// constructor tests

test('SharedCache constructor - defaults', () => {
  const { sc } = createSharedCache();
  assert.ok(sc.cache);
  assert.ok(sc.placements);
  assert.strictEqual(sc.placements.length, 2);
  assert.strictEqual(sc.placements[0].name, 'static');
  assert.strictEqual(sc.placements[1].name, 'resources');
  assert.ok(sc.pendingFrees instanceof Map);
  assert.strictEqual(sc.nextUpdateId, 0);
});

test('SharedCache constructor - custom placements', () => {
  const config = createConfig();
  config.cache.placements = [{ name: 'assets' }, { name: 'data', ext: ['.json'] }];
  const sc = new SharedCache({ config, dir: process.cwd(), console });
  assert.strictEqual(sc.placements.length, 2);
  assert.strictEqual(sc.placements[0].name, 'assets');
  assert.strictEqual(sc.placements[1].name, 'data');
});
