import fs from 'node:fs';
import path from 'node:path';
import {codexSessionFromState} from './codex-session.js';

const MAX_TAIL_BYTES = 2 * 1024 * 1024;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const terminalEvents = new Set(['task_complete', 'turn_aborted']);
// Structural record kinds observed in local 0.162.x rollout logs. New kinds may
// carry a turn boundary, so an older completion must not survive them silently.
const neutralRecords = new Set(['token_usage_record', 'inter_agent_communication_metadata',
  'turn_context', 'world_state', 'session_meta', 'compacted']);
const neutralEvents = new Set(['item_completed', 'token_count', 'thread_settings_applied']);
const responseItems = new Set(['reasoning', 'custom_tool_call_output', 'custom_tool_call',
  'function_call_output', 'function_call', 'message', 'agent_message', 'compaction']);

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
// A missing, unsafe, truncated, or ambiguous log cannot establish completion.
export function readCodexLifecycle(session, home, {maxBytes = MAX_TAIL_BYTES, diagnostic} = {}) {
  const fail = reason => { if (diagnostic) diagnostic.reason = reason; return null; };
  if (diagnostic) diagnostic.reason = 'native_unavailable';
  if (!home || !session || (session.agent && session.agent !== 'codex') || typeof session.value !== 'string') return fail('unknown_identity');
  let fd;
  try {
    const requestedRoot = path.resolve(home, '.codex', 'sessions');
    const root = fs.realpathSync(requestedRoot);
    if (root !== requestedRoot) return fail('unsafe_path');
    const file = sessionFile(root, session);
    if (!file) return fail('native_unavailable');
    if (!file.endsWith('.jsonl') || !file.startsWith(root + path.sep) || fs.realpathSync(file) !== file) return fail('unsafe_path');
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.nlink !== 1) return fail('unsafe_path');
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino) return fail('stale_evidence');
    // Linux's descriptor path closes the parent-directory replacement race between realpath and open.
    if (process.platform === 'linux' && fs.realpathSync(`/proc/self/fd/${fd}`) !== file) return fail('stale_evidence');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 64) return fail('unsupported_schema');
    const length = Math.min(stat.size, maxBytes, MAX_TAIL_BYTES);
    if (!length) return fail('native_unavailable');
    const start = stat.size - length;
    const bytes = Buffer.alloc(length);
    if (fs.readSync(fd, bytes, 0, length, start) !== length) return fail('stale_evidence');
    // A partially appended record could be a newer task_started. Never reuse an older completion in that case.
    if (bytes[length - 1] !== 10) return fail('partial_append');
    let text = bytes.toString('utf8');
    if (start) {
      // The byte before the tail tells us whether its first line is complete.
      const previous = Buffer.alloc(1);
      if (fs.readSync(fd, previous, 0, 1, start - 1) !== 1) return fail('stale_evidence');
      if (previous[0] !== 10) text = text.slice(text.indexOf('\n') + 1);
    }
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) return fail('stale_evidence');
    let latest = null, userAfterCompletion = false;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { return fail('unsupported_schema'); }
      if (record?.type === 'response_item') {
        const item = record.payload;
        if (!item || typeof item !== 'object' || !responseItems.has(item.type)) return fail('unsupported_schema');
        // A user message after a completed turn can precede a task_started append.
        // During that gap the older completion no longer describes the latest work.
        if (item.type === 'message' && item.role === 'user' && latest?.state === 'complete') userAfterCompletion = true;
        continue;
      }
      if (record?.type !== 'event_msg') {
        if (!neutralRecords.has(record?.type)) return fail('unsupported_schema');
        continue;
      }
      const type = record.payload?.type;
      if (typeof type !== 'string' || !type) return fail('unsupported_schema');
      if (type !== 'task_started' && !terminalEvents.has(type)) {
        if (!neutralEvents.has(type)) return fail('unsupported_schema');
        continue;
      }
      const turnId = record.payload?.turn_id;
      const timestamp = Date.parse(record.timestamp);
      if (typeof turnId !== 'string' || !turnId.trim() || turnId.length > 256 || typeof record.timestamp !== 'string' || !Number.isFinite(timestamp)) return fail('unsupported_schema');
      if (type === 'task_started') {
        if (latest && timestamp < latest.timestamp) return fail('unsupported_schema');
        latest = {state: 'active', turnId, timestamp, startedAt: timestamp};
        userAfterCompletion = false;
      } else if (latest?.turnId === turnId) {
        if (timestamp < latest.timestamp) return fail('unsupported_schema');
        latest = {...latest, state: type === 'task_complete' ? 'complete' : 'aborted', timestamp};
      } else if (latest && latest.state !== 'active') {
        return fail('unsupported_schema');
      } else if (!latest) {
        // Long turns can push their start outside the bounded tail. A native terminal event still identifies
        // the completed turn; callers must not use it to settle a later accepted input without its start.
        latest = {state: type === 'task_complete' ? 'complete' : 'aborted', turnId, timestamp, startedAt: null};
      }
      // A terminal event for an older turn cannot finish the latest started turn.
    }
    const settled = fs.fstatSync(fd);
    if (settled.size !== stat.size || settled.mtimeMs !== stat.mtimeMs || settled.ctimeMs !== stat.ctimeMs) return fail('stale_evidence');
    if (userAfterCompletion) return fail('unsupported_schema');
    if (!latest) return fail(start ? 'bounded_tail' : 'native_unavailable');
    if (diagnostic) diagnostic.reason = latest.state === 'complete' ? 'native_complete' : latest.state === 'aborted' ? 'native_aborted' : 'native_active';
    return latest;
  } catch { return fail('native_unavailable'); } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* Already closed. */ } }
}

export async function observeCodexLifecycle(pane, home) {
  if (pane?.agent !== 'codex') return null;
  const session = await codexSessionFromState(pane, home);
  return session ? {session, lifecycle: readCodexLifecycle(session, home)} : null;
}
