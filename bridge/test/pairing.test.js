import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPairingPayload,
  discoverCurrentQuickTunnelUrl,
  normalizeHttpsOrigin,
  preparePairing,
  renderPairingQr,
  quickTunnelDnsStatus,
} from '../src/pairing.js';
import {Store} from '../src/store.js';

test('pairing payload has the exact version, encoded origin, code and expiry fields', () => {
  const payload = buildPairingPayload('https://example.test/', '0123456789abcdef0123456789abcdef', 1790000000);
  assert.equal(payload, 'herdr-remote://pair?v=1&url=https%3A%2F%2Fexample.test&code=0123456789abcdef0123456789abcdef&expires=1790000000');
});

test('pairing origin validation rejects non-origin URLs and credentials', () => {
  assert.equal(normalizeHttpsOrigin(' https://example.test/ '), 'https://example.test');
  for (const value of [
    'http://example.test',
    'https://example.test/project',
    'https://example.test/?next=1',
    'https://user:pass@example.test',
    'https://',
  ]) assert.throws(() => normalizeHttpsOrigin(value), /HTTPS/);
});

test('quick tunnel discovery scopes journal output to the current invocation', async () => {
  const calls = [];
  const runner = {
    async exec(command, args) {
      calls.push({command, args});
      if (command === 'systemctl') return 'active\ncurrent-invocation-12345678\n';
      return [
        'old https://old-name.trycloudflare.com',
        'new https://new-name.trycloudflare.com',
      ].join('\n');
    },
  };
  assert.equal(await discoverCurrentQuickTunnelUrl(runner), 'https://new-name.trycloudflare.com');
  const journal = calls.find(call => call.command === 'journalctl');
  assert.ok(journal.args.includes('_SYSTEMD_INVOCATION_ID=current-invocation-12345678'));
});

test('quick-tunnel DNS fallback rejects non-Quick-Tunnel hosts before network access', async () => {
  let fetchCalls = 0;
  let getCalls = 0;
  await assert.rejects(
    quickTunnelDnsStatus('https://stable.example.test', {
      fetchImpl: async () => { fetchCalls += 1; return {ok: true, json: async () => ({})}; },
      get: () => { getCalls += 1; },
    }),
    /restricted to Quick Tunnel HTTPS hosts/,
  );
  assert.equal(fetchCalls, 0);
  assert.equal(getCalls, 0);
});

test('quick-tunnel DNS fallback keeps the original hostname and supplies the DoH address', async () => {
  const requests = [];
  let resumed = false;
  const status = await quickTunnelDnsStatus('https://fresh-name.trycloudflare.com', {
    fetchImpl: async url => {
      assert.match(url, /^https:\/\/cloudflare-dns\.com\/dns-query\?/);
      return {
        ok: true,
        async json() {
          return {Status: 0, Answer: [{type: 1, data: '203.0.113.7'}]};
        },
      };
    },
    get: (url, options, callback) => {
      const request = new EventEmitter();
      requests.push({url, options});
      options.lookup('fresh-name.trycloudflare.com', {all: false}, (error, address, family) => {
        assert.ifError(error);
        assert.equal(address, '203.0.113.7');
        assert.equal(family, 4);
      });
      queueMicrotask(() => callback({statusCode: 401, resume: () => { resumed = true; }}));
      return request;
    },
  });
  assert.equal(status, 401);
  assert.equal(resumed, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://fresh-name.trycloudflare.com/v1/health');
  assert.equal(requests[0].options.agent, false);
});

test('quick-tunnel DNS fallback rejects an invalid DNS answer without opening health request', async () => {
  let getCalls = 0;
  await assert.rejects(
    quickTunnelDnsStatus('https://fresh-name.trycloudflare.com', {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({Status: 0, Answer: [{type: 28, data: '2001:db8::7'}]}),
      }),
      get: () => { getCalls += 1; },
    }),
    /DNS is not ready/,
  );
  assert.equal(getCalls, 0);
});

