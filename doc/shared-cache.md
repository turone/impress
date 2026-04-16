# SharedArrayBuffer Cache in Impress

## Motivation

Impress uses `worker_threads` to handle HTTP requests. Each worker serves static files (HTML, CSS, JS, images, etc.). Without shared memory, every worker keeps its own copy of every file — with 8 workers and 100 MiB of static assets, total consumption reaches 800 MiB. SharedArrayBuffer stores all files in a single memory region accessible to all threads.

## Architecture

The system is split into three modules:

| Module | Location | Purpose |
|--------|----------|---------|
| **FileCache** | `lib/cache/FileCache.js` | Pure allocator: SAB segment management, memory allocation, entry projection |
| **SharedCache** | `lib/cache/SharedCache.js` | Orchestration: configuration, watcher, ACK tracking, compaction |
| **StaticSource** | `lib/cache/StaticSource.js` | Filesystem scanner, returns `{ stat, path }` per file |

FileCache has no dependencies on Node.js built-ins or Impress internals. This allows it to be used in a browser or in tests without mocks.

## Slab Allocator

The memory management model follows the Linux SLUB allocator principle: SharedArrayBuffer segments are **never returned to the OS**. Instead, they go through a lifecycle:

```
┌──────────┐     files deleted     ┌──────────┐     memory needed    ┌──────────┐
│  Active  │ ──────────────────►   │  Clean   │ ──────────────────►  │  Active  │
│  (data)  │                       │  (empty) │                      │  (data)  │
└──────────┘                       └──────────┘                       └──────────┘
```

**Why SABs are never freed:** V8 cannot reduce reserved virtual memory after a SharedArrayBuffer is deallocated. Recreating a SAB of the same size still allocates a new page. Retaining empty segments (`cleanSegmentIds`) and reusing them completely eliminates allocation system calls.

## Internal classes in FileCache.js

### Pool

Manages the memory budget and the set of SAB segments.

```
Pool
├── segments: Map<id, { id, sab, size }>   — all segments
├── cleanSegmentIds: Set<id>                — empty, ready for reuse
├── limit: number                           — total budget (default 1 GiB)
├── baseSegmentSize: number                 — segment size (default 64 MiB)
├── totalUsed: number                       — total size of all SABs
│
├── createBaseSegment()  — takes a clean segment or creates a new SAB
├── retireSegment(id)    — marks an empty segment as clean
└── getSegment(id)       — access by ID
```

Key detail: `baseSegmentSize = Math.ceil(maxFileSize / configured) * configured`. The segment size is rounded up to the nearest multiple of the configured value that can fit `maxFileSize`. For example, with `configured = 64 MiB` and `maxFileSize = 100 MiB`, the segment size becomes `128 MiB` (2 × 64). When `maxFileSize` is smaller than `configured` (the typical case, e.g. `10 MB` and `64 MiB`), the segment size stays at `configured`. The `limit` must be evenly divisible by the effective segment size — otherwise the remainder is wasted. There are no dedicated segments — a single segment type serves all files.

### Registry

Extent-based allocator within base segments. Each segment is tracked via:

- **`tails: Map<segmentId, offset>`** — boundary of written data (high water mark)
- **`freeExtents: Map<segmentId, Array<{ offset, length }>>`** — freed regions

`allocate(size, noCreate=false)` algorithm:

```
1. Best-fit search across free extents of all segments
   → found a match → return { segmentId, offset }
   → exact size match → remove the extent
   → larger than needed → shrink the extent

2. Tail-append: find a segment where tail + size ≤ baseSegmentSize
   → found → advance tail, return

3. New segment (if !noCreate):
   → pool.createBaseSegment() → registerSegment → tail = size
   → budget exhausted → return null (file becomes a disk entry)
```

With `noCreate=true` (used by compact), step 3 is skipped — data is only moved into existing segments.

`free()` inserts an extent into a sorted list and merges adjacent ones:

```
[100..200] + [200..300] → [100..300]   // merge right
[0..100]   + [100..300] → [0..300]     // merge left
```

## Entry types

Each cached file is represented by one of two types:

**Shared entry** — file in SAB:
```js
{ kind: 'shared', segmentId, offset, length, stat }
```

**Disk entry** — file on disk (size > maxFileSize, or budget exhausted):
```js
{ kind: 'disk', path, stat, data: null }
```

## File loading

### Initial load (main thread)

```
SharedCache.initialize()
  → for each placement:
      source.load()           // StaticSource scans the directory
      cache.load(name, files) // FileCache distributes files across segments
```

