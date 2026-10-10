import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readCodexLifecycle, observeCodexLifecycle} from '../src/codex-lifecycle.js';

const startTime = '2026-10-09T00:00:00.000Z';
const endTime = '2026-10-09T00:00:01.000Z';
const event = (type, turn = 'turn-a', timestamp = type === 'task_started' ? startTime : endTime) =>
  JSON.stringify({timestamp, type: 'event_msg', payload: {type, turn_id: turn}});
function fixture(t, lines) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-lifecycle-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const root = path.join(home, '.codex', 'sessions');
  fs.mkdirSync(root, {recursive: true});
  const file = path.join(root, 'rollout-test.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return {home, root, file, session: {agent: 'codex', kind: 'path', value: file}};
}

test('native matching task completion supplies metadata without response contents', t => {
  const f = fixture(t, [event('task_started'), JSON.stringify({type: 'response_item', payload: {role: 'assistant', content: 'private reply'}}), event('task_complete')]);
  assert.deepEqual(readCodexLifecycle(f.session, f.home), {state: 'complete', turnId: 'turn-a', timestamp: Date.parse(endTime), startedAt: Date.parse(startTime)});
});
test('assistant final wording does not complete a native active turn', t => {
  const f = fixture(t, [event('task_started'), JSON.stringify({type: 'response_item', payload: {role: 'assistant', phase: 'final_answer', content: 'Done!'}})]);
  assert.equal(readCodexLifecycle(f.session, f.home).state, 'active');
});
test('matching native abort is distinct from a successful completion', t => {
  const f = fixture(t, [event('task_started'), event('turn_aborted')]);
  assert.equal(readCodexLifecycle(f.session, f.home).state, 'aborted');
});
test('newer start defeats a preceding completed turn and late completion for the older turn', t => {
  const f = fixture(t, [event('task_started'), event('task_complete'), event('task_started', 'turn-b', '2026-10-09T00:00:02Z'), event('task_complete', 'turn-a', '2026-10-09T00:00:03Z')]);
  const value = readCodexLifecycle(f.session, f.home);
  assert.equal(value.state, 'active');
  assert.equal(value.turnId, 'turn-b');
});
test('native terminal event remains usable when a long turn pushes its start outside the bounded tail', t => {
  const f = fixture(t, [event('task_started'), JSON.stringify({type: 'response_item', payload: 'x'.repeat(2048)}), event('task_complete')]);
  assert.deepEqual(readCodexLifecycle(f.session, f.home, {maxBytes: 512}), {state: 'complete', turnId: 'turn-a', timestamp: Date.parse(endTime), startedAt: null});
});
test('bounded tail can establish a newer complete pair after discarding a partial first line', t => {
  const f = fixture(t, [JSON.stringify({type: 'response_item', payload: 'x'.repeat(2048)}), event('task_started'), event('task_complete')]);
  assert.equal(readCodexLifecycle(f.session, f.home, {maxBytes: 512}).state, 'complete');
});
test('terminal-only event identifies its turn, but mismatched completion after a finished turn is ambiguous', t => {
  const f = fixture(t, [event('task_complete')]);
  assert.equal(readCodexLifecycle(f.session, f.home).startedAt, null);
  fs.writeFileSync(f.file, [event('task_started'), event('task_complete'), event('task_complete', 'turn-b')].join('\n') + '\n');
  assert.equal(readCodexLifecycle(f.session, f.home), null);
});
test('incomplete appended line cannot revive an older completion', t => {
  const f = fixture(t, [event('task_started'), event('task_complete')]);
  fs.appendFileSync(f.file, '{"type":"event_msg","payload":{"type":"task_started"');
  assert.equal(readCodexLifecycle(f.session, f.home), null);
});
test('malformed JSON, missing event payload, and invalid lifecycle identity or timestamps leave status unknown', t => {
  const f = fixture(t, [event('task_started'), 'not JSON', event('task_complete')]);
  assert.equal(readCodexLifecycle(f.session, f.home), null);
  for (const invalid of [JSON.stringify({type:'event_msg'}), event('task_complete', null), event('task_complete', '', endTime), event('task_complete', 'turn-a', 'not a date'), event('task_complete', 'turn-a', '2026-10-08T23:59:59Z')]) {
    fs.writeFileSync(f.file, event('task_started') + '\n' + invalid + '\n');
    assert.equal(readCodexLifecycle(f.session, f.home), null);
  }
});
test('synchronous re-read observes a newly appended task start', t => {
  const f = fixture(t, [event('task_started'), event('task_complete')]);
  assert.equal(readCodexLifecycle(f.session, f.home).state, 'complete');
  fs.appendFileSync(f.file, event('task_started', 'turn-b', '2026-10-09T00:00:02Z') + '\n');
  assert.equal(readCodexLifecycle(f.session, f.home).state, 'active');
});
test('a task start appended during a read invalidates the older completion snapshot', t => {
  const f = fixture(t, [event('task_started'), event('task_complete')]);
  const originalRead = fs.readSync;
  let appended = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const count = originalRead(...args);
    if (!appended) {
      appended = true;
      fs.appendFileSync(f.file, event('task_started', 'turn-b', '2026-10-09T00:00:02Z') + '\n');
    }
    return count;
  });
  assert.equal(readCodexLifecycle(f.session, f.home), null);
});
test('paths outside sessions and symlinked files or parents are rejected', t => {
  const f = fixture(t, [event('task_started'), event('task_complete')]);
  const outside = path.join(f.home, 'outside.jsonl');
  fs.copyFileSync(f.file, outside);
  assert.equal(readCodexLifecycle({...f.session, value: outside}, f.home), null);
  const link = path.join(f.root, 'link.jsonl');
  fs.symlinkSync(f.file, link);
  assert.equal(readCodexLifecycle({...f.session, value: link}, f.home), null);
  const directory = path.join(f.root, 'linked');
  fs.symlinkSync(f.root, directory);
  assert.equal(readCodexLifecycle({...f.session, value: path.join(directory, 'rollout-test.jsonl')}, f.home), null);
});
test('hardlinks, directories, empty logs, unsupported sessions, and missing home are rejected', t => {
  const f = fixture(t, []);
  assert.equal(readCodexLifecycle(f.session, f.home), null);
  fs.writeFileSync(f.file, event('task_started') + '\n' + event('task_complete') + '\n');
  fs.linkSync(f.file, path.join(f.root, 'hardlink.jsonl'));
  assert.equal(readCodexLifecycle(f.session, f.home), null);
  assert.equal(readCodexLifecycle({...f.session, value: f.root}, f.home), null);
  assert.equal(readCodexLifecycle({...f.session, kind: 'id'}, f.home), null);
  assert.equal(readCodexLifecycle({...f.session, agent: 'claude'}, f.home), null);
  assert.equal(readCodexLifecycle(f.session, null), null);
});
test('async observation accepts explicit Codex path and does not inspect other agents', async t => {
  const f = fixture(t, [event('task_started'), event('task_complete')]);
  const value = await observeCodexLifecycle({agent: 'codex', agent_session: f.session}, f.home);
  assert.deepEqual(value.session, f.session);
  assert.equal(value.lifecycle.state, 'complete');
  assert.equal(await observeCodexLifecycle({agent: 'claude', agent_session: f.session}, f.home), null);
});
test('async observation finds the pane thread by state directory and title before reading lifecycle', async t => {
  const f = fixture(t, [event('task_started'), event('task_complete')]);
  const db = new DatabaseSync(path.join(f.home, '.codex', 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT, rollout_path TEXT, cwd TEXT, name TEXT, title TEXT, archived INTEGER, thread_source TEXT)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run('thread-a', f.file, '/project', 'Fix status', 'Original prompt', 0, 'user');
  db.close();
  const pane = {agent: 'codex', cwd: '/project', terminal_title_stripped: 'Fix status | project'};
  assert.equal((await observeCodexLifecycle(pane, f.home)).lifecycle.state, 'complete');
  assert.equal(await observeCodexLifecycle({...pane, terminal_title_stripped: 'Unrelated | project'}, f.home), null);
});

const sessionId = '01a11cef-0123-4567-89ab-0123456789ab';
const idSession = {agent: 'codex', kind: 'id', value: sessionId};
function namedRollout(f, folder = f.root, id = sessionId) {
  fs.mkdirSync(folder, {recursive: true});
  const file = path.join(folder, `rollout-2026-10-09T00-00-00-${id}.jsonl`);
  fs.copyFileSync(f.file, file);
  return file;
}
test('reported Codex session ID resolves its exact nested rollout and supports optional agent metadata', async t => {
  const f = fixture(t, [event('task_started'), event('task_complete')]);
  namedRollout(f, path.join(f.root, '2026', '10', '09'));
  namedRollout(f, f.root, '01a11cef-0123-4567-89ab-ffffffffffff');
  assert.equal(readCodexLifecycle(idSession, f.home).state, 'complete');
  assert.equal(readCodexLifecycle({...idSession, value: sessionId.toUpperCase()}, f.home).state, 'complete');
  const {agent, ...descriptor} = idSession;
  assert.equal((await observeCodexLifecycle({agent, agent_session: descriptor}, f.home)).lifecycle.state, 'complete');
});
test('session ID lookup rejects invalid IDs, partial suffix matches, and ambiguous duplicates', t => {
  const f = fixture(t, [event('task_started'), event('task_complete')]);
  const file = namedRollout(f);
  for (const value of ['../' + sessionId, 'not-a-uuid', sessionId.slice(1)]) {
    assert.equal(readCodexLifecycle({...idSession, value}, f.home), null);
  }
  fs.renameSync(file, path.join(f.root, `rollout-prefix-extra${sessionId}.jsonl`));
  assert.equal(readCodexLifecycle(idSession, f.home), null);
  namedRollout(f);
  namedRollout(f, path.join(f.root, 'other'));
  assert.equal(readCodexLifecycle(idSession, f.home), null);
});
test('session ID lookup never follows symlink files or directories and rejects hardlinked rollout', t => {
  const f = fixture(t, [event('task_started'), event('task_complete')]);
  const outside = path.join(f.home, 'outside');
  const file = namedRollout(f, outside);
  fs.symlinkSync(outside, path.join(f.root, 'linked-directory'));
  assert.equal(readCodexLifecycle(idSession, f.home), null);
  const link = path.join(f.root, path.basename(file));
  fs.symlinkSync(file, link);
  assert.equal(readCodexLifecycle(idSession, f.home), null);
  fs.unlinkSync(link);
  fs.linkSync(file, link);
  assert.equal(readCodexLifecycle(idSession, f.home), null);
});
test('session ID lookup rejects a symlinked sessions root', t => {
  const f = fixture(t, [event('task_started'), event('task_complete')]);
  namedRollout(f);
  const storage = path.join(f.home, 'log-storage');
  fs.renameSync(f.root, storage);
  fs.symlinkSync(storage, f.root);
  assert.equal(readCodexLifecycle(idSession, f.home), null);
});
test('session ID traversal returns unknown if deeper directories could conceal a duplicate', t => {
  const f = fixture(t, [event('task_started'), event('task_complete')]);
  namedRollout(f);
  namedRollout(f, path.join(f.root, 'one', 'two', 'three', 'four', 'five'));
  assert.equal(readCodexLifecycle(idSession, f.home), null);
});
test('session ID traversal returns unknown when the entry budget cannot exclude duplicates', t => {
  const f = fixture(t, [event('task_started'), event('task_complete')]);
  namedRollout(f);
  const folder = path.join(f.root, 'many');
  fs.mkdirSync(folder);
  for (let i = 0; i < 10000; i++) fs.writeFileSync(path.join(folder, `entry-${i}`), '');
  assert.equal(readCodexLifecycle(idSession, f.home), null);
});