test('stable public URL does not start or inspect the quick tunnel', async () => {
  const calls = [];
  const runner = {async exec(command, args) { calls.push({command, args}); return 'active\nbridge-invocation-12345678\n'; }};
  const result = await preparePairing(
    {port: 8787, publicUrl: 'https://stable.example.test'},
    {runner, fetchImpl: async () => ({status: 401}), sleepFn: async () => {}, timeoutMs: 100},
  );
  assert.equal(result, 'https://stable.example.test');
  assert.equal(calls.length, 0);
});

test('stopped fixed units are started and the current URL is checked before returning', async () => {
  const calls = [];
  const states = new Map([
    ['herdr-remote-bridge.service', ['inactive', 'bridge-invocation-12345678']],
    ['herdr-remote-quick-tunnel.service', ['inactive', 'tunnel-invocation-12345678']],
  ]);
  const runner = {
    async exec(command, args) {
      calls.push({command, args});
      const unit = args.find(value => value.endsWith('.service'));
      if (command === 'systemctl' && args.includes('show')) {
        const [state, invocation] = states.get(unit);
        return `${state}\n${invocation}\n`;
      }
      if (command === 'systemctl' && args.includes('start')) {
        states.set(unit, ['active', states.get(unit)[1]]);
        return '';
      }
      if (command === 'journalctl') return 'https://current-name.trycloudflare.com';
      throw new Error('unexpected fixed command');
    },
  };
  let localChecks = 0;
  const result = await preparePairing(
    {port: 8787},
    {
      runner,
      fetchImpl: async () => ({status: localChecks++ === 0 ? 0 : 401}),
      sleepFn: async () => {},
      timeoutMs: 100,
    },
  );
  assert.equal(result, 'https://current-name.trycloudflare.com');
  assert.ok(calls.some(call => call.command === 'systemctl' && call.args.includes('start') && call.args.includes('herdr-remote-bridge.service')));
  assert.ok(calls.some(call => call.command === 'systemctl' && call.args.includes('start') && call.args.includes('herdr-remote-quick-tunnel.service')));
  assert.ok(calls.some(call => call.command === 'journalctl' && call.args.includes('_SYSTEMD_INVOCATION_ID=tunnel-invocation-12345678')));
});

function quickTunnelFixture({oldPublicStatuses = [401], newPublicStatuses = [401]} = {}) {
  const calls = [];
  const states = new Map([
    ['herdr-remote-bridge.service', {activeState: 'active', invocationId: 'bridge-invocation-12345678'}],
    ['herdr-remote-quick-tunnel.service', {activeState: 'active', invocationId: 'old-tunnel-invocation-12345678'}],
  ]);
  const origins = [
    'https://old-name.trycloudflare.com',
    'https://new-name.trycloudflare.com',
  ];
  let generation = 0;
  const publicChecks = new Map();
  const runner = {
    async exec(command, args) {
      calls.push({command, args});
      const unit = args.find(value => value.endsWith('.service'));
      if (command === 'systemctl' && args.includes('show')) {
        const state = states.get(unit);
        return `ActiveState=${state.activeState}\nInvocationID=${state.invocationId}\n`;
      }
      if (command === 'systemctl' && args.includes('restart')) {
        assert.equal(unit, 'herdr-remote-quick-tunnel.service');
        generation += 1;
        states.get(unit).invocationId = 'new-tunnel-invocation-12345678';
        return '';
      }
      if (command === 'journalctl') return origins[generation];
      throw new Error(`unexpected fixed command: ${command} ${args.join(' ')}`);
    },
  };
  let clock = 0;
  const sleepFn = async milliseconds => { clock += Math.max(1, milliseconds); };
  const now = () => clock;
  const fetchImpl = async endpoint => {
    if (endpoint.startsWith('http://127.0.0.1:')) return {status: 401};
    const statuses = generation === 0 ? oldPublicStatuses : newPublicStatuses;
    const check = publicChecks.get(generation) ?? 0;
    publicChecks.set(generation, check + 1);
    return {status: statuses[Math.min(check, statuses.length - 1)]};
  };
  return {calls, runner, fetchImpl, sleepFn, now};
}

