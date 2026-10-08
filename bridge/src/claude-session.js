import fs from 'node:fs';
import path from 'node:path';
import {codexSessionFromState} from './codex-session.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Claude Code records each running process in ~/.claude/sessions/<pid>.json.
// That lets a pane's conversation be found even when Herdr's Claude hook
// integration is not installed and no agent_session was reported.
function readRecord(home,pid) {
  const file=path.join(home,'.claude','sessions',`${pid}.json`);
  let fd;
  try {
    fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.size>65536||stat.uid!==process.getuid?.())return null;
    return JSON.parse(fs.readFileSync(fd,'utf8'));
  } catch { return null; } finally { if(fd!==undefined)fs.closeSync(fd); }
}
export async function claudeSessionFromProcess(herdr,pane,home) {
  if(pane?.agent!=='claude'||pane.agent_session||!home)return pane?.agent_session??null;
  try {
    const {process_info:info}=await herdr.call('pane.process_info',{pane_id:pane.pane_id});
    const claude=(info?.foreground_processes??[]).filter(proc=>/^claude(?:$|-)/.test(proc?.name??'')&&Number.isInteger(proc.pid));
    if(claude.length!==1)return null;
    const record=readRecord(home,claude[0].pid);
    if(!record||record.pid!==claude[0].pid||typeof record.sessionId!=='string'||!uuid.test(record.sessionId))return null;
    // A recycled PID file must describe this pane's project directory.
    const cwds=[claude[0].cwd,pane.foreground_cwd,pane.cwd].filter(Boolean);
    if(typeof record.cwd!=='string'||!cwds.includes(record.cwd))return null;
    return {agent:'claude',kind:'id',source:'process:claude',value:record.sessionId};
  } catch { return null; }
}
export async function withClaudeSession(herdr,pane,home) {
  const session=pane?.agent==='codex'?await codexSessionFromState(pane,home):await claudeSessionFromProcess(herdr,pane,home);
  return session&&!pane.agent_session?{...pane,agent_session:session}:pane;
}
