import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {recordAndroidDownload, cleanupDownloadMetrics} from '../src/download-metrics.js';

function setup(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL('../migrations/0007_download_metrics.sql', import.meta.url), 'utf8'));
  const prepare = (sql, args = []) => ({
    bind: (...values) => prepare(sql, values),
    async run() { return sqlite.prepare(sql).run(...args); },
    async first() { return sqlite.prepare(sql).get(...args) ?? null; },
    async all() { return {results: sqlite.prepare(sql).all(...args)}; },
  });
  return {sqlite, env: {DB: {prepare}}};
}

const request = (path = '/v1/app-update/apk', method = 'GET') =>
  new Request('https://remote.example' + path, {method});
const response = (status = 200, type = 'application/vnd.android.package-archive') =>
  new Response(status === 304 ? null : 'apk bytes', {status, headers: {'Content-Type': type}});

test('counts only successful actual APK GET responses', async t => {
  const {env, sqlite} = setup(t);
  const day = Date.parse('2026-10-01T12:00:00Z');
  for (const [req, res] of [
    [request('/download'), response(200, 'text/html')],
    [request('/'), response(200, 'text/html')],
    [request('/v1/app-update'), response(200, 'application/json')],
    [request('/v1/app-update/apk', 'HEAD'), new Response(null, {status: 200, headers: {'Content-Type': 'application/vnd.android.package-archive'}})],
    [request('/v1/app-update/apk?file=anything'), response()],
    [request('/v1/app-update/apk'), response(503)],
    [request('/v1/app-update/apk'), response(200, 'text/html')],
    [request('/v1/app-update/apk'), new Response(null, {status: 200, headers: {'Content-Type': 'application/vnd.android.package-archive'}})],
  ]) assert.equal(await recordAndroidDownload(env, res, req, day), false);
  assert.equal(await recordAndroidDownload(env, response(200), request(), day), true);
  assert.equal(await recordAndroidDownload(env, response(206), request(), day), true);
  assert.deepEqual(sqlite.prepare('SELECT day, download_count FROM android_download_daily').all().map(row => ({...row})),
    [{day: '2026-10-01', download_count: 2}]);
});

test('atomic increments retain all concurrent download requests', async t => {
  const {env, sqlite} = setup(t);
  const day = Date.parse('2026-10-01T12:00:00Z');
  await Promise.all(Array.from({length: 100}, () => recordAndroidDownload(env, response(), request(), day)));
  assert.equal(sqlite.prepare('SELECT download_count FROM android_download_daily').get().download_count, 100);
});

test('cleanup uses UTC boundaries and keeps exactly 90 days', async t => {
  const {env, sqlite} = setup(t);
  for (const instant of ['2026-06-30T23:59:59Z', '2026-07-01T00:00:00Z', '2026-09-30T23:59:59Z', '2026-10-01T00:00:00Z'])
    await recordAndroidDownload(env, response(), request(), Date.parse(instant));
  await cleanupDownloadMetrics(env, Date.parse('2026-10-01T12:00:00Z'));
  assert.deepEqual(sqlite.prepare('SELECT day FROM android_download_daily ORDER BY day').all().map(row => row.day),
    ['2026-09-30', '2026-10-01']);
});
