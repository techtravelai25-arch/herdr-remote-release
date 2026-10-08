import fs from 'node:fs';
import path from 'node:path';

// Herdr does not always report a Codex pane's thread. Codex records every thread in its state database, so a pane can
// be matched by directory plus the thread name Codex shows in the pane title. Anything ambiguous returns null and the
// phone falls back to terminal text rather than showing the wrong conversation.
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
const titleParts = title => String(title ?? '').split(' | ').map(part => part.replace(/\.\.\.$|…$/, '').trim()).filter(Boolean);

export async function codexSessionFromState(pane, home) {
  if (pane?.agent !== 'codex' || pane.agent_session || !home) return pane?.agent_session ?? null;
  const codexHome = path.join(home, '.codex');
  let db;
  try {
    const file = stateDatabase(codexHome);
    if (!file) return null;
    const {DatabaseSync} = await import('node:sqlite');
    db = new DatabaseSync(file, {readOnly: true});
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250');
    const cwds = [...new Set([pane.foreground_cwd, pane.cwd].filter(value => typeof value === 'string' && value))];
    if (!cwds.length) return null;
    const rows = db.prepare(`SELECT id,name,title,rollout_path FROM threads WHERE archived=0 AND thread_source='user' AND cwd IN (${cwds.map(() => '?').join(',')})`).all(...cwds);
    const parts = titleParts(pane.terminal_title_stripped ?? pane.terminal_title).map(part => part.toLowerCase());
    const named = rows.filter(row => [row.name, row.title].some(value => typeof value === 'string' && value.trim() && parts.includes(value.trim().toLowerCase())));
    // A directory alone never identifies the pane's conversation, including when Codex has yet to record a new thread.
    // Inspect every matching thread: a recent-row limit could conceal an older duplicate title.
    if (named.length !== 1) return null;
    const root = fs.realpathSync(path.join(codexHome, 'sessions'));
    const rollout = typeof named[0].rollout_path === 'string' ? named[0].rollout_path : '';
    if (!rollout.endsWith('.jsonl') || !path.resolve(rollout).startsWith(root + path.sep)) return null;
    return {agent: 'codex', kind: 'path', source: 'state:codex', value: path.resolve(rollout)};
  } catch { return null; } finally { try { db?.close(); } catch { /* Already closed. */ } }
}
