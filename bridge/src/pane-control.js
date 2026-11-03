import {randomBytes,createHash} from 'node:crypto';
import {requireAccess} from './access.js';
import {reject,onlyParams} from './http-util.js';

const POLL_HOLD_MS=15000;
const POLL_BATCH_MS=250;
const MAX_INPUT_BYTES=4096;
const UNCERTAIN=new Set(['herdr_timeout','herdr_disconnected','herdr_socket_error','internal_error']);
const instance=randomBytes(8).toString('hex');
const digest=data=>createHash('sha256').update(data).digest('hex');

/**
 * Live terminal control: watching (stream long-poll; the direct WebSocket uses
 * the same subscriptions) and typing through one control session per pane.
 *
 * A control session belongs to one device, this bridge process and the pane's
 * occupant. Input batches carry consecutive sequence numbers: a repeated batch
 * with the same bytes is acknowledged without typing it again; a different
 * batch for a used number or a gap stops the session. Every write rechecks the
 * device, its permissions, the session and the occupant inside the pane lock.
 * A write that may or may not have reached the program ends the session.
 */
export function createPaneControl(ctx) {
  const {config,store,herdr,paneAttachments,streams}=ctx;
  const controls=new Map(),held=new Map();
  const accessFor=(device,current)=>{
    requireAccess(store,device,'write',config);
    if(!current.agent)requireAccess(store,device,'terminal',config);
  };
  async function takeControl(device,id,b) {
    if(Object.keys(b).some(key=>!['attachmentId','takeover'].includes(key)))reject('invalid_control','Unsupported control request.');
    const current=await ctx.pane(id);
    paneAttachments.validate(device.deviceId,current,b.attachmentId);
    accessFor(device,current);
    const existing=controls.get(id);
    if(existing&&existing.deviceId!==device.deviceId&&b.takeover!==true)
      reject('pane_controlled_elsewhere','Another device is controlling this pane. Take over to continue.',409);
    const session={controlId:randomBytes(16).toString('hex'),deviceId:device.deviceId,instance,terminalId:current.terminal_id,
      nextSeq:1,digests:new Map(),uncertain:false};
    controls.set(id,session);
    return {controlId:session.controlId,nextSeq:1};
  }
  function releaseControl(device,id) {
    const existing=controls.get(id);
    if(existing&&existing.deviceId===device.deviceId)controls.delete(id);
    return {released:true};
  }
  async function input(req,device,id,b) {
    if(Object.keys(b).some(key=>!['controlId','seq','data'].includes(key)))reject('invalid_input','Unsupported input request.');
    ctx.rate(`${device.deviceId}:input`,600);
    if(typeof b.controlId!=='string'||!Number.isSafeInteger(b.seq)||b.seq<1||typeof b.data!=='string'||!b.data.length||
      Buffer.byteLength(b.data)>MAX_INPUT_BYTES)reject('invalid_input','Send up to 4 KiB of input with its sequence number.');
    const owned=()=>{
      const session=controls.get(id);
      if(!session||session.controlId!==b.controlId||session.deviceId!==device.deviceId||session.instance!==instance)
        reject('control_revoked','You no longer control this pane. Take control again.',409);
      return session;
    };
    const checksum=digest(b.data);
    let session=owned();
    if(b.seq<session.nextSeq) {
      if(session.digests.get(b.seq)===checksum)return {ok:true,seq:b.seq,duplicate:true};
      reject('control_conflict','This input does not match what was already typed. Take control again.',409);
    }
    if(b.seq>session.nextSeq)reject('control_gap','Some input was not delivered. Take control again.',409);
    if(session.uncertain)reject('control_uncertain','The last input may not have arrived. Check the terminal, then take control again.',409);
    return ctx.locked(id,async()=>{
      // Recheck everything at the moment of writing: takeover, revocation and a new occupant all stop here.
      const {device:fresh}=await ctx.auth(req);
      if(fresh.deviceId!==device.deviceId)reject('control_revoked','You no longer control this pane. Take control again.',409);
      session=owned();
      if(session.uncertain)reject('control_uncertain','The last input may not have arrived. Check the terminal, then take control again.',409);
      if(b.seq!==session.nextSeq)reject('control_gap','Some input was not delivered. Take control again.',409);
      const current=await ctx.pane(id);
      accessFor(fresh,current);
      try {
        await herdr.call('pane.send_text',{pane_id:id,text:b.data,terminal_id:session.terminalId});
      } catch(error) {
        if(UNCERTAIN.has(error.code))session.uncertain=true;
        throw error;
      }
      session.digests.set(b.seq,checksum);
      for(const seq of session.digests.keys())if(seq<b.seq-64)session.digests.delete(seq);
      session.nextSeq=b.seq+1;
      ctx.acceptedInput(current);
      return {ok:true,seq:b.seq};
    });
  }
  /** Long-poll for live bytes after a cursor. Used by relayed phones; direct phones use the WebSocket. */
  async function poll(req,url,device,id) {
    onlyParams(url,['attachmentId','epoch','seq','ack','wait'],'invalid_stream','Use one attachment, cursor and wait flag.');
    ctx.rate(`${device.deviceId}:stream`,300);
    const current=await ctx.pane(id);
    paneAttachments.validate(device.deviceId,current,url.searchParams.get('attachmentId'));
    const key=`poll:${device.deviceId}:${id}`;
    await streams.open(key,id);
    const epoch=url.searchParams.get('epoch')||null;
    const seq=Number.parseInt(url.searchParams.get('seq')??'0',10);
    const ack=url.searchParams.has('ack')?Number.parseInt(url.searchParams.get('ack'),10):seq;
    let result=await streams.read(key,{epoch,seq:Number.isSafeInteger(seq)?seq:0,ack});
    // A fresh epoch can be announced before hc's paint arrives: wait for it too, keeping the reset.
    if(url.searchParams.get('wait')==='1'&&!result.data.length&&!result.ended) {
      const reset=result.reset;
      // One held poll per phone and pane: a newer poll releases the older one.
      held.get(key)?.abort();
      const controller=new AbortController();held.set(key,controller);
      req.on('close',()=>controller.abort());
      await streams.wait(key,{epoch:result.epoch,seq:result.nextSeq,timeoutMs:POLL_HOLD_MS,signal:controller.signal});
      if(!controller.signal.aborted)await new Promise(resolve=>setTimeout(resolve,POLL_BATCH_MS));
      if(held.get(key)===controller)held.delete(key);
      const next=await streams.read(key,{epoch:result.epoch,seq:result.nextSeq});
      result={...next,reset:next.reset||reset};
    }
    // Authorization is rechecked for every delivery, including a held poll.
    const {device:fresh}=await ctx.auth(req);
    if(fresh.deviceId!==device.deviceId)reject('unauthorized','Sign in again.',401);
    return {epoch:result.epoch,seq:result.seq,nextSeq:result.nextSeq,reset:result.reset,cols:result.cols,rows:result.rows,
      ended:result.ended,data:result.data.toString('base64')};
  }
  return {takeControl,releaseControl,input,poll,
    close(){for(const controller of held.values())controller.abort();held.clear();controls.clear();}};
}
