'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { Cert } = require('../../lib/cert.js');
const { Static } = require('../../lib/static.js');
const { Place } = require('../../lib/place.js');

test('Cert isolation - Cert extends Place directly', () => {
  assert.ok(Cert.prototype instanceof Place);
});

test('Cert isolation - Cert does not extend Static', () => {
  assert.ok(!(Cert.prototype instanceof Static));
});

test('Cert isolation - Static does not extend Place', () => {
  assert.ok(!(Static.prototype instanceof Place));
});

test('Cert isolation - Cert has own files Map', () => {
  const app = {
    path: path.join(process.cwd(), 'test'),
    watcher: { watch() {} },
    absolute(relative) {
      return path.join(this.path, relative);
    },
    console: { error() {} },
  };
  const cert = new Cert('cert', app, { ext: ['pem'] });
  assert.ok(cert.files instanceof Map);
  assert.strictEqual(cert.files.size, 0);
  assert.ok(cert.domains instanceof Map);
});

test('Cert isolation - Cert has own change/delete/getKey', () => {
  const app = {
    path: path.join(process.cwd(), 'test'),
    watcher: { watch() {} },
    absolute(relative) {
      return path.join(this.path, relative);
    },
    console: { error() {} },
  };
  const cert = new Cert('cert', app, { ext: ['pem'] });
  assert.strictEqual(typeof cert.change, 'function');
  assert.strictEqual(typeof cert.delete, 'function');
  assert.strictEqual(typeof cert.getKey, 'function');
  assert.strictEqual(typeof cert.get, 'function');
  assert.strictEqual(typeof cert.load, 'function');
});

test('Cert isolation - Cert has no setFiles/updateFiles/deleteFiles', () => {
  const app = {
    path: path.join(process.cwd(), 'test'),
    watcher: { watch() {} },
    absolute(relative) {
      return path.join(this.path, relative);
    },
    console: { error() {} },
  };
  const cert = new Cert('cert', app, { ext: ['pem'] });
  assert.strictEqual(typeof cert.setFiles, 'undefined');
  assert.strictEqual(typeof cert.updateFiles, 'undefined');
  assert.strictEqual(typeof cert.deleteFiles, 'undefined');
});

test('Cert isolation - Cert get returns from domains not files', () => {
  const app = {
    path: path.join(process.cwd(), 'test'),
    watcher: { watch() {} },
    absolute(relative) {
      return path.join(this.path, relative);
    },
    console: { error() {} },
  };
  const cert = new Cert('cert', app, { ext: ['pem'] });
  cert.files.set('/test.pem', { data: Buffer.from('x'), stat: {} });
  cert.domains.set('example.com', { key: 'k', cert: 'c' });
  assert.strictEqual(cert.get('/test.pem'), undefined);
  assert.deepStrictEqual(
    cert.get('example.com'),
    { key: 'k', cert: 'c' },
  );
});