test('stale quick-tunnel URL is recovered once and pairing uses the new URL', async () => {
  const fixture = quickTunnelFixture({oldPublicStatuses: [503], newPublicStatuses: [401]});
  const progress = [];
  const result = await preparePairing(
    {port: 8787},
    {
      ...fixture,
      timeoutMs: 20,
      intervalMs: 5,
      onProgress: message => progress.push(message),
    },
  );
  assert.equal(result, 'https://new-name.trycloudflare.com');
  const restarts = fixture.calls.filter(call => call.command === 'systemctl' && call.args.includes('restart'));
  assert.equal(restarts.length, 1);
  assert.ok(progress.some(message => /retrying once/i.test(message)));
  const journalInvocations = fixture.calls
    .filter(call => call.command === 'journalctl')
    .map(call => call.args.find(value => value.startsWith('_SYSTEMD_INVOCATION_ID=')));
  assert.ok(journalInvocations.includes('_SYSTEMD_INVOCATION_ID=old-tunnel-invocation-12345678'));
  assert.ok(journalInvocations.includes('_SYSTEMD_INVOCATION_ID=new-tunnel-invocation-12345678'));
});

test('quick-tunnel recovery stops after one failed retry with a useful error', async () => {
  const fixture = quickTunnelFixture({oldPublicStatuses: [503], newPublicStatuses: [502]});
  const progress = [];
  await assert.rejects(
    preparePairing(
      {port: 8787},
      {
        ...fixture,
        timeoutMs: 20,
        intervalMs: 5,
        onProgress: message => progress.push(message),
      },
    ),
    error => /after one restart/.test(error.message) && /HTTP status: 502/.test(error.message),
  );
  assert.equal(fixture.calls.filter(call => call.command === 'systemctl' && call.args.includes('restart')).length, 1);
  assert.equal(progress.filter(message => /retrying once/i.test(message)).length, 1);
});

test('explicit public URL failure never restarts the quick tunnel', async () => {
  const calls = [];
  let clock = 0;
  const runner = {async exec(command, args) { calls.push({command, args}); return 'active\nfixture-invocation-12345678\n'; }};
  const result = preparePairing(
    {port: 8787, publicUrl: 'https://configured.example.test'},
    {
      runner,
      fetchImpl: async endpoint => endpoint.startsWith('http://127.0.0.1:') ? {status: 401} : {status: 503},
      timeoutMs: 20,
      intervalMs: 5,
      sleepFn: async milliseconds => { clock += Math.max(1, milliseconds); },
      now: () => clock,
    },
  );
  await assert.rejects(result, /configured public URL/);
  assert.equal(calls.length, 0);
});

test('transient quick-tunnel startup failure does not trigger a restart', async () => {
  const fixture = quickTunnelFixture({oldPublicStatuses: [503, 401]});
  // The first public check fails, then the same invocation becomes healthy.
  const result = await preparePairing(
    {port: 8787},
    {...fixture, timeoutMs: 20, intervalMs: 5},
  );
  assert.equal(result, 'https://old-name.trycloudflare.com');
  assert.equal(fixture.calls.filter(call => call.command === 'systemctl' && call.args.includes('restart')).length, 0);
});

test('terminal renderer keeps a four-module quiet zone and falls back when narrow', async () => {
  const fakeQr = {create: () => ({modules: {size: 5, data: [
    false, false, false, false, false,
    false, true, true, true, false,
    false, true, false, true, false,
    false, true, true, true, false,
    false, false, false, false, false,
  ]}})};
  const rendered = await renderPairingQr('fixture', {qrCode: fakeQr, columns: 100});
  assert.equal(rendered.manual, false);
  const lines = rendered.qr.split('\n');
  assert.equal(lines.length, 7);
  assert.equal(lines[0].replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '').length, 13);
  assert.equal((await renderPairingQr('fixture', {qrCode: fakeQr, columns: 10})).manual, true);
});

test('pairing details expose a future expiry and 32-character code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-pair-test-'));
  try {
    const store = new Store(dir);
    const details = store.pairCodeDetails();
    assert.match(details.code, /^[0-9a-f]{32}$/);
    assert.ok(details.expires > Math.floor(Date.now() / 1000));
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
