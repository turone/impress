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
| `compile` | boolean | no | Enable V8 bytecode caching (see below). |

The directories `static` and `resources` are always included. Explicit entries
in `placements` override the defaults for those names.

---

## V8 bytecode caching

Setting `compile: true` on a placement compiles every `.js` file in that
directory into V8 bytecode at startup. Workers skip the V8 parse + compile
step entirely when `require()`-ing those files — including lazy functions.

### When to use

Enable for directories that workers `require()` frequently, such as `api/` or
`lib/`. Do **not** enable for static asset directories (`static/`, `resources/`)
— those files are not required.

### Config example

```js
({
  sab: { limit: '1 gib', baseSegmentSize: '64 mib' },

  placements: [
    { name: 'static',    ext: ['html', 'css', 'svg', 'png'] },
    { name: 'resources', ext: ['json', 'yaml'] },
    { name: 'api',       ext: ['js'], compile: true },
  ],
})
```

### How it works

1. `initialize()` scans directories and loads files into SAB.
2. For places with `compile: true`, every `.js` file is compiled:
   `Module.wrap(source)` → `vm.Script` → `script.createCachedData()`.
3. Bytecode is stored in the same SAB segments alongside source as a
   companion entry (`/handler.js.cache`).
4. Workers receive both source and bytecode via the startup snapshot.
5. When a worker `require()`s a file, the `require-hook` adapter reads
   the bytecode from SAB and passes it to `vm.Script` via `cachedData`.
   V8 skips parse + compile for all functions.

Companion `.cache` entries are invisible to `fs.*` patches — they don't
appear in directory listings and are never served over HTTP.

### Hot reload

When a `.js` file changes on disk, the watcher:
1. Reloads source into SAB.
2. Recompiles bytecode from the new source.
3. Broadcasts both source and bytecode to all workers in a single delta.
4. Workers apply the delta via `handleDelta()` — updated bytecode is
   available immediately for subsequent `require()` calls.

### Node.js version changes

If the application is restarted with a different Node.js version, the cached
bytecode is rejected by V8 (`cachedDataRejected === true`). The `require-hook`
falls back to standard compilation transparently. Fresh bytecode matching the
new V8 version is generated on the next startup.

---

## Memory sizing guide

| Scenario | `sab.limit` | `baseSegmentSize` |
|----------|-------------|-------------------|
| Small app, few static files | `128 mib` | `32 mib` |
| Medium app, static + API bytecode | `512 mib` | `64 mib` |
| Large app, many large assets | `1 gib` | `128 mib` |

Rules of thumb:
- `limit` ≥ total size of all cached files × 1.5 (bytecode adds 2–5× source size).
- `baseSegmentSize` ≈ `limit / 16` keeps segment count manageable.
- Files larger than `maxFileSize` are never loaded, so they don't count toward `limit`.

---

## Disabling the SAB cache

Remove the `sab` section from `config/cache.js`. Impress falls back to
disk-based serving automatically — no other code changes required.
