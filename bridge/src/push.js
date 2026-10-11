import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {normalizeHttpsOrigin} from './pairing.js';

const SHOW_TTL_MS=10*60*1000;
const MAX_PENDING_SHOWS=128;
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
  const decisions=[];
  const counters=data.health&&['droppedShows','expiredShows','retiredClears','retries'].every(k=>Number.isSafeInteger(data.health[k])&&data.health[k]>=0)
    ?data.health:{droppedShows:0,expiredShows:0,retiredClears:0,retries:0};
  data.health=counters;
  const save=()=>store.write('push-outbox.json',data);
  const event=(paneId,kind,targetEventId,eventId=randomUUID())=>{const createdAt=Math.floor(now()/1000);return {eventId,paneId,kind,...(targetEventId?{targetEventId}:{}),createdAt,expiresAt:createdAt+(kind==='clear'?86400:600),...(kind==='clear'?{retireAt:createdAt+72*3600}:{})};};
  function decision(reason,pane) {
    const generation=pane?.bindingGeneration;
    const safeCode=value=>typeof value==='string'&&/^[a-z_]{1,40}$/.test(value)?value:null;
    decisions.push({at:Math.floor(now()/1000),reason,status:safeCode(pane?.status),verification:safeCode(pane?.bindingVerification),
      generation:typeof generation==='string'||Number.isSafeInteger(generation)?createHash('sha256').update(String(generation)).digest('hex').slice(0,12):null,
      evidence:safeCode(pane?.nativeCompletionKind)});
    if(decisions.length>32)decisions.shift();
  }
  function compactQueue() {
    const before=data.queue.length;
    let expiredShows=0,retiredClears=0;
    data.queue=data.queue.filter(e=>{
      if(e.kind==='clear') {
        const keep=(Number.isInteger(e.retireAt)?e.retireAt:(e.createdAt||0)+72*3600)*1000>now();
        if(!keep)retiredClears++;
        return keep;
      }
      const keep=(Number.isInteger(e.expiresAt)?e.expiresAt*1000:(e.createdAt||0)*1000+SHOW_TTL_MS)>now();
      if(!keep)expiredShows++;
      return keep;
    });
    counters.expiredShows+=expiredShows;counters.retiredClears+=retiredClears;
    let changed=data.queue.length!==before;
    const shows=data.queue.filter(e=>e.kind!=='clear');
    if(shows.length>MAX_PENDING_SHOWS) {
      const drop=new Set(shows.slice(0,shows.length-MAX_PENDING_SHOWS).map(e=>e.eventId));
      data.queue=data.queue.filter(e=>!drop.has(e.eventId));
      counters.droppedShows+=drop.size;changed=true;
    }
    return changed;
  }
  function queueClear(paneId,targetEventId) {
    if(!c||!targetEventId)return;
    // If a show was never posted, recovery must not send it after its pane
    // closed or the user saw the result. An in-flight show still needs a clear.
    data.queue=data.queue.filter(e=>e.kind==='clear'||e.eventId!==targetEventId);
    if(data.queue.some(e=>e.kind==='clear'&&e.paneId===paneId&&e.targetEventId===targetEventId))return;
    data.queue.push(event(paneId,'clear',targetEventId));
  }
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
    queueClear(paneId,id);
    return true;
  }
  function acknowledgeEvent(paneId,targetEventId,type) {
    const current=type==='attention'?attentionFor(paneId):completionFor(paneId);
    if(!targetEventId||current!==targetEventId)return false;
    acknowledgeState(data.states[paneId],paneId,type);
    compactQueue();
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
      if(compactQueue()) save();
      while(data.queue.length && !closed) {
        const next=data.queue[0];
        // Keep the exact cancellation target while refreshing its auth timestamp.
        if(next.kind==='clear'&&next.createdAt*1000<now()-23*60*60*1000) {
          next.createdAt=Math.floor(now()/1000);next.expiresAt=next.createdAt+86400;save();
        }
        const {retireAt,...payload}=next;
        const response=await fetcher(`${sender.origin}/v1/push/events`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${sender.token}`,'Content-Type':'application/json',...(sender.id?{'X-Herdr-Laptop-ID':sender.id}:{})},body:JSON.stringify(payload)});
        if(!response.ok) throw Error('Push relay unavailable');
        const delivered=data.queue.findIndex(item=>item.eventId===next.eventId);
        if(delivered!==-1) {data.queue.splice(delivered,1);save();}
        failures=0;
      }
    } catch { failures=Math.min(failures+1,6);counters.retries++;nextAttempt=now()+Math.min(60000,1000*2**failures);decision('delivery_retry');try{save();}catch{} }
    finally { flight=false; }
  }
  function observe(snapshot) {
    if(closed||!snapshot.herdrOnline||snapshot.stale)return annotate(snapshot);
    const complete=snapshot.panesComplete===true;
    const states=complete?{}:{...data.states};
    let changed=false;
    const present=new Set();
    for(const pane of snapshot.panes) {
      if(pane.kind==='terminal')continue;
      present.add(pane.id);
      const previous=data.states[pane.id];
      const status=pane.status;
      const versioned=(pane.kind==='codex'||pane.kind==='claude')&&(complete||pane.bindingGeneration!==undefined);
      const generation=typeof pane.bindingGeneration==='string'||Number.isSafeInteger(pane.bindingGeneration)?String(pane.bindingGeneration):null;
      const turn=typeof pane.nativeTurnId==='string'&&pane.nativeTurnId.length>0&&pane.nativeTurnId.length<=256?pane.nativeTurnId:null;
      const verified=pane.bindingVerification==='verified'&&generation!==null;
      const eligible=verified&&turn!==null&&pane.completionEligible===true;
      const completionKey=eligible?JSON.stringify([generation,turn]):null;
      const rebind=versioned&&previous&&previous.bindingGeneration!==generation;
      if(rebind) {
        queueClear(pane.id,previous.completionAcknowledged?null:previous.completionEventId);
        queueClear(pane.id,previous.attentionAcknowledged?null:previous.attentionEventId);
        decision('binding_changed_baseline',pane);
      }
      const prior=rebind?null:previous;
      const working=status==='working'||(prior?.working===true&&(status==='unknown'||(versioned&&status==='done'&&!eligible)));
      const previousAttentionKind=prior?.attentionKind??attentionKind(prior?.status);
      const next={status,working,bindingGeneration:versioned?generation:(prior?.bindingGeneration??null),
        completedTurnKey:prior?.completedTurnKey??null,
        completedTurnKeys:Array.isArray(prior?.completedTurnKeys)?prior.completedTurnKeys.slice(-128):[],
        completionEventId:prior?.completionEventId??null,completionAcknowledged:prior?.completionAcknowledged??false,
        acknowledgedCompletionEventIds:acknowledgedHistory(previous),attentionEventId:previous?.attentionEventId??null,
        attentionAcknowledged:prior?.attentionAcknowledged??false,acknowledgedAttentionEventIds:acknowledgedHistory(previous,'attention'),
        attentionKind:status==='unknown'?previousAttentionKind:attentionKind(status)};
      if(rebind) {
        next.attentionEventId=null;
        if(previous.completionEventId&&!previous.completionAcknowledged)
          next.acknowledgedCompletionEventIds=appendAcknowledged(next.acknowledgedCompletionEventIds,previous.completionEventId);
        if(previous.attentionEventId&&!previous.attentionAcknowledged)
          next.acknowledgedAttentionEventIds=appendAcknowledged(next.acknowledgedAttentionEventIds,previous.attentionEventId);
      }
      const kind=attentionKind(status);
      // Unknown is a gap in status knowledge, not a new alert generation.
      // blocked and needs_input describe the same outstanding attention.
      const sameAttention=kind&&kind===previousAttentionKind&&
        (prior?.status==='unknown'||attentionKind(prior?.status)===kind);
      // Herdr's idle status means the result was seen in the focused PC pane.
      // Reconcile persisted idle completions too, including after an upgrade.
      if(prior&&(status==='working'||status==='idle'))acknowledgeState(next,pane.id,'completion');
      if(prior&&(['working','idle','done'].includes(status)||
        (prior.status!==status&&(kind==='needs_input'||kind==='error')&&!sameAttention)))acknowledgeState(next,pane.id,'attention');
      if(versioned) {
        if(!prior) {
          if(completionKey) {
            next.completedTurnKey=completionKey;
            next.completedTurnKeys=[completionKey];
          }
          decision('baseline',pane);
        } else if((status==='done'||status==='idle')&&prior.working&&completionKey&&
          completionKey!==prior.completedTurnKey&&!next.completedTurnKeys.includes(completionKey)) {
          const stableId=createHash('sha256').update(JSON.stringify([pane.id,generation,turn])).digest('hex');
          const emitted=event(pane.id,'done',null,stableId);
          next.completedTurnKey=completionKey;
          next.completedTurnKeys=[...next.completedTurnKeys,completionKey].slice(-128);
          next.completionEventId=emitted.eventId;
          next.completionAcknowledged=status==='idle';
          if(status==='idle')next.acknowledgedCompletionEventIds=appendAcknowledged(next.acknowledgedCompletionEventIds,emitted.eventId);
          else if(c)data.queue.push(emitted);
          decision(status==='idle'?'seen_on_pc':'show_completion',pane);
        } else if(status==='done'&&prior.working&&!eligible)decision('suppress_unverified_completion',pane);
      } else if(prior&&prior.status!==status&&(status==='done'||status==='idle')&&prior.working) {
        // Pre-contract snapshots remain readable during an upgrade.
        const emitted=event(pane.id,'done');
        next.completionEventId=emitted.eventId;next.completionAcknowledged=status==='idle';
        if(status==='idle')next.acknowledgedCompletionEventIds=appendAcknowledged(next.acknowledgedCompletionEventIds,emitted.eventId);
        else if(c)data.queue.push(emitted);
      }
      if(prior&&prior.status!==status&&kind&&!sameAttention&&(!versioned||verified)) {
        const emitted=event(pane.id,kind);
        next.attentionEventId=emitted.eventId;next.attentionAcknowledged=false;
        if(c)data.queue.push(emitted);
        decision('show_attention',pane);
      } else if(kind&&versioned&&!verified)decision('suppress_unverified_attention',pane);
      states[pane.id]=next;
      if(JSON.stringify(previous)!==JSON.stringify(next))changed=true;
    }
    if(complete)for(const [id,state] of Object.entries(data.states))if(!present.has(id)) {
      queueClear(id,state.completionAcknowledged?null:state.completionEventId);
      queueClear(id,state.attentionAcknowledged?null:state.attentionEventId);
      changed=true;decision('pane_closed');
    }
    if(compactQueue())changed=true;
    if(changed) {data.states=states;save();}
    if(c)void flush();
    return annotate(snapshot);
  }
  function diagnostics() {
    const oldestCreated=data.queue.reduce((oldest,e)=>Math.min(oldest,e.createdAt||Math.floor(now()/1000)),Math.floor(now()/1000));
    const oldest=data.queue.length?Math.max(0,Math.floor(now()/1000)-oldestCreated):0;
    return {queueDepth:data.queue.length,pendingClears:data.queue.filter(e=>e.kind==='clear').length,oldestQueueAgeSeconds:oldest,
      failures,retryAfterSeconds:Math.max(0,Math.ceil((nextAttempt-now())/1000)),...counters,decisions:[...decisions]};
  }
  const timer=c?setInterval(()=>{void flush();},interval):null;timer?.unref();
  return {enabled:!!c,tracking:true,observe,annotate,completionFor,acknowledge,attentionFor,acknowledgeAttention,diagnostics,flush,close(){closed=true;if(timer)clearInterval(timer);}};
}
