---
branch: StaticSABLimit
description: "Use when modifying the SharedArrayBuffer shared static cache on the StaticSABLimit branch: FileCache, SharedCache, worker projection, ACK handling, compaction, StaticSource, cache config, tests, or shared-cache documentation."
name: "StaticSABLimit Shared Cache"
applyTo: lib/cache/**, lib/worker.js, lib/application.js, impress.js, schemas/config/cache.js, test/cache/**, doc/shared-cache.md
---

# StaticSABLimit Cache Architecture

This file contains the branch-specific architecture for the current `StaticSABLimit` implementation.
When this file conflicts with older docs or top-level instructions, current branch code and this file win.

## Current Scope

- The shared cache is implemented by `lib/cache/FileCache.js`, `lib/cache/SharedCache.js`, and `lib/cache/StaticSource.js`.
- `impress.js` owns main-thread orchestration and worker startup.
- `lib/worker.js` applies deltas and ACKs them.
- `lib/application.js` projects initial cache snapshot into worker-side `Static` places.

## FileCache Rules For This Branch

- `FileCache` is self-contained and has no Node.js built-in or impress-internal dependencies.
- There is only one segment type in this branch: base segments.
- There are no oversize dedicated segments in this branch.
- `Pool` retains empty segments in `cleanSegmentIds` and reuses them; segments are not returned to the OS.
- `baseSegmentSize = Math.ceil(maxFileSize / configured) * configured`.
- `limit` should be evenly divisible by the effective `baseSegmentSize`; otherwise the remainder is wasted.
- `load()` sorts candidates by descending size before allocation.
- `Registry.allocate()` does: best-fit free extent, then tail append, then new segment, else disk fallback.
- Shared entries are internal metadata objects: `{ kind: 'shared', segmentId, offset, length, stat }`.
- Disk entries are internal metadata objects: `{ kind: 'disk', path, stat, data: null }`.
- `size > maxFileSize` always means disk entry.

## Projection Rules For This Branch

- Worker-side projection is eager, not lazy.
- `FileCache.projectEntry()` creates `Buffer.from(segmentsMap.get(segmentId), offset, length)` once at projection time.
- Public shared files exposed through `this.files` are `{ data, stat }`.
- Disk-backed files exposed through `this.files` are `{ data: null, stat, path }`.
- Buffer views are lightweight descriptors over SAB and are garbage-collected when projected file objects are removed.

## SharedCache Rules For This Branch

- `SharedCache` parses `limit`, `baseSegmentSize`, and `maxFileSize` via `sizeToBytes()` and supports both binary and decimal units.
- Placements come from `config.cache.placements` and default to `static` and `resources`.
- `SharedCache` injects a Node.js reader using `fs.open()` and `fh.read()` into a Buffer view over SAB.
- `watch()` uses metawatch `before` / `change` / `delete` / `after` events to build an epoch.
- Placement routing in `watch()` is based on the first segment of the path relative to application root, not on absolute-path prefix matching.
- `processChange(ep, ...)` must receive the epoch explicitly; do not close over the mutable `epoch` variable from async code.
- `#flushEpoch()` emits at most one `file-update` and one `file-delete` per placement per epoch.
- Old entries are tracked against the last `updateId` produced in the epoch.
- There is no timeout-based forced free in this branch.
- Old entries are freed only after all workers ACK or after `handleWorkerExit(workerId)` removes a dead worker from pending sets.
- `#tryCompact()` runs after freeing entries.
- `#tryCompact()` is batch-first: it may broadcast one `file-update` per placement, but tracks `oldEntries` only once against the last `updateId` of the compaction batch.
- `compact()` may legitimately return `null`; current logging prints `[cache] compact: no target found` in that case.

## Worker And Application Integration

- `worker.js` owns a single module-scope `segmentsMap` built from `workerData.sharedCache.segments`.
- Workers handle only `file-update` and `file-delete` messages for shared cache deltas.
- There is no `segments-free` message flow in this branch.
- Shared cache initialization is mandatory for startup in this branch; there is no fallback to per-worker static loading if shared cache init fails.
- Empty placements are valid: initialization may succeed with zero files and zero segments.
- `application.load()` and `application.applySharedCache()` require a non-null shared cache snapshot.
- `application.applySharedCache(sharedCache, segmentsMap)` projects indexes with `FileCache.project()` and calls `setFiles()` on matching places.
- Worker startup applies the shared cache before `cert`, `schemas`, `lib`, `db`, `bus`, `domain`, and `api` finish loading.

## StaticSource Rules

- `StaticSource` stores only `{ stat, path }` in `files`.
- Path normalization is preinitialized once at module load via `toKey` and platform check.
- `getKey()` must continue to return forward-slash keys for Windows paths.

## Required Behavior

- Do not reintroduce per-worker static file copies.
- Do not break `static.serve`, `find`, range requests, or disk fallback semantics.
- `Static.serve()` must keep a fast exact-hit path for ordinary cached files and use recursive `find()` only for index, virtual, status, and fallback cases.
- Do not add Node.js built-in dependencies to `FileCache.js`.
- Keep placements configurable.
- Keep `this.files` consumer-visible behavior unchanged.

## Tests And Docs

- Update `test/cache/FileCache.js`, `test/cache/SharedCache.js`, `test/cache/StaticSource.js`, and integration tests when changing allocator, projection, ACK flow, watch batching, or placement behavior.
- Keep `doc/shared-cache.md` aligned with this branch implementation.
- If architecture changes in this branch, update this file in the same change.
