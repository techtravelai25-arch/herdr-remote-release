import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {BridgeError} from './herdr.js';

const WINDOW = 2 * 1024 * 1024;
const PAGE_BYTES = 64 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = value => createHash('sha256').update(value).digest('hex');
const clip = value => typeof value === 'string' ? value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(0, 8000) : '';
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const unavailable = reason => ({available:false, source:'terminal', messages:[], hasMore:false, reason});
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function cursorValue(value, identity) {
  if (!value) return null;
  try {
    if (typeof value !== 'string' || value.length > 512 || !/^[\w-]+$/.test(value)) throw Error();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (parsed.identity !== identity || !Number.isSafeInteger(parsed.before) || parsed.before < 0) throw Error();
    return parsed;
  } catch { throw new BridgeError('history_changed', 'The conversation changed. Refresh history.', 409); }
}
function textBlocks(content) {
  if (typeof content === 'string') return clip(content);
  if (!Array.isArray(content)) return '';
  return clip(content.map(block => {
    if (['text','input_text','output_text'].includes(block?.type)) return block.text || '';
    if (block?.type === 'tool_use') return `${block.name || 'Tool'}\n${JSON.stringify(block.input || {})}`;
    if (block?.type === 'tool_result') return textBlocks(block.content);
    return ''; // Images, hidden reasoning and provider metadata are not text.
  }).filter(Boolean).join('\n\n'));
}
/** Parse documented transcript records, never treat terminal heuristics as history. */
export function parseHistoryRecord(record, source, id) {
  let role, text, toolName;
  if (source === 'claude') {
    if (!['user','assistant'].includes(record.type) || record.isSidechain) return null;
    role = record.message?.role || record.type;
    const content = record.message?.content;
    text = textBlocks(content);
    if (Array.isArray(content)) {
      const tool = content.find(b => b.type === 'tool_use');
      if (tool) toolName = clip(tool.name);
      if (content.length && content.every(b => b.type === 'tool_result')) role = 'tool';
    }
  } else if (source === 'codex') {
    if (record.type !== 'response_item') return null;
    const item = record.payload;
    if (item?.type === 'message' && ['user','assistant'].includes(item.role)) { role = item.role; text = textBlocks(item.content); }
    else if (['function_call','custom_tool_call'].includes(item?.type)) { role = 'tool'; toolName = clip(item.name); text = clip(item.arguments || item.input); }
    else if (['function_call_output','custom_tool_call_output'].includes(item?.type)) { role = 'tool'; text = clip(typeof item.output === 'string' ? item.output : JSON.stringify(item.output)); }
    else return null;
  }
  if (!text || !['user','assistant','tool','system'].includes(role)) return null;
  return {id, role, text, timestamp:date(record.timestamp), ...(toolName ? {toolName} : {})};
}
function safeOpen(file, root) {
  const canonicalRoot = fs.realpathSync(root), canonical = fs.realpathSync(file);
  if (!canonical.startsWith(canonicalRoot + path.sep) || path.resolve(file) !== canonical) throw Error('outside_root');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(`/proc/self/fd/${fd}`) !== canonical) throw Error('changed');
    return {fd, stat};
  } catch (error) { fs.closeSync(fd); throw error; }
}
function locate(root, session, source) {
  if (session.kind === 'path') return typeof session.value === 'string' && session.value.endsWith('.jsonl') ? path.resolve(session.value) : null;
  if (!uuid.test(session.value)) return null;
  const suffix = `${session.value}.jsonl`;
  let inspected = 0;
  function walk(folder, depth) {
    if (depth > 4 || inspected > 10000) return null;
    let entries; try { entries = fs.readdirSync(folder, {withFileTypes:true}); } catch { return null; }
    for (const entry of entries) {
      if (++inspected > 10000) break;
      if (entry.isSymbolicLink()) continue;
      const file = path.join(folder, entry.name);
      if (entry.isFile() && (source === 'claude' ? entry.name === suffix : entry.name.startsWith('rollout-') && entry.name.endsWith('-' + suffix))) return file;
      if (entry.isDirectory()) { const found = walk(file, depth + 1); if (found) return found; }
    }
    return null;
  }
  return walk(root, 0);
}
export function createHistory(config) {
  const roots = {
    claude:config.historyRoots?.claude || path.join(config.homeDirectory, '.claude/projects'),
    codex:config.historyRoots?.codex || path.join(config.homeDirectory, '.codex/sessions'),
    opencode:config.historyRoots?.opencode || path.join(config.homeDirectory, '.local/share/opencode'),
  };
  return {async read(pane, cursor) {
    if (config.structuredHistory === false) return unavailable('History is disabled on this laptop.');
    const source = pane.agent, session = pane.agent_session;
    if (!Object.hasOwn(roots, source)) return unavailable('This agent does not provide supported structured history.');
    if (!session || !['id','path'].includes(session.kind) || typeof session.value !== 'string' || (session.agent && session.agent !== source)) return unavailable('Herdr has not reported a conversation identity yet. Live terminal output remains available.');
    if (source === 'opencode') return openCode(roots.opencode, session, cursor);
    let opened;
    try {
      const file = locate(roots[source], session, source);
      if (!file) return unavailable('The conversation file is not available yet.');
      opened = safeOpen(file, roots[source]);
      const {fd, stat} = opened;
      const identity = digest(JSON.stringify([source, session, stat.dev, stat.ino]));
      const decoded = cursorValue(cursor, identity), end = decoded?.before ?? stat.size;
      if (end > stat.size) throw new BridgeError('history_changed', 'The history file changed. Refresh history.', 409);
      const start = Math.max(0, end - WINDOW), bytes = Buffer.alloc(end - start);
      fs.readSync(fd, bytes, 0, bytes.length, start);
      let position = 0;
      if (start > 0) { const newline = bytes.indexOf(10); position = newline < 0 ? bytes.length : newline + 1; }
      const messages = [];
      while (position < bytes.length) {
        const newline = bytes.indexOf(10, position);
        if (newline < 0) break; // A writer may still be appending this record.
        try {
          const record = JSON.parse(bytes.subarray(position, newline).toString('utf8'));
          const message = parseHistoryRecord(record, source, digest(`${identity}:${start+position}`).slice(0,32));
          if (message) messages.push({message, offset:start+position});
        } catch { /* Ignore malformed records without exposing their contents. */ }
        position = newline + 1;
      }
      const selected = []; let size = 0;
      for (let index = messages.length - 1; index >= 0 && selected.length < 40; index--) {
        const item = messages[index], length = Buffer.byteLength(JSON.stringify(item.message));
        if (size + length > PAGE_BYTES) break;
        selected.unshift(item); size += length;
      }
      const before = selected[0]?.offset ?? start;
      const hasMore = before > 0 && (start > 0 || messages.length > selected.length);
      return {available:true, source, messages:selected.map(item=>item.message), hasMore,
        ...(hasMore ? {nextCursor:encode({identity,before})} : {})};
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      return unavailable('The conversation file could not be read safely. Live terminal output remains available.');
    } finally { if (opened) fs.closeSync(opened.fd); }
  }};
}
async function openCode(root, session, cursor) {
  if (session.kind !== 'id' || !/^ses_[A-Za-z0-9]{8,80}$/.test(session.value)) return unavailable('Herdr has not reported a supported OpenCode session ID.');
  let opened, db;
  try {
    const file = path.join(root, 'opencode.db');
    opened = safeOpen(file, root);
    const identity = digest(`${session.value}:${opened.stat.dev}:${opened.stat.ino}`);
    const decoded = cursorValue(cursor, identity);
    const {DatabaseSync} = await import('node:sqlite');
    db = new DatabaseSync(file, {readOnly:true});
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250');
    // Keyset pagination is stable while the agent appends new messages.
    const rows = db.prepare("SELECT id,time_created,CASE WHEN json_valid(data) THEN json_extract(data,'$.role') END AS role FROM message WHERE session_id=? AND (time_created<? OR (time_created=? AND id<?)) ORDER BY time_created DESC,id DESC LIMIT 41")
      .all(session.value, decoded?.before ?? Number.MAX_SAFE_INTEGER, decoded?.before ?? Number.MAX_SAFE_INTEGER, decoded?.lastId ?? '\uffff');
    const messages=[]; let size=0, consumed=0, last;
    for (const row of rows.slice(0,40)) {
      // Clip extracted fields, never a serialized JSON record. Malformed neighbors
      // still advance the cursor but cannot hide valid messages on the page.
      if(!['user','assistant'].includes(row.role)){consumed++;last=row;continue;}
      const parts=db.prepare(`SELECT
        CASE WHEN json_valid(data) THEN json_extract(data,'$.type') END AS type,
        CASE WHEN json_valid(data) THEN substr(json_extract(data,'$.text'),1,8001) END AS text,
        CASE WHEN json_valid(data) THEN substr(json_extract(data,'$.tool'),1,120) END AS tool,
        CASE WHEN json_valid(data) THEN substr(COALESCE(json_extract(data,'$.state.output'),json_extract(data,'$.state.error')),1,8001) END AS output
        FROM part WHERE session_id=? AND message_id=? ORDER BY time_created,id LIMIT 100`).all(session.value,row.id);
      const rawText=parts.map(p=>p.type==='text'&&typeof p.text==='string'?p.text:p.type==='tool'?`${p.tool || 'Tool'}\n${typeof p.output==='string'?p.output:''}`:'').filter(Boolean).join('\n\n');
      const text=clip(rawText);
      const message={id:row.id,role:row.role,text,timestamp:date(row.time_created),...(rawText.length>8000?{truncated:true}:{})};
      const length=Buffer.byteLength(JSON.stringify(message));
      if(size+length>PAGE_BYTES)break;
      size+=length;consumed++;last=row;if(text)messages.unshift(message);
    }
    const hasMore=rows.length>consumed;
    return {available:true,source:'opencode',messages,hasMore,...(hasMore&&last?{nextCursor:encode({identity,before:last.time_created,lastId:last.id})}:{})};
  } catch (error) {
    if(error instanceof BridgeError)throw error;
    return unavailable('OpenCode history is unavailable for this database version. Live terminal output remains available.');
  } finally { db?.close(); if(opened)fs.closeSync(opened.fd); }
}
