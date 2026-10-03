import {randomUUID} from 'node:crypto';
const statuses = new Set(['idle','working','blocked','done','unknown']);
/** Local, bounded status history. No prompts, output, filenames or keys are stored. */
export class Timeline {
  constructor(store, {clock=()=>Date.now(), limit=500, retention=7*86400000}={}) {
    this.store=store; this.clock=clock; this.limit=limit; this.retention=retention;
    this.startedAt=new Date(clock()).toISOString(); this.baseline=new Map();
    const saved=store.read('activity.json',[]);
    this.events=Array.isArray(saved)?saved.filter(e=>e&&typeof e.id==='string'&&typeof e.paneId==='string'&&statuses.has(e.status)&&Number.isFinite(Date.parse(e.timestamp))):[];
    this.trim();
  }
  trim() { const earliest=this.clock()-this.retention;this.events=this.events.filter(e=>Date.parse(e.timestamp)>=earliest).slice(-this.limit); }
  observe(snapshot) {
    if(!snapshot.herdrOnline||snapshot.stale)return;
    let changed=false;
    const live=new Set();
    for(const pane of snapshot.panes||[]) {
      if(pane.kind==='terminal'||!statuses.has(pane.status))continue;
      live.add(pane.id);
      const previous=this.baseline.get(pane.id);
      this.baseline.set(pane.id,pane.status);
      // First sight is a baseline, never fabricate past starts/completions.
      if(previous===undefined||previous===pane.status)continue;
      this.events.push({id:randomUUID(),paneId:pane.id,title:String(pane.title||'Agent').slice(0,80),kind:pane.kind,status:pane.status,previousStatus:previous,timestamp:new Date(this.clock()).toISOString()});
      changed=true;
    }
    for(const id of this.baseline.keys())if(!live.has(id))this.baseline.delete(id);
    this.trim();
    if(changed)this.store.write('activity.json',this.events);
  }
  list() {
    this.trim();const events=[];let bytes=0;
    for(const event of [...this.events].reverse()){const size=Buffer.byteLength(JSON.stringify(event))+1;if(bytes+size>64*1024)break;events.push(event);bytes+=size;}
    const startedAt=this.events.reduce((earliest,event)=>event.timestamp<earliest?event.timestamp:earliest,this.startedAt);
    return {events,startedAt,truncated:events.length<this.events.length};
  }
}
