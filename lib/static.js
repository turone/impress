'use strict';

const { node, metarhia } = require('./deps.js');
const { join } = node.path.posix;

const STATUS_CACHE = new Map();

const status = (code) => {
  let file = STATUS_CACHE.get(code);
  if (file) return file;
  const status = node.http.STATUS_CODES[code] || 'Unknown error';
  const data = Buffer.from(`<!DOCTYPE html>
<html><head><title>${code} ${status}</title></head>
<body><h1>${code} ${status}</h1></body></html>`);
  file = { data, stat: null, code };
  STATUS_CACHE.set(code, file);
  return file;
};

class Static {
  constructor(name, application) {
    this.name = name;
    this.path = application.absolute(name);
    this.files = new Map();
  }

  get(key) {
    return this.files.get(key);
  }

  setFiles(filesMap) {
    this.files = filesMap;
  }

  updateFiles(updates) {
    for (const [key, file] of updates) {
      this.files.set(key, file);
    }
  }

  deleteFiles(keys) {
    for (const key of keys) {
      this.files.delete(key);
    }
  }

  find(path, code, parent = false) {
    let filePath = path;
    const root = path === '/';
    if (code) {
      const fileName = `.${code}.html`;
      filePath = join(filePath, fileName);
      const file = this.get(filePath);
      if (file) return { data: file.data, stat: null, code };
      if (root) return status(code);
    } else {
      const folder = path.endsWith('/');
      if (folder && !parent) {
        filePath = join(path, 'index.html');
      }
      let file = this.get(filePath);
      if (file) return { ...file, code: 200 };
      filePath = join(path, '.virtual.html');
      file = this.get(filePath);
      if (file) return { ...file, code: -1 };
      if (root) return this.find(filePath, 404, true);
    }
    filePath = node.path.dirname(path);
    if (filePath !== '/') filePath += '/';
    return this.find(filePath, code, true);
  }

  async serve(url, transport) {
    const [filePath] = metarhia.metautil.split(url, '?');
    const fileExt = metarhia.metautil.fileExt(filePath);
    const exact = this.get(filePath);
    const internal = node.path.basename(filePath).startsWith('.');
    if (exact && exact.data && exact.stat && !internal) {
      return void transport.write(exact.data, 200, fileExt);
    }
    let file = this.find(filePath);
    if (file.data && file.stat) {
      if (file.code === -1) return void transport.write(file.data, 200, 'html');
      return void transport.write(file.data, file.code, fileExt);
    }
    const absPath = join(this.path, url);
    if (absPath.startsWith(this.path)) {
      let { stat } = file;
      if (!stat) stat = await node.fsp.stat(absPath).catch(() => null);
      if (stat && (!stat.isFile || stat.isFile())) {
        const { size } = stat;
        const options = { size };
        let code = 200;
        const { headers } = transport.req;
        if (headers.range) {
          const range = metarhia.metautil.parseRange(headers.range);
          const { start, end = size - 1 } = range;
          if (start >= end || start >= size || end >= size) {
            file = this.find(filePath, 416);
            return void transport.write(file.data, 416, fileExt);
          }
          options.start = start;
          options.end = end;
          code = 206;
        }
        const readable = node.fs.createReadStream(absPath, options);
        return void transport.write(readable, code, fileExt, options);
      }
    }
    if (file.code === -1) return void transport.write(file.data, 200, 'html');
    return void transport.write(file.data, 404);
  }
}

module.exports = { Static };
