# Shared Cache: SAB Per File Backend

This branch uses a shared static cache based on one SharedArrayBuffer per file.
The goal of the current refactor is to keep that runtime behavior intact while aligning the class boundaries with the future shared-cache library design.

## Current Model

- Shared placements are `static` and `resources`.
- Files up to `config.cache.maxFileSize` are copied into one dedicated SharedArrayBuffer per file.
- Files larger than `maxFileSize` stay disk-backed and are served from disk by workers.
- Workers receive cache snapshots and deltas through `cache-init`, `cache-update`, and `cache-delete` messages.
- Worker-side `Static` projects shared entries eagerly with `Buffer.from(sab, 0, byteLength)`.

## Structural Split

The branch is being aligned to three roles.

- Source layer: scans placements and tracks normalized file metadata.
- Shared-cache orchestrator: owns startup snapshot generation, file watching, and worker broadcasts.
- Per-file backend: implements one-SAB-per-file storage and produces worker-facing entries.

This split is structural.
It does not introduce pooled segments, allocator metadata, compaction, worker ACK flow, or update IDs.

## Worker Contract

Shared entries keep the current shape:

```js
{
  key,
  sab,
  byteLength,
  size,
}
```

Oversized files project as:

```js
{
  key,
  sab: null,
  byteLength: 0,
  size,
}
```

`Static.withData()` converts shared entries to zero-copy Buffer views.
Disk-backed entries stay `data: null` and are read from disk during `serve()`.

## Invariants

- Keep public cache config keys unchanged: `maxFileSize`, `streamThreshold`, `virtualFS`, and `avoid`.
- Keep `Static.serve()` behavior unchanged, including exact-hit lookup, range requests, status pages, virtual FS lookup, and disk fallback.
- Keep Windows path normalization producing forward-slash keys.
- Keep compatibility with existing imports from `lib/cache.js` while the classes move under `lib/cache/`.

## Future Direction

This refactor prepares one shared-cache orchestration layer for future backend selection.
Later, Impress can expose a configurable choice between `sab-per-file` and `sab-limit` backends without rewriting worker-side static serving again.
