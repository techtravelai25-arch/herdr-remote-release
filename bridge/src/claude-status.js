import {claudeSessionFromProcess} from './claude-session.js';
import {readClaudeLifecycle} from './claude-lifecycle.js';

const identity=pane=>JSON.stringify([pane.pane_id,pane.terminal_id,pane.workspace_id,pane.tab_id,pane.agent,pane.agent_session]);
const attention=status=>!['done','idle','working'].includes(status);

// Gate both phone monitoring and cloud push before a terminal status can become
// a completion event. A quiet screen or a tool finishing cannot end the turn.
export class ClaudeStatus {
  constructor({herdr,home,now=Date.now,settleMs=2000}) {
    this.herdr=herdr;this.home=home;this.now=now;this.settleMs=settleMs;
    this.panes=new Map();this.inputs=new Map();
  }
  async observe(panes,focusedPaneId,currentState=pane=>({status:pane.agent_status,focused:pane.pane_id===focusedPaneId})) {
    const live=new Set(panes.map(p=>p.pane_id));
    for(const id of this.panes.keys())if(!live.has(id))this.panes.delete(id);
    for(const id of this.inputs.keys())if(!live.has(id))this.inputs.delete(id);
    return Promise.all(panes.map(async pane=>{
      if(pane.agent!=='claude') {this.panes.delete(pane.pane_id);this.inputs.delete(pane.pane_id);return pane;}
      const session=pane.binding ? pane.binding.state==='verified' ? pane.agent_session : null
        : await claudeSessionFromProcess(this.herdr,pane,this.home);
      const inputKey=identity(pane),generation=pane.binding?.generation??inputKey;
      const key=JSON.stringify([generation,session]);
      const old=this.panes.get(pane.pane_id);
      const entry=old?.key===key?old:{key,seen:null,published:null,candidate:null};
      // Session discovery can await an RPC. Reconcile status after that await
      // so an older snapshot cannot acknowledge a newer completion event.
      const {status:rawStatus,focused}=currentState(pane);
      entry.inputKey=inputKey;entry.session=session;entry.focused=focused;
      entry.generation=generation;entry.verification=pane.binding?.state??(session?'verified':'unverified');
      entry.bindingReason=pane.binding?.reason??(session?'legacy_session':'unknown_identity');
      this.panes.set(pane.pane_id,entry);
      // A completed conversation found at boot is a baseline, not fresh work.
      if(!old||old.key!==key) {
        const lifecycle=readClaudeLifecycle(session,this.home);
        if(lifecycle?.state==='complete') {
          entry.published=lifecycle.key;
          // A retained spinner at startup must not manufacture a new turn
          // from a historical reply when its title eventually settles.
          if(rawStatus==='working')entry.seen=lifecycle.key;
        }
      }
      const agent_status=this.status(pane.pane_id,rawStatus);
      return {...pane,agent_status,...this.metadata(pane.pane_id)};
    }));
  }
  inputStarted(pane,startedAt,onlyIfComplete=false) {
    if(pane.agent!=='claude')return ()=>{};
    const entry=this.panes.get(pane.pane_id);
    const lifecycle=readClaudeLifecycle(entry?.session,this.home);
    if(onlyIfComplete&&!['complete','final'].includes(lifecycle?.state))return ()=>{};
    const previous=this.inputs.get(pane.pane_id);
    const input={key:entry?.inputKey??identity(pane),startedAt,previousKey:lifecycle?.key};
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
    const lifecycle=entry.verification==='verified'?readClaudeLifecycle(entry.session,this.home,{diagnostic}):null;
    const meta=(status,reason=diagnostic.reason??entry.bindingReason)=>{
      entry.decision={bindingGeneration:entry.generation,bindingVerification:entry.verification==='conflict'?'conflicting':entry.verification,
        nativeTurnId:lifecycle?.key??null,completionEligible:['done','idle'].includes(status)&&lifecycle?.state==='complete'&&entry.verification==='verified',
        nativeCompletionKind:lifecycle?.state==='complete'?'complete':null,nativeReason:reason,rawStatus};
      return status;
    };
    if(attention(rawStatus)) {entry.candidate=null;return meta(rawStatus,'raw_attention');}
    if(!lifecycle) {entry.candidate=null;return meta(rawStatus==='done'?'unknown':rawStatus);}
    const input=this.inputs.get(id);
    if(input?.key===entry.inputKey&&(lifecycle.key===input.previousKey||lifecycle.timestamp<input.startedAt)) {
      entry.candidate=null;return meta('working','input_waiting_for_new_turn');
    }
    if(lifecycle.state==='active') {entry.candidate=null;return meta('working','native_active');}
    if(rawStatus==='idle'||entry.focused)entry.seen=lifecycle.key;
    if(entry.seen===lifecycle.key) {entry.candidate=null;return meta('idle','native_seen');}
    if(entry.published===lifecycle.key)return meta('done','native_complete');
    if(lifecycle.state!=='complete'||rawStatus!=='done') {
      entry.candidate=null;return meta(rawStatus==='done'?'working':rawStatus,lifecycle.state==='final'?'native_final_unconfirmed':'awaiting_native_completion');
    }
    if(entry.candidate?.key!==lifecycle.key)entry.candidate={key:lifecycle.key,since:this.now()};
    if(this.now()-entry.candidate.since<this.settleMs)return meta('working','confirmation_window');
    entry.published=lifecycle.key;entry.candidate=null;return meta('done','native_complete');
  }
  metadata(id) {return this.panes.get(id)?.decision??{};}
}
