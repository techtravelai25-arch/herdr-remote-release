import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {resolveCodexSession} from './codex-session.js';
import {readCodexLifecycle} from './codex-lifecycle.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const verified=new Map();
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

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
function processStart(pid) {
  try {
    const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');
    return stat.slice(stat.lastIndexOf(')')+2).split(' ')[19] || null;
  } catch { return null; }
}
function processArgumentSession(proc) {
  const args=Array.isArray(proc.argv)?proc.argv:[];
  const resume=args.indexOf('resume');
  const id=resume>=0?args[resume+1]:null;
  return typeof id==='string'&&uuid.test(id)?id:null;
}
function matchingProcess(info,agent) {
  const pattern=agent==='codex'?/^codex(?:$|-)/:/^claude(?:$|-)/;
  const matches=(info?.foreground_processes??[]).filter(proc=>pattern.test(proc?.name??'')&&Number.isInteger(proc.pid));
  return matches.length===1?matches[0]:null;
}
function samePane(a,b) {
  return a?.pane_id===b?.pane_id&&a?.terminal_id===b?.terminal_id&&a?.agent===b?.agent&&
    a?.cwd===b?.cwd&&a?.foreground_cwd===b?.foreground_cwd&&
    (a?.terminal_title_stripped??a?.terminal_title)===(b?.terminal_title_stripped??b?.terminal_title)&&
    JSON.stringify(a?.agent_session??null)===JSON.stringify(b?.agent_session??null);
}
function sameProcess(a,b) {
  return a?.pid===b?.pid&&a?.name===b?.name&&a?.cwd===b?.cwd&&
    JSON.stringify(a?.argv??null)===JSON.stringify(b?.argv??null);
}
function recordIdentity(record) {
  return record?JSON.stringify([record.pid,record.procStart,record.cwd,record.sessionId]):null;
}
function resultPane(pane,state,reason,generation,session=null,sessionId=null) {
  return {...pane,agent_session:state==='verified'?session:null,
    binding:{state,reason,generation:hash([generation,state==='verified'?sessionId:state]),
      sessionId:state==='verified'?sessionId:undefined}};
}
function cacheKey(pane,home) {return JSON.stringify([home,pane.pane_id,pane.agent]);}

export async function claudeSessionFromProcess(herdr,pane,home) {
  if(pane?.agent!=='claude'||!home)return null;
  try {
    const {process_info:info}=await herdr.call('pane.process_info',{pane_id:pane.pane_id});
    const claude=matchingProcess(info,'claude');
    if(!claude)return null;
    const record=readRecord(home,claude.pid);
    const start=processStart(claude.pid);
    if(!record||!start||record.procStart!==start||record.pid!==claude.pid||
      typeof record.sessionId!=='string'||!uuid.test(record.sessionId))return null;
    const cwds=[claude.cwd,pane.foreground_cwd,pane.cwd].filter(Boolean);
    if(typeof record.cwd!=='string'||!cwds.includes(record.cwd))return null;
    return {agent:'claude',kind:'id',source:'process:claude',value:record.sessionId};
  } catch { return null; }
}

// This is the single bridge binding boundary for structured history and native
// lifecycle. Uncertain new reports remain visible as terminal text only.
export async function withClaudeSession(herdr,pane,home) {
  if(!['codex','claude'].includes(pane?.agent))return pane;
  const key=cacheKey(pane,home);
  const prior=verified.get(key);
  let info;
  try { ({process_info:info}=await herdr.call('pane.process_info',{pane_id:pane.pane_id})); }
  catch { return resultPane(pane,'unverified','process_info_unavailable',hash([pane.pane_id,pane.terminal_id,'unknown'])); }
  const proc=matchingProcess(info,pane.agent);
  if(!proc)return resultPane(pane,'unverified','foreground_agent_ambiguous',hash([pane.pane_id,pane.terminal_id,'unknown']));
  const start=processStart(proc.pid);
  const generation=hash([pane.pane_id,pane.terminal_id,pane.agent,proc.pid,start]);
  const generationMatches=prior?.generation===generation;
  if(!start)return resultPane(pane,'unverified','process_start_unavailable',generation);
  const cwds=[pane.foreground_cwd,pane.cwd].filter(Boolean);
  if(!proc.cwd||!cwds.includes(proc.cwd))return resultPane(pane,'conflict','foreground_directory_conflict',generation);
  let resolution;
  let initialRecord;
  if(pane.agent==='codex') {
    resolution=await resolveCodexSession(pane,home,processArgumentSession(proc));
  } else {
    const record=readRecord(home,proc.pid);
    initialRecord=record;
    if(!record)resolution={state:'unverified',reason:'claude_process_record_missing'};
    else if(record.pid!==proc.pid||record.procStart!==start||!uuid.test(record.sessionId??'')||record.cwd!==proc.cwd)
      resolution={state:'conflict',reason:'claude_process_record_conflict'};
    else {
      const session={agent:'claude',kind:'id',source:'process:claude',value:record.sessionId};
      resolution=pane.agent_session&&pane.agent_session.value!==record.sessionId
        ? {state:'conflict',reason:'reported_session_conflicts_with_process',session,sessionId:record.sessionId}
        : {state:'verified',reason:'foreground_process_record',session,sessionId:record.sessionId};
    }
  }
  // The foreground process can change while SQLite or a record is read.
  try {
    const {pane:latest}=await herdr.call('pane.get',{pane_id:pane.pane_id});
    if(!samePane(pane,latest))return resultPane(pane,'unverified','pane_changed_during_binding',generation);
    const {process_info:latestInfo}=await herdr.call('pane.process_info',{pane_id:pane.pane_id});
    const latestProc=matchingProcess(latestInfo,pane.agent);
    if(!sameProcess(proc,latestProc)||processStart(proc.pid)!==start)
      return resultPane(pane,'unverified','process_changed_during_binding',generation);
    if(pane.agent==='claude'&&recordIdentity(readRecord(home,proc.pid))!==recordIdentity(initialRecord))
      return resultPane(pane,'unverified','process_record_changed_during_binding',generation);
  } catch { return resultPane(pane,'unverified','pane_recheck_unavailable',generation); }
  if(pane.agent==='codex'&&resolution.state==='verified'&&resolution.reason==='recovered_title_native_row'&&
    !(generationMatches&&prior?.sessionId===resolution.sessionId)) {
    // A title can linger after an in-process thread switch. A native thread
    // already known to be finished cannot establish a new PID-to-row binding.
    const lifecycle=readCodexLifecycle(resolution.session,home);
    if(lifecycle?.state==='complete'||lifecycle?.state==='aborted')
      return resultPane(pane,'unverified','historical_title_only_session',generation);
  }
  if(resolution.state==='verified') {
    const bound=resultPane(pane,'verified',resolution.reason,generation,resolution.session,resolution.sessionId);
    verified.set(key,{generation,session:resolution.session,sessionId:resolution.sessionId});
    if(verified.size>256)verified.delete(verified.keys().next().value);
    return bound;
  }
  if(pane.agent==='codex'&&resolution.state==='unverified'&&generationMatches&&prior) {
    const reported=pane.agent_session;
    // A changed explicit report is a new identity claim, never a short outage.
    if(!reported||reported.value===prior.sessionId||reported.value===prior.session?.value)
      return resultPane(pane,'verified','prior_verified_same_generation',generation,prior.session,prior.sessionId);
  }
  return resultPane(pane,resolution.state,resolution.reason,generation);
}
