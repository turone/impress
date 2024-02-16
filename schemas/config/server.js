({
  host: 'string',
  balancer: '?number',
  protocol: { enum: ['http', 'https', 'http2'] },
  ports: { array: 'number' },
  'apiUri?': 'string',
  'static?': {
    'ext?': { array: 'string' },
    'disabledVirtualFolders?': 'boolean',
    'folders?': { array: 'string' },
    'rootFiles?': { array: 'string' },
  },
  nagle: 'boolean',
  timeouts: {
    bind: 'number',
    start: 'number',
    stop: 'number',
    request: 'number',
    watch: 'number',
    test: 'number',
  },
  queue: {
    concurrency: 'number',
    size: 'number',
    timeout: 'number',
  },
  scheduler: {
    concurrency: '?number',
    size: '?number',
    timeout: '?number',
  },
  workers: {
    pool: 'number',
    wait: 'number',
    timeout: 'number',
  },
  cors: {
    origin: '?string',
  },
});
