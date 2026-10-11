import fs from 'node:fs';
import path from 'node:path';

function stateDatabase(codexHome) {
  let best = null;
  try {
    for (const name of fs.readdirSync(codexHome)) {
      const match = /^state_(\d+)\.sqlite$/.exec(name);
      if (match && (!best || Number(match[1]) > best.version)) best = {version: Number(match[1]), file: path.join(codexHome, name)};
    }
  } catch { return null; }
  return best?.file ?? null;
}
const titleParts = title => String(title ?? '').split(' | ').map(part => part.replace(/\.\.\.$|…$/, '').trim().toLowerCase()).filter(Boolean);
const validRollout = (codexHome, value) => {
  try {
    const root = fs.realpathSync(path.join(codexHome, 'sessions'));
    const rollout = path.resolve(value);
    return value.endsWith('.jsonl') && rollout.startsWith(root + path.sep) ? rollout : null;
  } catch { return null; }
};
const sameSession = (reported, row) => reported?.kind === 'id' ? reported.value === row.id
  : reported?.kind === 'path' ? path.resolve(reported.value) === path.resolve(row.rollout_path) : false;

// A title identifies a native row only when it is unique in the pane's directory.
// The process owner adds foreground PID/start-time evidence before publishing it.
export async function resolveCodexSession(pane, home, processSessionId = null) {
  const reported = pane?.agent_session ?? null;
  if (pane?.agent !== 'codex' || !home) return {state:'unverified',reason:'agent_or_home_missing',session:null};
  const codexHome = path.join(home, '.codex');
  const file = stateDatabase(codexHome);
  if (!file) return {state:'unverified',reason:'native_db_missing',session:null};
  const cwds = [...new Set([pane.foreground_cwd,pane.cwd].filter(value => typeof value === 'string' && value))];
  if (!cwds.length) return {state:'unverified',reason:'pane_directory_missing',session:null};
  let db;
  try {
    const {DatabaseSync} = await import('node:sqlite');
    db = new DatabaseSync(file,{readOnly:true});
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250');
    const rows = db.prepare(`SELECT id,name,title,rollout_path,cwd FROM threads WHERE archived=0 AND thread_source='user' AND cwd IN (${cwds.map(()=>'?').join(',')})`).all(...cwds);
    const parts = titleParts(pane.terminal_title_stripped ?? pane.terminal_title);
    const named = rows.filter(row => [row.name,row.title].some(value => typeof value === 'string' && value.trim() && parts.includes(value.trim().toLowerCase())));
    const process = processSessionId && rows.find(row => row.id === processSessionId);
    let row = null;
    let reason = null;
    if (processSessionId) {
      if (!process) return {state:'conflict',reason:'process_session_missing',session:null};
      row = process; reason = 'process_argument_native_row';
    } else if (named.length === 1) {
      // Recovery evidence: the native row agrees with the title and directory,
      // but neither one alone ties that row to the foreground Codex PID.
      row = named[0]; reason = 'recovered_title_native_row';
    } else if (named.length > 1) return {state:'unverified',reason:'ambiguous_native_title',session:null};
    else return {state:'unverified',reason:reported?'reported_without_native_title':'native_title_missing',session:null};
    const rollout = validRollout(codexHome,row.rollout_path);
    if (!rollout) return {state:'unverified',reason:'native_rollout_invalid',session:null};
    const session = {agent:'codex',kind:'path',source:'state:codex',value:rollout};
    if (reported && !sameSession(reported,row)) return {state:'conflict',reason:'reported_session_conflicts_with_native',session,sessionId:row.id};
    return {state:'verified',reason,session,sessionId:row.id};
  } catch { return {state:'unverified',reason:'native_db_unreadable',session:null}; }
  finally { try { db?.close(); } catch { /* Already closed. */ } }
}

// Legacy direct readers receive only a session backed by current native evidence.
export async function codexSessionFromState(pane,home) {
  if (pane?.binding) return pane.binding.state === 'verified' ? pane.agent_session ?? null : null;
  const result=await resolveCodexSession(pane,home);
  return result.state==='verified'?result.session:null;
}
