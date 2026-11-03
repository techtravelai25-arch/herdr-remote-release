import fs from 'node:fs';
import {BridgeError} from './herdr.js';

const reject=(code,message,status=400)=>{ throw new BridgeError(code,message,status); };
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function projectPath(project) {
  try {
    const resolved=fs.realpathSync(project.path);
    if(!fs.statSync(resolved).isDirectory()) throw new Error();
    return resolved;
  } catch { reject('project_unavailable','The selected project directory is unavailable.',409); }
}

/** Creates panes and starts agents in them; a created pane is retained on failure. */
export function createLauncher({herdr,directories}) {
  function rememberDirectory(cwd) {
    // A successful launch must remain successful even if the optional recent
    // list cannot be persisted (for example when the disk is full).
    try {directories.record(cwd);} catch {}
  }
  async function startAgent(paneId, kind, name, launched=false) {
    const deadline=Date.now()+40000;
    // A backend that created the pane already running the agent only needs readiness.
    let result=launched?{agent:{}}:undefined;
    // Only agent_pane_busy is a confirmed pre-launch rejection. Once a launch
    // is accepted, everything below is observation: never launch it again.
    for (let attempt=0; !launched; attempt++) {
      try {
        const timeout=Math.min(35000,Math.max(1,deadline-Date.now()));
        result=await herdr.call('agent.start',{pane_id:paneId,kind,name,timeout_ms:30000},timeout);
        break;
      } catch (error) {
        if(error.code!=='agent_pane_busy'||attempt>=12||Date.now()>=deadline) throw error;
        await pause(250);
      }
    }
    if(!result?.agent || result.agent.interactive_ready || result.agent.agent_status==='blocked') return result;
    const readinessDeadline=Math.min(deadline,Date.now()+15000);
    while(Date.now()<readinessDeadline) {
      await pause(250);
      const remaining=readinessDeadline-Date.now();
      if(remaining<=0) break;
      try {
        const current=(await herdr.call('agent.get',{target:paneId},Math.min(3000,remaining))).agent;
        if(result.agent.terminal_id && current?.terminal_id!==result.agent.terminal_id)
          throw new BridgeError('agent_changed','The new pane changed while its agent was starting.',409);
        if(current?.interactive_ready || current?.agent_status==='blocked') return {type:'agent_started',agent:current,argv:result.argv||[]};
      } catch(error) {
        // A just-created app terminal reports its agent once the program is up.
        if(!['agent_not_ready','agent_pane_busy',...(launched?['agent_not_found']:[])].includes(error.code)) throw error;
      }
    }
    throw new BridgeError('agent_start_timeout','The agent is still starting. Refresh the retained pane to inspect it.',504);
  }
  async function start(project,kind,name,existingWorkspace) {
    const cwd=projectPath(project);
    const hint=kind==='terminal'?{}:{agent_kind:kind,agent_name:name};
    const created=existingWorkspace
      ? await herdr.call('tab.create',{workspace_id:existingWorkspace,cwd,label:name,focus:false,...hint})
      : await herdr.call('workspace.create',{cwd,label:project.label,focus:false,...hint});
    const id=created.root_pane.pane_id;
    try {
      // A newly created layout already contains a shell. Terminal sessions must
      // never call agent.start or send startup commands to that shell.
      if(kind==='terminal') await herdr.call('pane.rename',{pane_id:id,label:name});
      else await startAgent(id,kind,name,created.agent_started===true);
      rememberDirectory(cwd);
      return {paneId:id};
    } catch(e) {
      // Retain the created pane so startup approval/login can be inspected and answered.
      e.message=`${e.message} The new pane ${id} was retained; refresh to inspect it.`;
      e.paneId=id; throw e;
    }
  }
  return {start,startAgent,rememberDirectory};
}
