import {codexSessionFromState} from './codex-session.js';
import {readCodexLifecycle} from './codex-lifecycle.js';

const identity = pane => JSON.stringify([pane.pane_id,pane.terminal_id,pane.workspace_id,pane.tab_id,
  pane.agent,pane.agent_session]);

// Terminal title detection can retain a spinner after the native turn ends.
// Correct only that working state, using the exact conversation's lifecycle.
export class CodexStatus {
  constructor(home) { this.home=home;this.panes=new Map();this.inputs=new Map(); }
  async observe(panes,focusedPaneId) {
    const live=new Set(panes.map(p=>p.pane_id));
    for(const id of this.panes.keys())if(!live.has(id))this.panes.delete(id);
    for(const id of this.inputs.keys())if(!live.has(id))this.inputs.delete(id);
    return Promise.all(panes.map(async pane=>{
      if(pane.agent!=='codex') {this.panes.delete(pane.pane_id);return pane;}
      const inputKey=identity(pane);
      const session=await codexSessionFromState(pane,this.home);
      const key=JSON.stringify([inputKey,session]);
      const old=this.panes.get(pane.pane_id);
      const entry=old?.key===key?old:{key,seenTurn:null};
      entry.inputKey=inputKey;entry.focused=pane.pane_id===focusedPaneId;
      entry.session=session;
      this.panes.set(pane.pane_id,entry);
      return {...pane,agent_status:this.status(pane.pane_id,pane.agent_status)};
    }));
  }
  inputStarted(pane,startedAt,onlyIfComplete=false) {
    if(onlyIfComplete && readCodexLifecycle(this.panes.get(pane.pane_id)?.session,this.home)?.state!=='complete')return ()=>{};
    const previous=this.inputs.get(pane.pane_id);
    const input={key:identity(pane),startedAt};
    this.inputs.set(pane.pane_id,input);
    return ()=>{
      if(this.inputs.get(pane.pane_id)!==input)return;
      if(previous)this.inputs.set(pane.pane_id,previous);else this.inputs.delete(pane.pane_id);
    };
  }
  status(id,rawStatus) {
    const entry=this.panes.get(id);
    if(!entry)return rawStatus;
    const lifecycle=readCodexLifecycle(entry.session,this.home);
    if(!lifecycle)return rawStatus;
    // The old completed turn cannot end input submitted before the new start
    // is appended. Measure from dispatch, allowing a fast reply before its ACK.
    const input=this.inputs.get(id);
    if(input?.key===entry.inputKey) {
      if(Number.isFinite(lifecycle.startedAt)&&lifecycle.startedAt>input.startedAt)input.turnId=lifecycle.turnId;
      if(input.turnId!==lifecycle.turnId)return rawStatus;
    }
    if(lifecycle.state==='active')return rawStatus;
    if(rawStatus==='idle'||entry.focused)entry.seenTurn=lifecycle.turnId;
    if(rawStatus!=='working')return rawStatus;
    if(lifecycle.state==='aborted')return 'idle';
    return entry.seenTurn===lifecycle.turnId?'idle':'done';
  }
}
