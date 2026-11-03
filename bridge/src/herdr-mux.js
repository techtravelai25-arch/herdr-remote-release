import {BridgeError} from './herdr.js';
import {isCoreId} from './herdr-core.js';

const LAUNCH_HINTS=['agent_kind','agent_name'];
const withoutHints=params=>Object.fromEntries(Object.entries(params).filter(([key])=>!LAUNCH_HINTS.includes(key)));

/**
 * One Herdr surface over the TUI (`herdr server`) and the desktop app core
 * (herdr-core). Calls route by the `hc:` ID prefix. A backend that fails after
 * it had panes contributes its last panes as stale until it answers again; a
 * backend that never had panes contributes nothing.
 */
export function createHerdrMux(tui,core) {
  const last={tui:null,core:null};let coreLive=false;
  async function snapshot(timeout) {
    const [fromTui,fromCore]=await Promise.allSettled([
      tui.call('session.snapshot',{},timeout).then(({snapshot})=>{
        if(snapshot?.protocol!==22)throw new BridgeError('protocol_mismatch','Unsupported Herdr protocol; update the bridge after checking its schema.',503);
        return snapshot;
      }),
      core.call('session.snapshot',{},timeout).then(({snapshot})=>snapshot)]);
    coreLive=fromCore.status==='fulfilled';
    if(fromTui.status==='rejected'&&fromCore.status==='rejected')throw fromTui.reason;
    const parts=[],stale=[];
    for(const [name,result] of [['tui',fromTui],['core',fromCore]]) {
      if(result.status==='fulfilled'){last[name]=result.value;parts.push(result.value);continue;}
      if(!last[name]?.panes?.length)continue;
      parts.push(last[name]);stale.push(...last[name].panes.map(pane=>pane.pane_id));
    }
    const all=key=>parts.flatMap(part=>part[key]||[]);
    return {protocol:22,focused_pane_id:fromTui.status==='fulfilled'?fromTui.value.focused_pane_id??null:null,
      workspaces:all('workspaces'),tabs:all('tabs'),panes:all('panes'),agents:all('agents'),stale_pane_ids:stale};
  }
  return {
    async call(method,params={},timeout) {
      if(method==='session.snapshot')return {snapshot:await snapshot(timeout)};
      if(method==='agent.list') {
        const results=await Promise.allSettled([tui.call(method,params,timeout),core.call(method,params,timeout)]);
        if(results.every(result=>result.status==='rejected'))throw results[0].reason;
        return {agents:results.flatMap(result=>result.status==='fulfilled'?result.value.agents||[]:[])};
      }
      // New spaces go to the desktop app while its core answers; else the TUI as before.
      const app=method==='workspace.create'?coreLive:isCoreId(params.pane_id??params.target??params.workspace_id);
      return app?core.call(method,params,timeout):tui.call(method,withoutHints(params),timeout);
    },
  };
}
