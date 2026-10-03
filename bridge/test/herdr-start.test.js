import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createBridge} from '../src/server.js';
import {BridgeError} from '../src/herdr.js';
import {ensureHerdrRunning} from '../src/start-herdr.js';

const offline = () => new BridgeError('herdr_offline', 'Herdr is offline.', 503);
const timeout = () => new BridgeError('herdr_timeout', 'Herdr did not respond.', 504);

test('already running returns without starting the unit', async () => {
  const calls = [];
  let starts = 0;
  const herdr = {call: async (...args) => { calls.push(args); return {type: 'pong'}; }};

  const result = await ensureHerdrRunning({
    herdr,
    startUnit: async () => { starts += 1; },
  });

  assert.deepEqual(result, {alreadyRunning: true});
  assert.equal(starts, 0);
  assert.deepEqual(calls, [['ping', {}, 1000]]);
});

test('offline Herdr starts once and waits until ping is ready', async () => {
  const calls = [];
  let starts = 0;
  let first = true;
  const herdr = {call: async (...args) => {
    calls.push(args);
    if (first) {
      first = false;
      throw offline();
    }
    return {type: 'pong'};
  }};

  const result = await ensureHerdrRunning({
    herdr,
    startUnit: async () => { starts += 1; },
    sleep: async () => {},
  });

  assert.deepEqual(result, {alreadyRunning: false});
  assert.equal(starts, 1);
  assert.deepEqual(calls.map(([method, params, timeoutMs]) => [method, params, timeoutMs]), [
    ['ping', {}, 1000],
    ['ping', {}, 1000],
  ]);
});

test('an initial timeout is propagated without starting Herdr', async () => {
  const calls = [];
  let starts = 0;
  const herdr = {call: async (...args) => {
    calls.push(args);
    throw timeout();
  }};

  await assert.rejects(
    ensureHerdrRunning({herdr, startUnit: async () => { starts += 1; }}),
    error => error.code === 'herdr_timeout',
  );
  assert.equal(starts, 0);
  assert.deepEqual(calls, [['ping', {}, 1000]]);
});

test('a failed unit start is propagated without readiness polling', async () => {
  const calls = [];
  const startFailure = new Error('start failed');
  const herdr = {call: async (...args) => {
    calls.push(args);
    throw offline();
  }};

  await assert.rejects(
    ensureHerdrRunning({herdr, startUnit: async () => { throw startFailure; }}),
    error => error === startFailure,
  );
  assert.deepEqual(calls, [['ping', {}, 1000]]);
});

test('readiness polling stops at the fake deadline', async () => {
  const calls = [];
  let starts = 0;
  let clock = 0;
  let sleeps = 0;
  const herdr = {call: async (...args) => {
    calls.push(args);
    throw offline();
  }};

  await assert.rejects(
    ensureHerdrRunning({
      herdr,
      startUnit: async () => { starts += 1; },
      timeoutMs: 3000,
      now: () => clock,
      sleep: async milliseconds => {
        assert.ok(milliseconds > 0);
        sleeps += 1;
        clock += milliseconds;
      },
    }),
    error => error instanceof BridgeError && error.code === 'herdr_start_timeout',
  );
  assert.equal(starts, 1);
  assert.ok(clock >= 3000);
  assert.ok(sleeps > 0 && sleeps <= 20);
  assert.ok(calls.length <= 21);
});

async function routeFixture(t, {allowHerdrStart = false, online = true, snapshotError} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-start-test-'));
  const calls = [];
  let started = 0;
  const herdr = {call: async (method, params, timeoutMs) => {
    calls.push({method, params, timeoutMs});
    if (method === 'ping') {
      if (!online) throw offline();
      return {type: 'pong'};
    }
    if (method === 'session.snapshot') {
      if (snapshotError) throw snapshotError;
      return {snapshot: {protocol: 22, workspaces: [], panes: [], agents: []}};
    }
    return {type: 'ok'};
  }};
  const config = {
    socketPath: '/unused',
    stateDir: path.join(root, 'state'),
    projects: [{id: 'project', label: 'Project', path: root}],
    allowHerdrStart,
  };
  const app = createBridge(config, {
    herdr,
    startHerdrUnit: async () => {
      started += 1;
      online = true;
    },
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const code = app.store.pairCode();
  const credential = app.store.pair(code, 'Herdr start test device');
  const request = (route, {token = credential.token, body, method = 'POST'} = {}) => {
    const headers = {'Content-Type': 'application/json'};
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(url + route, {
      method,
      headers,
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
  };
  t.after(async () => {
    await app.close();
    fs.rmSync(root, {recursive: true, force: true});
  });
  return {app, calls, credential, request, get started() { return started; }};
}

test('Herdr start route requires the normal device credential', async t => {
  const fixture = await routeFixture(t, {allowHerdrStart: true, online: false});
  const response = await fixture.request('/v1/herdr/start', {token: ''});
  assert.equal(response.status, 401);
  assert.equal(fixture.calls.length, 0);
});

test('Herdr start route is disabled unless explicitly configured', async t => {
  const fixture = await routeFixture(t, {allowHerdrStart: false, online: false});
  const response = await fixture.request('/v1/herdr/start');
  assert.equal(response.status, 403);
  assert.equal(fixture.started, 0);
  assert.equal(fixture.calls.length, 0);
});

test('configured Herdr start route starts an offline unit', async t => {
  const fixture = await routeFixture(t, {allowHerdrStart: true, online: false});
  const response = await fixture.request('/v1/herdr/start', {body: {}});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {ok: true, alreadyRunning: false});
  assert.equal(fixture.started, 1);
  assert.deepEqual(fixture.calls.map(call => call.method), ['ping', 'ping']);
});

test('Herdr start route rejects client commands in the body', async t => {
  const fixture = await routeFixture(t, {allowHerdrStart: true, online: false});
  const response = await fixture.request('/v1/herdr/start', {body: {command: 'systemctl start herdr'}});
  assert.equal(response.status, 400);
  assert.equal(fixture.started, 0);
  assert.equal(fixture.calls.length, 0);
});

test('snapshot advertises Herdr start only for an enabled offline unit', async t => {
  const offlineFixture = await routeFixture(t, {allowHerdrStart: true, snapshotError: offline()});
  const offlineSnapshot = await (await offlineFixture.request('/v1/snapshot', {method: 'GET'})).json();
  assert.equal(offlineSnapshot.canStartHerdr, true);

  const timeoutFixture = await routeFixture(t, {allowHerdrStart: true, snapshotError: timeout()});
  const timeoutSnapshot = await (await timeoutFixture.request('/v1/snapshot', {method: 'GET'})).json();
  assert.equal(timeoutSnapshot.canStartHerdr, false);

  const disabledFixture = await routeFixture(t, {allowHerdrStart: false, snapshotError: offline()});
  const disabledSnapshot = await (await disabledFixture.request('/v1/snapshot', {method: 'GET'})).json();
  assert.equal(disabledSnapshot.canStartHerdr, false);
});
