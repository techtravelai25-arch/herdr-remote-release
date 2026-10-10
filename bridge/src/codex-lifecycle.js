import fs from 'node:fs';
import path from 'node:path';
import {codexSessionFromState} from './codex-session.js';

const MAX_TAIL_BYTES = 2 * 1024 * 1024;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const terminalEvents = new Set(['task_complete', 'turn_aborted']);

function sessionFile(root, session) {
  if (session.kind === 'path') return path.resolve(session.value);
  if (session.kind !== 'id' || !SESSION_ID.test(session.value)) return null;
  const suffix = `-${session.value.toLowerCase()}.jsonl`;
  let inspected = 0, found = null;
  function walk(folder, depth) {
    const directory = fs.opendirSync(folder);
    try {
      let entry;
      while ((entry = directory.readSync())) {
        if (++inspected > 10000) throw Error('session_search_limit');
        const file = path.join(folder, entry.name);
        const matches = entry.name.startsWith('rollout-') && entry.name.toLowerCase().endsWith(suffix);
        if (matches) {
          if (!entry.isFile() || found) throw Error('unsafe_or_ambiguous_session');
          found = file;
        } else if (entry.isDirectory()) {
          // A skipped deeper directory could contain a duplicate ID, so do not use a partial search.
          if (depth >= 4) throw Error('session_search_depth');
          walk(file, depth + 1);
        }
        // Symbolic-link directories are never followed.
      }
    } finally { directory.closeSync(); }
  }
  walk(root, 0);
  return found;
}

// Read only Codex's native lifecycle records. Reply text and terminal inactivity are not completion evidence.
// A missing, unsafe, truncated, or ambiguous log leaves Herdr's own status in charge.
export function readCodexLifecycle(session, home, {maxBytes = MAX_TAIL_BYTES} = {}) {
  if (!home || !session || (session.agent && session.agent !== 'codex') || typeof session.value !== 'string') return null;
  let fd;
  try {
    const requestedRoot = path.resolve(home, '.codex', 'sessions');
    const root = fs.realpathSync(requestedRoot);
    if (root !== requestedRoot) return null;
    const file = sessionFile(root, session);
    if (!file) return null;
    if (!file.endsWith('.jsonl') || !file.startsWith(root + path.sep) || fs.realpathSync(file) !== file) return null;
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.nlink !== 1) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino) return null;
    // Linux's descriptor path closes the parent-directory replacement race between realpath and open.
    if (process.platform === 'linux' && fs.realpathSync(`/proc/self/fd/${fd}`) !== file) return null;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 64) return null;
    const length = Math.min(stat.size, maxBytes, MAX_TAIL_BYTES);
    if (!length) return null;
    const start = stat.size - length;
    const bytes = Buffer.alloc(length);
    if (fs.readSync(fd, bytes, 0, length, start) !== length) return null;
    // A partially appended record could be a newer task_started. Never reuse an older completion in that case.
    if (bytes[length - 1] !== 10) return null;
    let text = bytes.toString('utf8');
    if (start) {
      // The byte before the tail tells us whether its first line is complete.
      const previous = Buffer.alloc(1);
      if (fs.readSync(fd, previous, 0, 1, start - 1) !== 1) return null;
      if (previous[0] !== 10) text = text.slice(text.indexOf('\n') + 1);
    }
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) return null;
    let latest = null;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { return null; }
      if (record?.type !== 'event_msg') continue;
      const type = record.payload?.type;
      if (typeof type !== 'string' || !type) return null;
      if (type !== 'task_started' && !terminalEvents.has(type)) continue;
      const turnId = record.payload?.turn_id;
      const timestamp = Date.parse(record.timestamp);
      if (typeof turnId !== 'string' || !turnId.trim() || turnId.length > 256 || typeof record.timestamp !== 'string' || !Number.isFinite(timestamp)) return null;
      if (type === 'task_started') {
        if (latest && timestamp < latest.timestamp) return null;
        latest = {state: 'active', turnId, timestamp, startedAt: timestamp};
      } else if (latest?.turnId === turnId) {
        if (timestamp < latest.timestamp) return null;
        latest = {...latest, state: type === 'task_complete' ? 'complete' : 'aborted', timestamp};
      } else if (latest && latest.state !== 'active') {
        return null;
      } else if (!latest) {
        // Long turns can push their start outside the bounded tail. A native terminal event still identifies
        // the completed turn; callers must not use it to settle a later accepted input without its start.
        latest = {state: type === 'task_complete' ? 'complete' : 'aborted', turnId, timestamp, startedAt: null};
      }
      // A terminal event for an older turn cannot finish the latest started turn.
    }
    const settled = fs.fstatSync(fd);
    if (settled.size !== stat.size || settled.mtimeMs !== stat.mtimeMs || settled.ctimeMs !== stat.ctimeMs) return null;
    return latest;
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* Already closed. */ } }
}

export async function observeCodexLifecycle(pane, home) {
  if (pane?.agent !== 'codex') return null;
  const session = await codexSessionFromState(pane, home);
  return session ? {session, lifecycle: readCodexLifecycle(session, home)} : null;
}