If shared cache initialization fails (configuration, filesystem, or reader error), application startup is aborted — there is no fallback to per-worker static loading in this branch. Empty placements are valid: initialization succeeds with an empty index and zero allocated segments.

`load()` sorts files by descending size — large files are placed first, reducing fragmentation. For each file, `#allocateEntry()` is called:

1. `size > maxFileSize` → disk entry
2. No data and no reader → disk entry
3. `size === 0` → shared entry with `segmentId=0, offset=0, length=0`
4. `registry.allocate(size)` → obtains `{ segmentId, offset }` — free space in a segment
5. `reader(path, sab, offset, size)` → reads the file from disk directly into SAB, bypassing the heap; if `data` is already in memory — copies via `Uint8Array.set(data)`

The reader is injected when SharedCache is created — it is `async (path, sab, offset, size) => void`. In Node.js it is implemented via `fh.read(Buffer.from(sab, offset, size))` — a Buffer view is created over the SharedArrayBuffer region, and `fs` writes data directly there.

### Delivery to workers

```
workerData.sharedCache = cache.snapshot()
  → { segments: [{ id, sab }], indexes: { placement: { entries: [...] } } }
```

SharedArrayBuffer is passed via `workerData` — V8 transfers only a reference, no data copying occurs.

## Worker-side projection

The worker builds `segmentsMap` from the snapshot and projects entries via `FileCache.project()`:

```js
// worker.js — module scope
const segmentsMap = new Map();
for (const { id, sab } of sharedCache.segments) {
  segmentsMap.set(id, sab);
}
```

Each shared entry is projected into an object with an eager Buffer view:

```js
{
  data: Buffer.from(segmentsMap.get(segmentId), offset, length),
  stat
}
```

`Buffer.from(sab, offset, length)` creates a lightweight view (~64 bytes descriptor) over the SAB region — no data copy. The view is created once at projection time. Since segments are never freed (slab retention), SAB references in `segmentsMap` live for the entire process lifetime. When a file is removed via `deleteFiles`, the projected object loses its last reference and is GC'd along with the Buffer view. Stale data in the segment is overwritten upon reuse.

Disk entries are projected as `{ data: null, stat, path }` — unchanged.

## Hot-reload: epoch-based delta updates

metawatch debounces filesystem events, collecting them into a batch during a quiet period. SharedCache uses **epoch coalescing** on top of this: all changes and deletions in a single metawatch batch are collected into one epoch, then flushed as minimal broadcasts.

Routing from a filesystem event to a placement is done by the first path segment relative to application root, not by absolute-path prefix matching. This avoids collisions such as `static` vs `static2`.

```
metawatch                        SharedCache
    │                                │
    ├── debounce fs.watch events     │
    ├── 'before' ──────────────────► epoch = { updates, deletes, oldEntries }
    ├── 'change' file1 ───────────►  push processChange() promise
    ├── 'change' file2 ───────────►  push processChange() promise
    ├── 'delete' file3 ───────────►  processDelete() (sync)
    ├── 'after' ───────────────────► Promise.all → flushEpoch()
    │                                │
    │                         flushEpoch:
    │                           1 file-update per placement (all entries)
    │                           1 file-delete per placement (all keys)
    │                           1 trackUpdate (last updateId, all old entries)
```

1000 file changes → 1 broadcast with 1000 entries → N workers receive 1 message → N ACKs → 1 free cycle.

### Epoch flush

`#flushEpoch` sends at most `2 × placements` messages (one `file-update` and one `file-delete` per placement). All old entries are tracked against the **last** `updateId`. Since `worker_threads` guarantees FIFO message ordering, an ACK for the last message implies all prior messages have been processed.

### ACK protocol

Old entries are not freed immediately — a worker may be reading data at the moment of an update. Protocol:

```
Main thread                          Workers
    │                                    │
    ├── file-update (updateId=5) ─────►  │
    ├── file-delete (updateId=6) ─────►  │
    │                                    ├── apply update, ack 5
    │   ◄──────────────────── ack 5 (ignored, not tracked)
    │                                    ├── apply delete, ack 6
    │   ◄──────────────────── ack 6 ─────┤
    │   ... all workers acked 6 ...       │
    ├── free(all oldEntries)             │
    ├── tryCompact()                     │
    └────────────────────────────────────┘
```

If a worker crashes, the `worker.exit` event triggers `sharedCache.handleWorkerExit(id)`, which immediately removes the worker from all pending ACK sets. If it was the last expected worker, `free` is called right away. The new worker is restarted and receives a fresh `snapshot()`.

There is no timeout-based forced free — a live worker will always eventually process its message queue and send an ACK. Forced free of a slow-but-alive worker would risk data corruption: the freed extent could be reused by another file while the worker's Buffer view still points to it.

