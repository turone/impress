# Shared Cache: SAB Limit Backend

This document keeps the `sab-limit` backend separate from the current `sab-per-file` runtime.
The goal is to preserve the limit design as a reference and future implementation target while the current branch continues to run on per-file SharedArrayBuffer storage.

## Model

- The limit backend uses a bounded shared-memory budget instead of allocating one SAB per file.
- Shared entries are described by allocation metadata inside pooled shared memory.
- Oversized files stay disk-backed and continue to use disk fallback semantics.
- Worker-visible static-file behavior must stay compatible with the rest of Impress even if the internal storage model differs.

## Internal Roles

- `StaticSource` owns file discovery, recursive scanning, and normalized keys.
- `SharedCache` owns watch lifecycle, worker integration, and coordinated updates.
- The limit storage backend owns allocation, reuse, and projection from pooled memory into worker-visible entries.

## Lifecycle Expectations

- Shared memory freeing must be coordinated safely across workers.
- Compaction and reuse are valid responsibilities of the limit backend.
- Update flow may require lifecycle tracking for old entries before pooled memory is reclaimed.

## Compatibility Boundary

- `Static.serve()`, exact-hit lookup, range handling, virtual FS behavior, and disk fallback must stay externally compatible.
- The limit backend should remain isolatable enough that Impress can later choose between `sab-per-file` and `sab-limit` behind one orchestration layer.

## Status

This is a backend-specific reference document.
The current active branch runtime is documented in `doc/shared-cache-per-file.md`.
