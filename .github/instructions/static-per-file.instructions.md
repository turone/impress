---
branch: static-SAB
description: "Use when modifying the current sab-per-file shared cache, its class split, worker projection, cache config, tests, or per-file shared-cache documentation."
name: "Static Per-File Shared Cache"
applyTo: lib/cache.js, lib/cache/**, lib/static.js, lib/worker.js, lib/application.js, impress.js, schemas/config/cache.js, test/cache*.js, test/cache/**, test/static.js, doc/shared-cache-per-file.md
---

# static-SAB Per-File Cache Architecture

This file contains the active branch-specific architecture for the current `static-SAB` implementation.
When this file conflicts with older docs or the future limit backend reference, current branch code and this file win.

## Current Scope

- The current backend uses one SharedArrayBuffer per file, not pooled segments.
- The class split for this branch should mirror the limit design structurally where practical: a source layer, an orchestration layer, and a per-file storage backend.
- The storage backend for this branch remains per-file SAB, with no allocator, no compaction, and no worker ACK flow.
- `impress.js` owns application startup and delegates shared-cache lifecycle to the cache orchestrator.
- `lib/worker.js` applies `cache-init`, `cache-update`, and `cache-delete` messages only.
- `lib/static.js` projects shared entries into worker-visible `this.files` and keeps serve semantics unchanged.

## Per-File Backend Rules

- Files with `size <= maxFileSize` are represented by one dedicated SharedArrayBuffer per file.
- Files with `size > maxFileSize` stay disk-backed and must project as `sab: null` with `byteLength: 0`.
- No segment pool, no shared extents, no allocator metadata, no compaction bookkeeping, and no `segments-free` message flow belong in this backend.
- Worker-facing shared entries remain compatible with the current contract: `{ key, sab, byteLength, size }`.
- Internal refactoring may introduce dedicated classes, but the projected worker-facing shape must stay compatible during the split.

## Source And Orchestrator Rules

- The source layer follows the `Place` lifecycle and owns recursive scanning plus path normalization.
- The orchestrator parses `maxFileSize` and `streamThreshold` via `sizeToBytes()` and keeps current config names intact.
- The orchestrator owns placement registration, initial snapshot generation, watcher setup, and broadcast of deltas to workers.
- Watch flow remains change-driven and per-file; do not add epoch batching, update IDs, or ACK coordination in this backend.
- `static` and `resources` remain the default shared-cache placements.

## Projection Rules For This Branch

- Worker-side projection remains eager.
- `Static.withData()` must continue to create `Buffer.from(entry.sab, 0, entry.byteLength)` for shared entries.
- Public files exposed through `Static.files` keep current observable semantics:
  - shared file: `{ key, sab, byteLength, size, data }`
  - disk-backed file: `{ key, sab: null, byteLength: 0, size, data: null }`
- Zero-copy SAB views are required for shared entries.

## Worker And Application Integration

- `worker.js` continues to handle `cache-init`, `cache-update`, and `cache-delete` only.
- Do not introduce ACK handling, `updateId`, or segment lifecycle messages in this branch.
- `application.js` should not reintroduce per-worker static file loading for placements handled by the shared cache.
- Worker startup must still receive the initial snapshot before shared static files are served.
- Empty placements are valid and must not fail initialization.

## Required Behavior

- Do not break current public cache configuration keys: `maxFileSize`, `streamThreshold`, `virtualFS`, and `avoid`.
- Do not break `Static.serve()`, `lookup()`, `find()`, range requests, status pages, virtual FS behavior, or disk fallback semantics.
- Keep the fast exact-hit path for cached files in `Static.serve()`.
- Keep shared-cache placements externally stable while preparing an internal seam for a future configurable backend.
- Preserve backward compatibility of current imports from `lib/cache.js` while introducing the split classes.
- Keep Windows path normalization producing forward-slash keys.

## Future Unification Boundary

- This branch should be refactored so a future shared-cache library can choose between `sab-per-file` and `sab-limit` backends behind one orchestration layer.
- In this branch, that future seam is internal only; do not add a user-facing backend switch yet.
- Keep the worker-visible contract stable during the refactor so the later backend switch happens behind the shared-cache orchestrator, not inside `Static` consumers.

## Tests And Docs

- Update or add tests for the per-file backend, orchestrator, source layer, and `Static` when changing scanning, projection, watch behavior, or branch-specific contracts.
- Keep `test/cache-shared.js` and `test/static.js` behaviorally covered even if tests are reorganized.
- Keep `doc/shared-cache-per-file.md` aligned with this branch implementation.
- If the per-file shared-cache architecture changes in this branch, update this file in the same change.
