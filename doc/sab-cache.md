# SAB Cache — Configuration & Usage

Impress optionally serves static assets and JS modules from a
**SharedArrayBuffer-backed in-memory filesystem** shared across all
worker threads. Files are loaded once on startup; workers read them
as zero-copy `Buffer` views with no per-request allocation.

---

## Quick start

Add a `cache` section to `config/cache.js` (or `config/cache.json`):

```js
({
  size: '512 mib',         // Total application cache budget (not SAB-specific)
  maxFileSize: '10 mb',    // Files larger than this are served from disk
  streamThreshold: '1 mb', // Files larger than this are streamed (not buffered)

  sab: {
    limit: '512 mib',         // Total SharedArrayBuffer pool size
    baseSegmentSize: '64 mib', // Size of each SAB segment
  },

  placements: [
    { name: 'static',    ext: ['html', 'css', 'js', 'svg', 'png', 'woff2'] },
    { name: 'resources', ext: ['json', 'yaml', 'csv'] },
  ],
})
```

Without `sab`, the cache is disabled and all files are served from disk.
Without `placements`, only the built-in `static` and `resources` directories
are cached (all extensions, no bytecode compilation).

---

## Config fields

### `sab`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | size | — | Total SAB pool size (e.g. `'512 mib'`, `'1 gib'`). Required to enable SAB. |
| `baseSegmentSize` | size | — | Size of each segment. Smaller = more segments, more fragmentation risk. |

### `maxFileSize`

Files larger than `maxFileSize` are not loaded into SAB and are served from
disk on each request.

### `streamThreshold`

Files in SAB larger than `streamThreshold` are sent as a chunked `Readable`
stream rather than a single `Buffer.write()`. Set to `'0'` to always stream,
or omit to buffer everything in SAB (default: `Infinity`).

### `placements`

Array of additional directories to cache in SAB. Each entry:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Directory name relative to the application root. |
| `ext` | string[] | no | File extensions without dots: `['html', 'css']`. Omit to include all files. |

The directories `static` and `resources` are always included. Explicit entries
in `placements` override the defaults for those names.

---

## Memory sizing guide

| Scenario | `sab.limit` | `baseSegmentSize` |
|----------|-------------|-------------------|
| Small app, few static files | `128 mib` | `32 mib` |
| Medium app | `512 mib` | `64 mib` |
| Large app, many large assets | `1 gib` | `128 mib` |

Rules of thumb:
- `limit` ≥ total size of all cached files × 1.5.
- `baseSegmentSize` ≈ `limit / 16` keeps segment count manageable.
- Files larger than `maxFileSize` are never loaded, so they don't count toward `limit`.

---

## Disabling the SAB cache

Remove the `sab` section from `config/cache.js`. Impress falls back to
disk-based serving automatically — no other code changes required.
