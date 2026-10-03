import {createHash} from 'node:crypto';

const FILE='pane-activity.json';
const LIMIT=4096;
const hash=pane=>createHash('sha256').update(JSON.stringify([
  pane.pane_id,pane.terminal_id??null,pane.workspace_id??null,pane.tab_id??null,
  pane.agent??null,pane.agent_session??null
])).digest('hex');
const revision=pane=>Number.isSafeInteger(pane.revision)&&pane.revision>=0?pane.revision:null;
const status=pane=>typeof pane.agent_status==='string'&&pane.agent_status.length<=32?pane.agent_status:null;
const validTime=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&
  Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value&&Date.parse(value)<=Date.now()?value:null;

// Records only metadata and an observed timestamp. Neither titles, terminal
// output nor user input are retained. An old baseline is never dated at boot.
export class PaneActivity {
  constructor(store) {
    this.store=store;
    this.panes=new Map();
    const saved=store.read(FILE,[]);
    if(!Array.isArray(saved))return;
    for(const entry of saved.slice(-LIMIT)) {
      if(!entry||typeof entry.id!=='string'||entry.id.length>256||
        !/^[0-9a-f]{64}$/.test(entry.identity))continue;
      this.panes.set(entry.id,{identity:entry.identity,revision:revision(entry),
        status:status({agent_status:entry.status}),lastActivity:validTime(entry.lastActivity),observed:false});
    }
  }
  save() {
    try {this.store.write(FILE,[...this.panes].map(([id,{identity,revision,status,lastActivity}])=>
      ({id,identity,revision,status,lastActivity})));} catch {
      // Activity is optional metadata; a full or read-only state directory must
      // not make the session list or an accepted input fail.
    }
  }
  observe(panes,skip=new Set()) {
    let changed=false;
    const live=new Set(panes.map(pane=>pane.pane_id));
    for(const id of this.panes.keys())if(!live.has(id)&&!skip.has(id)){this.panes.delete(id);changed=true;}
    for(const pane of panes.slice(0,LIMIT)) {
      const id=pane.pane_id,identity=hash(pane),nextRevision=revision(pane),nextStatus=status(pane);
      const previous=this.panes.get(id);
      if(skip.has(id))continue;
      const same=previous?.identity===identity;
      const observed=same&&previous.observed;
      const active=observed&&(
        (nextRevision!==null&&previous.revision!==null&&nextRevision>previous.revision)||
        (nextStatus!==null&&previous.status!==null&&nextStatus!==previous.status));
      const lastActivity=active?new Date().toISOString():same?previous.lastActivity:null;
      if(!same||previous.revision!==nextRevision||previous.status!==nextStatus||previous.lastActivity!==lastActivity)changed=true;
      this.panes.set(id,{identity,revision:nextRevision,status:nextStatus,lastActivity,observed:true});
    }
    while(this.panes.size>LIMIT){this.panes.delete(this.panes.keys().next().value);changed=true;}
    if(changed)this.save();
  }
  status(id,nextStatus) {
    const previous=this.panes.get(id);
    if(!previous||!previous.observed||previous.status===nextStatus)return previous?.lastActivity??null;
    if(previous.status===null){previous.status=nextStatus;this.save();return previous.lastActivity;}
    previous.status=nextStatus;
    previous.lastActivity=new Date().toISOString();
    this.save();
    return previous.lastActivity;
  }
  acceptedInput(pane) {
    const id=pane.pane_id,identity=hash(pane);
    const lastActivity=new Date().toISOString();
    this.panes.set(id,{identity,revision:revision(pane),status:status(pane),lastActivity,observed:true});
    if(this.panes.size>LIMIT)this.panes.delete(this.panes.keys().next().value);
    this.save();
    return lastActivity;
  }
  lastActivity(pane) {
    const previous=this.panes.get(pane.pane_id);
    return previous?.identity===hash(pane)?previous.lastActivity:null;
  }
}