## Compaction

After entries are freed, `compact(threshold=0.3)` is called:

1. Finds the base segment with the lowest utilization below `threshold`
2. Requires at least 2 base segments (a single segment has nowhere to compact to)
3. Attempts to move all files from the target segment into others (via `allocate(size, noCreate=true)`)
4. On success — updates indexes, groups moved files by placement, sends one `file-update` per affected placement, and tracks all `oldEntries` against the **last** `updateId` of the compaction batch
5. On failure — full rollback: restores extents and tail of the target segment

Compaction uses the same batch-first ACK rule as epoch flush: workers may receive several `file-update` messages from one compaction, but memory is released only after the ACK for the last message in that batch.

After compaction, the emptied segment automatically enters `cleanSegmentIds` through the normal `free → retireSegment` cycle.

```
Before compaction:

Segment 1: [fileA][____][fileB][________]  utilization 20%
Segment 2: [fileC][fileD][______________]  utilization 60%

After:

Segment 1: → clean (empty, ready for reuse)
Segment 2: [fileC][fileD][fileA][fileB][_]  utilization 80%
```

## Configuration

```js
// config/cache.js
// limit must be a multiple of baseSegmentSize (after ceil adjustment)
// baseSegmentSize must be ≥ maxFileSize; if not, it is rounded up:
//   effective = Math.ceil(maxFileSize / baseSegmentSize) * baseSegmentSize
({
  sab: {
    limit: '1 gib',           // total SAB budget (must be divisible by segment size)
    baseSegmentSize: '64 mib', // single segment size (must be ≥ maxFileSize)
  },
  maxFileSize: '10 mb',        // files larger than this → disk entry
  placements: [
    { name: 'static' },
    { name: 'resources' },
    { name: 'assets', ext: ['.png', '.jpg', '.woff2'] },
  ],
});
```

Both binary (KiB, MiB, GiB) and decimal (KB, MB, GB) units are supported.

**Important:** `limit` must be evenly divisible by the effective `baseSegmentSize`. Otherwise the remainder is wasted — Pool cannot create a segment smaller than `baseSegmentSize`.

## Safety invariants

- Workers **never write** to SharedArrayBuffer
- Old memory is freed **only after ACK** from all workers or worker exit
- SAB references in worker `segmentsMap` live for the entire process lifetime (slab retention)
- All worker Buffer views reference SABs from a **single** `segmentsMap` (not a copy)
- SAB segments are **never returned to the OS** — only reused
- Total memory usage is always ≤ `limit`

## Patterns and influences

The cache design draws on several well-known systems patterns:

- **SLUB slab allocator** (Linux kernel) — segments are never returned to the OS; empty segments are marked clean and reused, eliminating allocation system calls
- **Extent-based allocation** (ext4, XFS) — free space tracked as `{ offset, length }` extents with best-fit search and adjacent merge on free
- **Event coalescing / group commit** (PostgreSQL WAL, Nagle's algorithm) — metawatch debounces fs events into batches, SharedCache coalesces each batch into minimal broadcasts via epoch flush
- **Copy-on-write update** (MVCC) — file updates allocate a new extent, old data lives until all workers ACK; readers never see partial writes
- **Dependency injection** — FileCache accepts an injectable `reader` function, keeping it free of Node.js built-in dependencies for cross-platform use

## Data flow diagram

```
                    ┌─────────────────────────────┐
                    │         Main Thread          │
                    │                              │
                    │  SharedCache                 │
                    │   ├── FileCache              │
                    │   │    ├── Pool              │
                    │   │    │    └── SAB segments  │
                    │   │    └── Registry           │
                    │   │         └── extents/tails │
                    │   ├── StaticSource[]          │
                    │   └── Watcher                 │
                    └──────────┬──────────────────┘
                               │
                    snapshot / file-update / file-delete
                               │
            ┌──────────────────┼──────────────────┐
            ▼                  ▼                  ▼
     ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
     │  Worker 1   │   │  Worker 2   │   │  Worker N   │
     │             │   │             │   │             │
     │ segmentsMap │   │ segmentsMap │   │ segmentsMap │
     │ (SAB refs)  │   │ (SAB refs)  │   │ (SAB refs)  │
     │             │   │             │   │             │
     │ place.files │   │ place.files │   │ place.files │
     │ (views)     │   │ (views)     │   │ (views)     │
     └─────────────┘   └─────────────┘   └─────────────┘
            │                  │                  │
            └──── Buffer.from(sab, offset, len) ──┘
                   zero-copy data access
```
