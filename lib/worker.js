'use strict';

const { node, metarhia, notLoaded, wt } = require('./deps.js');
const { parentPort, threadId, workerData } = wt;
const { FileCache } = require('./cache/FileCache.js');

const application = require('./application.js');

// Build segments map from workerData for SAB lookups
const segmentsMap = new Map();
if (workerData.sharedCache) {
  const { segments } = workerData.sharedCache;
  for (const seg of segments) segmentsMap.set(seg.id, seg.sab);
  application.segmentsMap = segmentsMap;
}

const logError = (type) => async (err) => {
  const error = metarhia.metautil.isError(err) ? err : new Error('Unknown');
  if (error.name === 'ExperimentalWarning') return;
  const msg = error.stack || error.message || 'no stack trace';
  console.error(type + ': ' + msg);
  if (application.initialization) {
    console.info(`Initialization failed in worker ${threadId}`);
    await application.shutdown();
    process.exit(0);
  }
};

process.removeAllListeners('warning');
process.on('warning', logError('warning'));
process.on('uncaughtException', logError('uncaughtException'));
process.on('unhandledRejection', logError('unhandledRejection'));

let callId = 0;
const calls = new Map();

const invoke = async ({ method, args, exclusive = false }) => {
  const id = ++callId;
  const data = { type: 'call', id, method, args };
  const msg = { name: 'invoke', from: threadId, exclusive, data };
  return new Promise((resolve, reject) => {
    const handler = ({ error, result }) => {
      calls.delete(id);
      if (error) reject(error);
      else resolve(result);
    };
    calls.set(id, handler);
    parentPort.postMessage(msg);
  });
};

const handlers = {
  ready: async () => {
    application.emit('ready');
  },

  stop: async () => {
    if (application.finalization) return;
    console.info(`Graceful shutdown in worker ${threadId}`);
    await application.shutdown();
    process.exit(0);
  },

  'file-update': async (msg) => {
    const { target, updateId, updates, newSegments } = msg;
    if (newSegments) {
      for (const seg of newSegments) segmentsMap.set(seg.id, seg.sab);
    }
    const projected = new Map();
    for (const [key, entry] of updates) {
      projected.set(key, FileCache.projectEntry(entry, segmentsMap));
    }
    const place = application[target];
    if (place) place.updateFiles(projected);
    parentPort.postMessage({ name: 'ack-update', updateId });
  },

  'file-delete': async (msg) => {
    const { target, updateId, keys } = msg;
    const place = application[target];
    if (place) place.deleteFiles(keys);
    parentPort.postMessage({ name: 'ack-update', updateId });
  },

  invoke: async ({ from, to, exclusive, data }) => {
    if (to) {
      const { id, status, error, result } = data;
      const handler = calls.get(id);
      const err = status === 'error' ? new Error(error.message) : null;
      return void handler({ error: err, result });
    }
    const { sandbox, config } = application;
    const msg = { name: 'invoke', to: from };
    const { timeout } = config.server.workers;
    const { id, method = '', args = {} } = data;
    const handler = metarhia.metautil.namespaceByPath(sandbox, method);
    if (!handler) {
      const error = { message: 'Handler not found' };
      const data = { id, status: 'error', error };
      return void parentPort.postMessage({ ...msg, data });
    }
    try {
      let promise = handler(args);
      if (timeout) promise = metarhia.metautil.timeoutify(promise, timeout);
      const result = await promise;
      const data = { id, status: 'done', result };
      parentPort.postMessage({ ...msg, data });
    } catch (err) {
      const error = { message: err.message };
      const data = { id, status: 'error', error };
      parentPort.postMessage({ ...msg, data });
      application.console.error(err.stack);
    } finally {
      if (exclusive) parentPort.postMessage({ name: 'release' });
    }
  },
};

parentPort.on('message', async (msg) => {
  const handler = handlers[msg.name];
  if (handler) handler(msg);
});

(async () => {
  const cfgPath = node.path.join(application.path, 'config');
  const context = metarhia.metavm.createContext({ process });
  const cfgOptions = { mode: process.env.MODE, context };
  const { Config } = metarhia.metaconfiguration;
  const config = await new Config(cfgPath, cfgOptions);
  const logPath = node.path.join(application.root, 'log');
  const home = application.root;
  const logOptions = { path: logPath, workerId: threadId, ...config.log, home };
  const logger = await new metarhia.metalog.Logger(logOptions);
  logger.on('error', logError('logger error'));
  if (logger.active) global.console = logger.console;
  Object.assign(application, { config, logger, console });

  if (notLoaded.size > 0) {
    if (threadId === 1) {
      const libs = Array.from(notLoaded).join(', ');
      console.error(`Can not load modules: ${libs}`);
    }
    process.exit(0);
  }

  await application.load({ invoke, sharedCache: workerData.sharedCache });
  console.info(`Application started in worker ${threadId}`);
  parentPort.postMessage({ name: 'started', kind: workerData.kind });
})().catch(logError(`Can not start worker ${threadId}`));
