import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {createBridge} from '../src/server.js';

const APK_PATH = '/v1/app-update/apk';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fixture(t, {apk = Buffer.from('fixed test APK bytes\n'), metadata = undefined} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-update-test-'));
  const stateDir = path.join(root, 'state');
  if (apk !== null) fs.writeFileSync(path.join(root, 'herdr-remote-debug.apk'), apk);
  const expected = {
    versionCode: 7,
    versionName: '0.2.1',
    sha256: sha256(apk ?? Buffer.from('fixed test APK bytes\n')),
    size: apk?.length ?? Buffer.from('fixed test APK bytes\n').length,
    apkPath: APK_PATH,
  };
  if (metadata !== null) fs.writeFileSync(path.join(root, 'app-update.json'), JSON.stringify(metadata ?? expected));

  const herdr = {call: async method => {
    if (method === 'session.snapshot') {
      return {snapshot: {protocol: 22, workspaces: [], panes: [], agents: []}};
    }
    return {type: 'ok'};
  }};
  const config = {
    socketPath: '/unused', stateDir,
    projects: [{id: 'project', label: 'Project', path: root}],
    allowTerminalInput: false,
  };
  const app = createBridge(config, {herdr, updateDir: root});
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const code = app.store.pairCode();
  const credential = app.store.pair(code, 'Update test device');
  const request = (route, token = credential.token, init = {}) => fetch(url + route, {
    ...init,
    headers: {Authorization: `Bearer ${token}`, ...(init.headers ?? {})},
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(root, {recursive: true, force: true});
  });
  return {root, app, request, credential, expected, apk};
}

test('app update endpoints require the normal device credential', async t => {
  const f = await fixture(t);
  for (const route of ['/v1/app-update', APK_PATH]) {
    assert.equal((await f.request(route, '')).status, 401);
    assert.equal((await f.request(route, 'invalid-token')).status, 401);
  }
});

test('authenticated app update manifest is fixed to the published APK', async t => {
  const f = await fixture(t);
  const response = await f.request('/v1/app-update');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await response.json(), f.expected);
});

test('authenticated app update download returns the verified APK bytes', async t => {
  const f = await fixture(t);
  const response = await f.request(APK_PATH);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-length'), String(f.apk.length));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.apk);
});

test('missing update metadata or APK returns helpful 404 responses', async t => {
  const missingMetadata = await fixture(t, {metadata: null});
  for (const route of ['/v1/app-update', APK_PATH]) {
    const response = await missingMetadata.request(route);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'update_missing');
  }

  const missingApk = await fixture(t, {apk: null});
  for (const route of ['/v1/app-update', APK_PATH]) {
    const response = await missingApk.request(route);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'update_missing');
  }
});

test('malformed metadata is rejected before a download is served', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, 'app-update.json'), '{not-json');
  for (const route of ['/v1/app-update', APK_PATH]) {
    const response = await f.request(route);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'update_invalid');
  }
});

test('metadata checksum and size mismatches are rejected before serving bytes', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, 'app-update.json'), JSON.stringify({...f.expected, sha256: '0'.repeat(64)}));
  for (const route of ['/v1/app-update', APK_PATH]) assert.equal((await f.request(route)).status, 503);

  fs.writeFileSync(path.join(f.root, 'app-update.json'), JSON.stringify({...f.expected, size: f.expected.size + 1}));
  for (const route of ['/v1/app-update', APK_PATH]) assert.equal((await f.request(route)).status, 503);
});

test('a cached artifact is invalidated when the fixed APK changes', async t => {
  const f = await fixture(t);
  const first = await f.request(APK_PATH);
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), f.apk);

  const replacement = Buffer.from('other test APK bytes\n');
  assert.equal(replacement.length, f.apk.length);
  fs.writeFileSync(path.join(f.root, 'herdr-remote-debug.apk'), replacement);
  const response = await f.request(APK_PATH);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'update_invalid');
});

test('update routes do not turn request paths or URLs into file reads', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/v1/app-update/apk/other')).status, 404);
  assert.equal((await f.request('/v1/app-update?path=/etc/passwd')).status, 400);
  assert.equal((await f.request('/v1/app-update/apk?path=/etc/passwd')).status, 400);
  assert.equal((await f.request('/v1/app-update/apk', f.credential.token, {method: 'POST'})).status, 404);
});
