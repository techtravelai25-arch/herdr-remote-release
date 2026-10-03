import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {normalizeHttpsOrigin} from './pairing.js';

const TTL=86400000;
const HISTORY_LIMIT=128;
const completionId=id=>typeof id==='string'&&/^[\w-]{1,80}$/.test(id);
function acknowledgedHistory(state) {
  const ids=Array.isArray(state?.acknowledgedCompletionEventIds)?state.acknowledgedCompletionEventIds:[];
  const unique=[...new Set(ids.filter(completionId))].slice(-HISTORY_LIMIT);
  const latest=state?.completionAcknowledged&&completionId(state.completionEventId)?state.completionEventId:null;
  return latest&&!unique.includes(latest)?[...unique,latest].slice(-HISTORY_LIMIT):unique;
}
const appendAcknowledged=(history,id)=>history.includes(id)?history:[...history,id].slice(-HISTORY_LIMIT);
function relaySender(store) {
  const file=path.join(store.dir,'relay-identity.json');
  const privateError='Cloud push relay identity must be private (0600)';
  const invalidError='Invalid cloud push relay identity';
  let identity,fd;
  try {
    if(typeof fs.constants.O_NOFOLLOW!=='number' || typeof fs.constants.O_NONBLOCK!=='number') throw Error(privateError);
    fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const stat=fs.fstatSync(fd);
    if(!stat.isFile() || (stat.mode&0o077) ||
      (typeof process.getuid==='function' && stat.uid!==process.getuid()))
      throw Error(privateError);
    if(!Number.isSafeInteger(stat.size) || stat.size<1 || stat.size>16*1024) throw Error(invalidError);
    // Read at most one byte past the checked size, from the same descriptor.
    // A concurrent growth or short read is not an authorized identity.
    const bytes=Buffer.alloc(stat.size+1);
    let length=0;
    while(length<bytes.length) {
      const count=fs.readSync(fd,bytes,length,bytes.length-length,length);
      if(!count)break;
      length+=count;
    }
    if(length!==stat.size) throw Error(invalidError);
    identity=JSON.parse(bytes.subarray(0,length).toString('utf8'));
  } catch(error) {
    if(error.message===privateError || error.code==='ELOOP') throw Error(privateError);
    throw Error(invalidError);
  } finally { if(fd!==undefined) fs.closeSync(fd); }
  try {
    if(typeof identity?.url!=='string' || normalizeHttpsOrigin(identity.url)!==identity.url ||
      typeof identity.id!=='string' || !/^[\w-]{1,80}$/.test(identity.id) ||
      typeof identity.relayToken!=='string' || !/^[\w-]{43}$/.test(identity.relayToken))
      throw Error('Invalid cloud push relay identity');
  } catch { throw Error('Invalid cloud push relay identity'); }
  return {origin:identity.url,id:identity.id,token:identity.relayToken};
}
/** Durable pane completion state and, when configured, a status-only cloud outbox. */
export function createPushMonitor(config,store,{fetcher=fetch,now=Date.now,interval=5000}={}) {
  const c=config.cloudPush;
  let sender;
  if(c) {
    if(c.source==='relay') {
      if(Object.keys(c).length!==1) throw Error('Invalid cloud push configuration');
      sender=relaySender(store);
    } else {
      try { if(normalizeHttpsOrigin(c.portalOrigin)!==c.portalOrigin)throw Error(); }
      catch { throw Error('Invalid cloud push configuration'); }
      if(!/^[\w-]{1,80}$/.test(c.deviceId||'') || typeof c.tokenFile!=='string') throw Error('Invalid cloud push configuration');
      const stat=fs.lstatSync(c.tokenFile);
      if(!stat.isFile() || stat.isSymbolicLink() || (stat.mode&0o077)) throw Error('Cloud push token file must be private (0600)');
      const token=fs.readFileSync(c.tokenFile,'utf8').trim();
      if(!/^[\w-]{43,128}$/.test(token)) throw Error('Invalid cloud push token');
      sender={origin:c.portalOrigin,token};
    }
  }
  let data=store.read('push-outbox.json',{queue:[],states:{}});
  if(!Array.isArray(data.queue)||!data.states||typeof data.states!=='object'||Array.isArray(data.states)) data={queue:[],states:{}};
  let closed=false,flight=false,nextAttempt=0,failures=0;
  const save=()=>store.write('push-outbox.json',data);
  const event=(paneId,kind,targetEventId)=>({eventId:randomUUID(),paneId,kind,...(targetEventId?{targetEventId}:{}),createdAt:Math.floor(now()/1000)});
  function completionFor(paneId) {
    const state=data.states[paneId];
    return state?.completionEventId&&!state.completionAcknowledged?state.completionEventId:null;
  }
  function acknowledge(paneId,targetEventId=completionFor(paneId)) {
    if(!targetEventId||completionFor(paneId)!==targetEventId)return false;
    data.states[paneId].completionAcknowledged=true;
    data.states[paneId].acknowledgedCompletionEventIds=appendAcknowledged(acknowledgedHistory(data.states[paneId]),targetEventId);
    if(c)data.queue.push(event(paneId,'clear',targetEventId));
    data.queue=data.queue.slice(-128);
    save();
    if(c)void flush();
    return true;
  }
  function annotate(snapshot) {
    return {...snapshot,panes:snapshot.panes.map(pane=>{
      const state=data.states[pane.id];
      return {...pane,completionEventId:state?.completionEventId??null,completionAcknowledged:state?.completionAcknowledged??false,
        acknowledgedCompletionEventIds:acknowledgedHistory(state)};
    })};
  }
  async function flush() {
    if(!c||closed||flight||now()<nextAttempt)return;
    flight=true;
    try {
      const previousLength=data.queue.length;
      data.queue=data.queue.filter(e=>e.createdAt*1000>now()-TTL).slice(-128);
      if(data.queue.length!==previousLength) save();
      while(data.queue.length && !closed) {
        const next=data.queue[0];
        const response=await fetcher(`${sender.origin}/v1/push/events`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${sender.token}`,'Content-Type':'application/json',...(sender.id?{'X-Herdr-Laptop-ID':sender.id}:{})},body:JSON.stringify(next)});
        if(!response.ok) throw Error('Push relay unavailable');
        const delivered=data.queue.findIndex(item=>item.eventId===next.eventId);
        if(delivered!==-1) {data.queue.splice(delivered,1);save();}
        failures=0;
      }
    } catch { failures=Math.min(failures+1,6);nextAttempt=now()+Math.min(60000,1000*2**failures); }
    finally { flight=false; }
  }
  function observe(snapshot) {
    if(closed||!snapshot.herdrOnline||snapshot.stale)return annotate(snapshot);
    const states={};
    let changed=false;
    for(const pane of snapshot.panes) {
      if(pane.kind==='terminal')continue;
      const previous=data.states[pane.id];
      const status=pane.status;
      const working=status==='working'||(status==='unknown'&&previous?.working===true);
      const next={status,working,completionEventId:previous?.completionEventId??null,completionAcknowledged:previous?.completionAcknowledged??false,
        acknowledgedCompletionEventIds:acknowledgedHistory(previous)};
      const kind=(status==='blocked'||status==='needs_input')?'needs_input':status==='error'?'error':(status==='done'||status==='idle')&&previous?.working?'done':null;
      if(previous&&previous.status!==status) {
        if(status==='working'||(previous.status==='done'&&status==='idle')) {
          if(next.completionEventId&&!next.completionAcknowledged) {
            next.completionAcknowledged=true;
            next.acknowledgedCompletionEventIds=appendAcknowledged(next.acknowledgedCompletionEventIds,next.completionEventId);
            if(c)data.queue.push(event(pane.id,'clear',next.completionEventId));
          }
        }
        // First observation never alerts for old work. A new completion gets
        // its own identity, including when the agent goes directly to idle.
        if(kind) {
          const emitted=event(pane.id,kind);
          if(kind==='done') {next.completionEventId=emitted.eventId;next.completionAcknowledged=false;}
          if(c)data.queue.push(emitted);
        }
      }
      states[pane.id]=next;
      if(JSON.stringify(previous)!==JSON.stringify(next))changed=true;
    }
    if(Object.keys(states).length!==Object.keys(data.states).length)changed=true;
    if(changed) {data.states=states;data.queue=data.queue.slice(-128);save();}
    if(c)void flush();
    return annotate(snapshot);
  }
  const timer=c?setInterval(()=>{void flush();},interval):null;timer?.unref();
  return {enabled:!!c,tracking:true,observe,annotate,completionFor,acknowledge,flush,close(){closed=true;if(timer)clearInterval(timer);}};
}
