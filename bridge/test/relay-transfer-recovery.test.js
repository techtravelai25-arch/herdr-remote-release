import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createTransfers} from '../src/relay-transfers.js';
import {Store} from '../src/store.js';

const childSource = `
const {Store} = await import(process.argv[1]);
const {createTransfers} = await import(process.argv[2]);
const store = new Store(process.argv[3]);
const marker = process.argv[4];
const token = store.pair(store.pairCode(), 'test-device').token;
const transfers = createTransfers({store, port: 1234});
const call = (path, body) => transfers.handle({
  method: 'POST', path, headers: {authorization: 'Bearer ' + token},
  body: Buffer.from(JSON.stringify(body)),
});
const created = await call('/v1/relay-transfer/upload', {paneId: 'test', name: 'staged.txt', size: Buffer.byteLength(marker)});
if (created.status !== 200) throw Error('Could not create staged transfer');
const id = JSON.parse(created.bytes).transferId;
const added = await call('/v1/relay-transfer/upload/' + id, {offset: 0, data: Buffer.from(marker).toString('base64url')});
if (added.status !== 200) throw Error('Could not stage transfer bytes');
process.stdout.write('READY\\n');
setInterval(() => {}, 1000);
`;

function markerFile(root, marker) {
  for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = markerFile(file, marker);
      if (nested) return nested;
    }
    if (entry.isFile() && fs.readFileSync(file).includes(marker)) return file;
  }
  return null;
}

async function startStagedTransfer(children, root, marker) {
  const child = spawn(process.execPath, [
    '--input-type=module', '-e', childSource,
    new URL('../src/store.js', import.meta.url).href,
    new URL('../src/relay-transfers.js', import.meta.url).href,
    path.join(root, 'state'), marker,
  ], {env: {...process.env, TMPDIR: root}, stdio: ['ignore', 'pipe', 'pipe']});
  children.push(child);
  let output = '', errors = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', data => { errors += data; });
  child.stdout.setEncoding('utf8');
  let timeout;
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        child.stdout.on('data', data => { output += data; if (output.includes('READY\n')) resolve(); });
        child.once('exit', code => reject(Error(`Transfer child exited ${code}: ${errors}`)));
      }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(Error(`Transfer child did not start: ${errors}`)), 5000); }),
    ]);
  } finally { clearTimeout(timeout); }
  const staged = markerFile(root, marker);
  assert.ok(staged, 'transfer bytes should be staged');
  assert.equal(fs.statSync(path.dirname(staged)).mode & 0o077, 0, 'staging directory must be private');
  assert.equal(fs.statSync(staged).mode & 0o077, 0, 'staged file must be private');
  return child;
}

test('relay startup recovers crashed staged files and preserves a live session', {skip: process.platform !== 'linux'}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-recovery-'));
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    fs.rmSync(root, {recursive: true, force: true});
  });
  const live = 'live-staged-transfer-' + Date.now();
  const orphan = 'crashed-staged-transfer-' + Date.now();
  await startStagedTransfer(children, root, live);
  const crashed = await startStagedTransfer(children, root, orphan);
  const exited = once(crashed, 'exit');
  crashed.kill('SIGKILL');
  await exited;

  const transfers = createTransfers({store: new Store(path.join(root, 'state')), port: 1234});
  t.after(() => transfers.close());
  assert.equal(markerFile(root, orphan), null, 'crashed session bytes should be removed on startup');
  assert.ok(markerFile(root, live), 'concurrent live session bytes must remain');
});

test('relay staging rejects a symlinked managed root', {skip: process.platform === 'win32'}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-staging-root-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const store = new Store(path.join(root, 'state'));
  const unrelated = path.join(root, 'unrelated');
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, 'keep.txt'), 'keep');
  fs.symlinkSync(unrelated, path.join(store.dir, 'relay-transfers'));

  assert.throws(() => createTransfers({store, port: 1234}), /not private/);
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep.txt'), 'utf8'), 'keep');
});
