import {codexSessionFromState} from './codex-session.js';
import {readCodexLifecycle} from './codex-lifecycle.js';

const identity = pane => JSON.stringify([pane.pane_id,pane.terminal_id,pane.workspace_id,pane.tab_id,
  pane.agent,pane.agent_session]);

// Terminal title detection can retain a spinner after the native turn ends.
// Correct only that working state, using the exact conversation's lifecycle.
export class CodexStatus {
  constructor(home) { this.home=home;this.panes=new Map();this.inputs=new Map(); }
  async observe(panes,_focusedPaneId) {
    const live=new Set(panes.map(p=>p.pane_id));
    for(const id of this.panes.keys())if(!live.has(id))this.panes.delete(id);
    for(const id of this.inputs.keys())if(!live.has(id))this.inputs.delete(id);
    return Promise.all(panes.map(async pane=>{
      if(pane.agent!=='codex') {this.panes.delete(pane.pane_id);return pane;}
      const inputKey=identity(pane);
      const session=pane.binding ? pane.binding.state==='verified' ? pane.agent_session : null
        : await codexSessionFromState(pane,this.home);
      const verification=pane.binding?.state??(session?'verified':'unverified');
      const generation=pane.binding?.generation??inputKey;
      const key=JSON.stringify([generation,session]);
      const old=this.panes.get(pane.pane_id);
      const entry=old?.key===key?old:{key,seenTurn:null};
      entry.inputKey=inputKey;
      entry.session=session;entry.verification=verification;entry.generation=generation;
      entry.bindingReason=pane.binding?.reason??(session?'legacy_session':'unknown_identity');
      this.panes.set(pane.pane_id,entry);
      const agent_status=this.status(pane.pane_id,pane.agent_status);
      return {...pane,agent_status,...this.metadata(pane.pane_id)};
    }));
  }
  inputStarted(pane,startedAt,onlyIfComplete=false) {
    if(onlyIfComplete && readCodexLifecycle(this.panes.get(pane.pane_id)?.session,this.home)?.state!=='complete')return ()=>{};
    const previous=this.inputs.get(pane.pane_id);
    const input={key:this.panes.get(pane.pane_id)?.inputKey??identity(pane),startedAt};
    this.inputs.set(pane.pane_id,input);
    return ()=>{
      if(this.inputs.get(pane.pane_id)!==input)return;
      if(previous)this.inputs.set(pane.pane_id,previous);else this.inputs.delete(pane.pane_id);
    };
  }
  status(id,rawStatus) {
    const entry=this.panes.get(id);
    if(!entry)return rawStatus;
    const diagnostic={};
    const lifecycle=entry.verification==='verified'?readCodexLifecycle(entry.session,this.home,{diagnostic}):null;
    const meta=(status,reason=diagnostic.reason??entry.bindingReason)=>{
      entry.decision={bindingGeneration:entry.generation,bindingVerification:entry.verification==='conflict'?'conflicting':entry.verification,
        nativeTurnId:lifecycle?.turnId??null,completionEligible:['done','idle'].includes(status)&&lifecycle?.state==='complete'&&entry.verification==='verified',
        nativeCompletionKind:lifecycle?.state==='complete'?'complete':lifecycle?.state==='aborted'?'aborted':null,
        nativeReason:reason,rawStatus};
      return status;
    };
    if(!lifecycle)return meta(rawStatus==='done'?'unknown':rawStatus);
    if(!['working','done','idle'].includes(rawStatus))return meta(rawStatus,'raw_attention');
    // The old completed turn cannot end input submitted before the new start
    // is appended. Measure from dispatch, allowing a fast reply before its ACK.
    const input=this.inputs.get(id);
    if(input?.key===entry.inputKey) {
      if(Number.isFinite(lifecycle.startedAt)&&lifecycle.startedAt>input.startedAt)input.turnId=lifecycle.turnId;
      if(input.turnId!==lifecycle.turnId)return meta('working','input_waiting_for_new_turn');
    }
    if(lifecycle.state==='active')return meta('working','native_active');
    // Focus can predate the reply; only an observed idle state proves it was seen.
    if(rawStatus==='idle')entry.seenTurn=lifecycle.turnId;
    if(lifecycle.state==='aborted')return meta('idle','native_aborted');
    if(rawStatus!=='working')return meta(rawStatus,rawStatus==='idle'?'native_seen':'native_complete');
    return meta(entry.seenTurn===lifecycle.turnId?'idle':'done',entry.seenTurn===lifecycle.turnId?'native_seen':'native_complete');
  }
  metadata(id) {return this.panes.get(id)?.decision??{};}
}
