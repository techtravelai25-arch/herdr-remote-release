import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {normalizeHttpsOrigin} from './pairing.js';

const TTL=86400000;
// Every snapshot carries this history for each pane, and relayed snapshots
// share a 240 KB response budget. The app tombstones each ID it sees for 72 h
// and the latest event also travels as {type}EventId/{type}Acknowledged, so
// the list only bridges acknowledgements made between two app observations.
export const HISTORY_LIMIT=8;
const completionId=id=>typeof id==='string'&&/^[\w-]{1,80}$/.test(id);
function acknowledgedHistory(state,type='completion') {
  const history=type==='attention'?'acknowledgedAttentionEventIds':'acknowledgedCompletionEventIds';
  const ids=Array.isArray(state?.[history])?state[history]:[];
  const unique=[...new Set(ids.filter(completionId))].slice(-HISTORY_LIMIT);
  const latest=state?.[`${type}Acknowledged`]&&completionId(state[`${type}EventId`])?state[`${type}EventId`]:null;
  return latest&&!unique.includes(latest)?[...unique,latest].slice(-HISTORY_LIMIT):unique;
}
const appendAcknowledged=(history,id)=>history.includes(id)?history:[...history,id].slice(-HISTORY_LIMIT);
const attentionKind=status=>(status==='blocked'||status==='needs_input')?'needs_input':status==='error'?'error':null;
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
/** Durable pane alert state and, when configured, a status-only cloud outbox. */
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
  function attentionFor(paneId) {
    const state=data.states[paneId];
    return state?.attentionEventId&&!state.attentionAcknowledged?state.attentionEventId:null;
  }
  function acknowledgeState(state,paneId,type) {
    const id=state[`${type}EventId`];
    if(!id||state[`${type}Acknowledged`])return false;
    state[`${type}Acknowledged`]=true;
    const history=type==='attention'?'acknowledgedAttentionEventIds':'acknowledgedCompletionEventIds';
    state[history]=appendAcknowledged(acknowledgedHistory(state,type),id);
    if(c)data.queue.push(event(paneId,'clear',id));
    return true;
  }
  function acknowledgeEvent(paneId,targetEventId,type) {
    const current=type==='attention'?attentionFor(paneId):completionFor(paneId);
    if(!targetEventId||current!==targetEventId)return false;
    acknowledgeState(data.states[paneId],paneId,type);
    data.queue=data.queue.slice(-128);
    save();
    if(c)void flush();
    return true;
  }
  const acknowledge=(paneId,targetEventId=completionFor(paneId))=>acknowledgeEvent(paneId,targetEventId,'completion');
  const acknowledgeAttention=(paneId,targetEventId=attentionFor(paneId))=>acknowledgeEvent(paneId,targetEventId,'attention');
  function annotate(snapshot) {
    return {...snapshot,panes:snapshot.panes.map(pane=>{
      const state=data.states[pane.id];
      return {...pane,completionEventId:state?.completionEventId??null,completionAcknowledged:state?.completionAcknowledged??false,
        acknowledgedCompletionEventIds:acknowledgedHistory(state),attentionEventId:state?.attentionEventId??null,
        attentionAcknowledged:state?.attentionAcknowledged??false,acknowledgedAttentionEventIds:acknowledgedHistory(state,'attention')};
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
      const previousAttentionKind=previous?.attentionKind??attentionKind(previous?.status);
      const next={status,working,completionEventId:previous?.completionEventId??null,completionAcknowledged:previous?.completionAcknowledged??false,
        acknowledgedCompletionEventIds:acknowledgedHistory(previous),attentionEventId:previous?.attentionEventId??null,
        attentionAcknowledged:previous?.attentionAcknowledged??false,acknowledgedAttentionEventIds:acknowledgedHistory(previous,'attention'),
        attentionKind:status==='unknown'?previousAttentionKind:attentionKind(status)};
      const kind=attentionKind(status)??((status==='done'||status==='idle')&&previous?.working?'done':null);
      // Unknown is a gap in status knowledge, not a new alert generation.
      // blocked and needs_input describe the same outstanding attention.
      const sameAttention=attentionKind(status)&&attentionKind(status)===previousAttentionKind&&
        (previous?.status==='unknown'||attentionKind(previous?.status)===attentionKind(status));
      // Herdr's idle status means the result was seen in the focused PC pane.
      // Reconcile persisted idle completions too, including after an upgrade.
      if(previous&&(status==='working'||status==='idle'))acknowledgeState(next,pane.id,'completion');
      if(previous&&(['working','idle','done'].includes(status)||
        (previous.status!==status&&(kind==='needs_input'||kind==='error')&&!sameAttention)))acknowledgeState(next,pane.id,'attention');
      if(previous&&previous.status!==status) {
        // First observation never alerts for old work. A new completion gets
        // its own identity. Direct idle completions are already seen on PC.
        if(kind&&!sameAttention) {
          const emitted=event(pane.id,kind);
          if(kind==='done') {
            next.completionEventId=emitted.eventId;next.completionAcknowledged=status==='idle';
            if(next.completionAcknowledged)next.acknowledgedCompletionEventIds=appendAcknowledged(next.acknowledgedCompletionEventIds,emitted.eventId);
          } else {next.attentionEventId=emitted.eventId;next.attentionAcknowledged=false;}
          if(c&&!(kind==='done'&&status==='idle'))data.queue.push(emitted);
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
  return {enabled:!!c,tracking:true,observe,annotate,completionFor,acknowledge,attentionFor,acknowledgeAttention,flush,close(){closed=true;if(timer)clearInterval(timer);}};
}
