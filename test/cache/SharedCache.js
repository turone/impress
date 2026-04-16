'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const { promises: fsp } = require('node:fs');
const { SharedCache } = require('../../lib/cache/SharedCache.js');
const { metarhia } = require('../../lib/deps.js');

const createConfig = () => ({
  cache: {
    sab: { limit: 1024 * 1024, baseSegmentSize: 64 * 1024 },
    maxFileSize: 64 * 1024,
  },
  server: { timeouts: { watch: 500 } },
});

const createSharedCache = (options = {}) => {
  const logs = [];
  const mockConsole = options.console || {
    info: (...args) => logs.push(args.join(' ')),
    error: (...args) => logs.push(args.join(' ')),
  };
  const sc = new SharedCache({
    config: options.config || createConfig(),
    dir: options.dir || process.cwd(),
    console: mockConsole,
  });
  sc.app = { threads: new Map() };
  return { sc, logs };
};

class FakeWatcher {
  constructor() {
    this.handlers = {};
  }

  on(name, handler) {
    this.handlers[name] = handler;
  }

  watch() {}
}

const withFakeWatcher = async (fn) => {
  const DirectoryWatcher = metarhia.metawatch.DirectoryWatcher;
  metarhia.metawatch.DirectoryWatcher = FakeWatcher;
  try {
    return await fn();
  } finally {
    metarhia.metawatch.DirectoryWatcher = DirectoryWatcher;
  }
};

const flushAsync = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

const waitFor = async (predicate) => {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
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

test('SharedCache compact - tracks old entries once for multi-placement batch', async () => {
  const { sc } = createSharedCache();
  const messages = [];
  sc.app = {
    threads: new Map([
      [1, { postMessage: (msg) => messages.push(msg) }],
    ]),
  };
  sc.nextUpdateId = 10;

  const large = 30000;
  const small = 100;

  const oldStatic = await sc.cache.allocate('static', '/a.js', makeFile(large));
  const oldResources = await sc.cache.allocate(
    'resources',
    '/b.js',
    makeFile(large),
  );
  await sc.cache.allocate('static', '/small-a.js', makeFile(small));
  await sc.cache.allocate('resources', '/small-b.js', makeFile(small));
  await sc.cache.allocate('static', '/tail.js', makeFile(10000));

  sc.cache.remove('static', '/a.js');
  sc.cache.remove('resources', '/b.js');
  sc.pendingFrees.set(1, {
    workerIds: new Set([1]),
    entries: [oldStatic, oldResources],
  });

  sc.handleAck(1, 1);

  const updates = messages.filter((msg) => msg.name === 'file-update');
  assert.strictEqual(updates.length, 2);
  assert.deepStrictEqual(
    updates.map((msg) => msg.target).sort(),
    ['resources', 'static'],
  );

  const updateIds = updates.map((msg) => msg.updateId).sort((a, b) => a - b);
  assert.deepStrictEqual([...sc.pendingFrees.keys()], [updateIds[1]]);

  sc.handleAck(updateIds[0], 1);
  assert.deepStrictEqual([...sc.pendingFrees.keys()], [updateIds[1]]);

  sc.handleAck(updateIds[1], 1);
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

test('SharedCache initialize - empty placements create no segments', async () => {
  await withFakeWatcher(async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'impress-cache-empty-'));
    try {
      const { sc } = createSharedCache({ dir });
      await sc.initialize();

      const snapshot = sc.snapshot();
      assert.strictEqual(snapshot.segments.length, 0);
      assert.deepStrictEqual(Object.keys(snapshot.indexes).sort(), ['resources', 'static']);
      assert.deepStrictEqual(snapshot.indexes.static.entries, []);
      assert.deepStrictEqual(snapshot.indexes.resources.entries, []);

      const staticDir = await fsp.stat(path.join(dir, 'static'));
      const resourcesDir = await fsp.stat(path.join(dir, 'resources'));
      assert.ok(staticDir.isDirectory());
      assert.ok(resourcesDir.isDirectory());
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

test('SharedCache watch - routes overlapping placement names by path segment', async () => {
  await withFakeWatcher(async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'impress-cache-route-'));
    try {
      const config = createConfig();
      config.cache.placements = [{ name: 'static' }, { name: 'static2' }];
      const { sc } = createSharedCache({ config, dir });
      await sc.initialize();

      sc.watch({
        threads: new Map([
          [1, { postMessage() {} }],
        ]),
      });

      const filePath = path.join(dir, 'static2', 'a.txt');
      const key = '/a.txt';
      await fsp.writeFile(filePath, 'abc');

      sc.watcher.handlers.before();
      sc.watcher.handlers.change(filePath);
      sc.watcher.handlers.after();
      await flushAsync();
      const routed = await waitFor(() => sc.cache.indexes.static2.entries.has(key));

      assert.ok(routed);
      assert.ok(sc.cache.indexes.static2.entries.has(key));
      assert.ok(!sc.cache.indexes.static.entries.has(key));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
