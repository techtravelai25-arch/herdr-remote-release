import {randomBytes} from 'node:crypto';
import {BridgeError} from './herdr.js';

const BUFFER_LIMIT=512*1024;
const IDLE_MS=60000;
const REOPEN_DELAY_MS=1000;

/**
 * Live terminal subscriptions, one per phone (and transport) per pane.
 *
 * Each subscription owns its own herdr-core observe attach, so its bytes start
 * with hc's complete paint and stay contiguous. Bytes are kept from the last
 * acknowledged cursor until the client confirms it rendered them. An `epoch`
 * names one contiguous byte sequence; `seq` is a byte offset within it. A resize,
 * an overflow, a lost core or an expired cursor starts a new epoch whose first
 * bytes are a complete paint, which the client applies as a reset.
 */
export function createPaneStreams({core,now=Date.now,idleMs=IDLE_MS}) {
  const subscriptions=new Map();
  function wake(sub){const waiters=[...sub.waiters];sub.waiters.clear();for(const resolve of waiters)resolve();}
  function newEpoch(sub,cols,rows){sub.epoch=randomBytes(8).toString('hex');sub.base=0;sub.end=0;sub.chunks=[];sub.cols=cols;sub.rows=rows;sub.expired=false;}
  async function attach(sub) {
    // Callbacks of a superseded attach (after a restart or close) are ignored.
    const generation=++sub.generation;
    const live=()=>sub.generation===generation&&!sub.closed;
    sub.ended=null;sub.handle=null;
    try {
      const handle=await core.observe(sub.paneId,{
        onData:bytes=>{
          if(!live())return;
          sub.chunks.push(bytes);sub.end+=bytes.length;
          // A client that stops acknowledging cannot hold more than the limit: it gets a fresh paint instead.
          if(sub.end-sub.base>BUFFER_LIMIT)sub.expired=true;
          wake(sub);
        },
        onResize:(cols,rows)=>{if(live()){newEpoch(sub,cols,rows);wake(sub);}},
        onEnd:reason=>{if(live()){sub.ended=reason;sub.reopenAt=now()+REOPEN_DELAY_MS;wake(sub);}},
      });
      if(!live()){handle.close();return;}
      sub.handle=handle;sub.terminalId=handle.terminalId;sub.cols=handle.cols;sub.rows=handle.rows;
    } catch(error) {
      if(live()){sub.ended=error.code||'attach_failed';sub.reopenAt=now()+REOPEN_DELAY_MS;}
      throw error;
    }
  }
  async function restart(sub) {
    sub.generation++;
    const old=sub.handle;sub.handle=null;old?.close();
    newEpoch(sub,sub.cols,sub.rows);
    await attach(sub);
  }
  async function open(key,paneId) {
    let sub=subscriptions.get(key);
    if(sub&&sub.paneId!==paneId){close(key);sub=null;}
    if(!sub) {
      sub={key,paneId,waiters:new Set(),lastUsed:now(),closed:false,handle:null,generation:0,ended:null,reopenAt:0};
      newEpoch(sub,0,0);
      subscriptions.set(key,sub);
      try{await attach(sub);}catch(error){close(key);throw error;}
    }
    sub.lastUsed=now();
    return sub;
  }
  /** Bytes after `seq` in `epoch`; a different epoch, an expired cursor or an ended stream yields a fresh epoch. */
  async function read(key,{epoch=null,seq=0,ack=seq,max=128*1024}={}) {
    const sub=subscriptions.get(key);
    if(!sub)throw new BridgeError('stream_closed','The live terminal closed. Open it again.',409);
    sub.lastUsed=now();
    if(sub.expired||(sub.ended&&now()>=sub.reopenAt))await restart(sub);
    let reset=false;
    if(epoch!==sub.epoch){reset=true;seq=0;}
    else if(!Number.isSafeInteger(seq)||seq<sub.base||seq>sub.end){await restart(sub);reset=true;seq=0;}
    // `ack` is what the client rendered; bytes after it stay for a replay, bytes from `seq` are new.
    else acknowledge(sub,Number.isSafeInteger(ack)&&ack>=sub.base&&ack<=seq?ack:sub.base);
    if(seq<sub.base){await restart(sub);reset=true;seq=0;}
    const data=slice(sub,seq,max);
    return {epoch:sub.epoch,seq,nextSeq:seq+data.length,data,reset,cols:sub.cols,rows:sub.rows,ended:sub.ended};
  }
  function acknowledge(sub,seq) {
    while(sub.chunks.length&&sub.base+sub.chunks[0].length<=seq){sub.base+=sub.chunks[0].length;sub.chunks.shift();}
  }
  function ack(key,epoch,seq) {
    const sub=subscriptions.get(key);
    if(sub&&epoch===sub.epoch&&Number.isSafeInteger(seq)&&seq>=sub.base&&seq<=sub.end){acknowledge(sub,seq);sub.lastUsed=now();}
  }
  function slice(sub,seq,max) {
    const out=[];let offset=sub.base,size=0;
    for(const chunk of sub.chunks) {
      const start=Math.max(seq-offset,0);offset+=chunk.length;
      if(start>=chunk.length)continue;
      const part=chunk.subarray(start,start+Math.max(0,max-size));
      out.push(part);size+=part.length;
      if(size>=max)break;
    }
    return Buffer.concat(out);
  }
  /** Resolves once there are bytes past `seq` in `epoch`, the epoch changes, the stream ends, or the wait times out. */
  function wait(key,{epoch,seq,timeoutMs,signal}) {
    const sub=subscriptions.get(key);
    if(!sub||sub.epoch!==epoch||sub.end>seq||sub.ended||sub.expired)return Promise.resolve();
    return new Promise(resolve=>{
      const done=()=>{clearTimeout(timer);sub.waiters.delete(done);signal?.removeEventListener('abort',done);resolve();};
      const timer=setTimeout(done,timeoutMs);
      sub.waiters.add(done);signal?.addEventListener('abort',done,{once:true});
    });
  }
  function close(key) {
    const sub=subscriptions.get(key);if(!sub)return;
    sub.closed=true;sub.generation++;subscriptions.delete(key);sub.handle?.close();wake(sub);
  }
  const sweep=setInterval(()=>{for(const [key,sub] of subscriptions)if(now()-sub.lastUsed>idleMs)close(key);},Math.min(idleMs,15000));
  sweep.unref?.();
  return {open,read,ack,wait,close,info:key=>subscriptions.get(key)??null,
    closeAll(){clearInterval(sweep);for(const key of [...subscriptions.keys()])close(key);},get size(){return subscriptions.size;}};
}
