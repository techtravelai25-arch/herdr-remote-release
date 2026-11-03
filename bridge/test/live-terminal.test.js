import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {createPaneStreams} from '../src/pane-stream.js';
import {createBridge} from '../src/server.js';
import {createRelayHandler,generateIdentity,deriveKey,encryptPayload,decryptPayload} from '../src/relay.js';
import {Store} from '../src/store.js';

/** A fake herdr-core observe: the test pushes bytes, resizes and endings into each attach. */
function fakeCore() {
  const attaches=[];
  return {attaches,observe:async(paneId,handlers)=>{
    const attach={paneId,...handlers,closed:false,close(){attach.closed=true;}};
    attaches.push(attach);
    handlers.onData(Buffer.from(`PAINT${attaches.length}`));
    return {cols:80,rows:24,terminalId:'occupant-1',close:()=>attach.close()};
  }};
}

test('a stream replays from the acknowledged cursor and trims only what the client confirmed',async()=>{
  const core=fakeCore();const streams=createPaneStreams({core});
  await streams.open('k','hc:t1');
  let out=await streams.read('k',{});
  assert.equal(out.reset,true);assert.equal(out.data.toString(),'PAINT1');assert.deepEqual([out.cols,out.rows],[80,24]);
  core.attaches[0].onData(Buffer.from('abc'));
  const next=await streams.read('k',{epoch:out.epoch,seq:out.nextSeq});
  assert.equal(next.data.toString(),'abc');
  // A lost response: asking again with the same cursor returns the same bytes.
  assert.equal((await streams.read('k',{epoch:out.epoch,seq:out.nextSeq})).data.toString(),'abc');
  // Received but not yet rendered: a cursor past the bytes with an older ack keeps them for a replay.
  assert.equal((await streams.read('k',{epoch:out.epoch,seq:next.nextSeq,ack:out.nextSeq})).data.length,0);
  assert.equal((await streams.read('k',{epoch:out.epoch,seq:out.nextSeq,ack:out.nextSeq})).data.toString(),'abc');
  // Acknowledging past the bytes trims them; an older cursor then starts a fresh paint.
  await streams.read('k',{epoch:out.epoch,seq:next.nextSeq});
  out=await streams.read('k',{epoch:out.epoch,seq:0});
  assert.equal(out.reset,true);assert.equal(out.data.toString(),'PAINT2');
  assert.equal(core.attaches[0].closed,true);
  streams.closeAll();
});

test('a resize starts a new epoch at hc\'s replacement paint; overflow and an ended core reattach',async()=>{
  const core=fakeCore();const streams=createPaneStreams({core});
  await streams.open('k','hc:t1');
  const first=await streams.read('k',{});
  core.attaches[0].onResize(100,30);core.attaches[0].onData(Buffer.from('REPAINT'));
  const resized=await streams.read('k',{epoch:first.epoch,seq:first.nextSeq});
  assert.equal(resized.reset,true);assert.notEqual(resized.epoch,first.epoch);
  assert.deepEqual([resized.data.toString(),resized.cols,resized.rows],['REPAINT',100,30]);
  // A client that never acknowledges cannot hold more than 512 KiB: it gets a fresh paint.
  core.attaches[0].onData(Buffer.alloc(600*1024,65));
  const overflow=await streams.read('k',{epoch:resized.epoch,seq:resized.nextSeq});
  assert.equal(overflow.reset,true);assert.equal(overflow.data.toString(),'PAINT2');
  core.attaches[1].onEnd('core_lost');
  const ended=await streams.read('k',{epoch:overflow.epoch,seq:overflow.nextSeq});
  assert.equal(ended.ended,'core_lost');
  streams.closeAll();
});

async function fixture(t,{agent='codex',mode='normal',allowTerminalInput=false}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-live-'));
  const pane={pane_id:'hc:t1',terminal_id:'occupant-1',workspace_id:'hc:s',tab_id:'hc:t',cwd:dir,agent_status:'idle',revision:1,...(agent?{agent}:{})};
  const writes=[];let fail=null;
  const core=fakeCore();
  const herdr={observe:core.observe,call:async(method,params)=>{
    if(method==='session.snapshot')return {snapshot:{protocol:22,workspaces:[{workspace_id:'hc:s'}],panes:[pane],agents:[]}};
    if(method==='pane.get')return {pane};
    if(method==='pane.read')return {read:{text:'screen',revision:1,truncated:false}};
    if(method==='pane.send_text') {
      if(params.terminal_id!==pane.terminal_id)throw Object.assign(new Error('changed'),{code:'pane_changed',status:409});
      if(fail){const error=fail;fail=null;throw error;}
      writes.push(params.text);return {ok:true};
    }
    return {ok:true};
  }};
  const app=createBridge({socketPath:'/unused',stateDir:path.join(dir,'state'),projects:[],allowTerminalInput},{herdr});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const phone=app.store.pair(app.store.pairCode(),'phone'),other=app.store.pair(app.store.pairCode(),'tablet');
  if(mode!=='normal')app.store.write('access.json',{enabled:true,devices:{[phone.deviceId]:mode},accounts:{}});
  const request=async(route,method='GET',body,token=phone.token)=>{
    const response=await fetch(base+route,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const attachment=async(token=phone.token)=>(await request('/v1/panes/hc%3At1/output','GET',undefined,token)).body.attachmentId;
  return {app,base,pane,writes,core,phone,other,request,attachment,setFail:error=>{fail=error;}};
}

test('typed input is sequence-numbered: retries never type twice, conflicts and gaps stop the session',async t=>{
  const f=await fixture(t);
  const control=(await f.request('/v1/panes/hc%3At1/control','POST',{attachmentId:await f.attachment()})).body;
  const send=(seq,data,controlId=control.controlId)=>f.request('/v1/panes/hc%3At1/stream-input','POST',{controlId,seq,data});
  assert.equal((await send(1,'ls\r')).status,200);
  const retry=await send(1,'ls\r');
  assert.equal(retry.status,200);assert.equal(retry.body.duplicate,true);
  assert.deepEqual(f.writes,['ls\r']);
  assert.equal((await send(1,'rm\r')).body.error.code,'control_conflict');
  assert.equal((await send(3,'x')).body.error.code,'control_gap');
  assert.equal((await send(2,'\u001b[A')).status,200);
  assert.deepEqual(f.writes,['ls\r','\u001b[A']);
  assert.equal((await send(3,'x','f'.repeat(32))).body.error.code,'control_revoked');
});

test('one device controls a pane; takeover revokes the other device\'s session',async t=>{
  const f=await fixture(t);
  const mine=(await f.request('/v1/panes/hc%3At1/control','POST',{attachmentId:await f.attachment()})).body;
  const theirsAttachment=await f.attachment(f.other.token);
  assert.equal((await f.request('/v1/panes/hc%3At1/control','POST',{attachmentId:theirsAttachment},f.other.token)).body.error.code,'pane_controlled_elsewhere');
  const theirs=(await f.request('/v1/panes/hc%3At1/control','POST',{attachmentId:theirsAttachment,takeover:true},f.other.token)).body;
  assert.ok(theirs.controlId);
  assert.equal((await f.request('/v1/panes/hc%3At1/stream-input','POST',{controlId:mine.controlId,seq:1,data:'a'})).body.error.code,'control_revoked');
  assert.equal((await f.request('/v1/panes/hc%3At1/stream-input','POST',{controlId:theirs.controlId,seq:1,data:'b'},f.other.token)).status,200);
  assert.deepEqual(f.writes,['b']);
});

test('an uncertain write ends the session; a new occupant is never typed into; revocation stops input',async t=>{
  const f=await fixture(t);
  let control=(await f.request('/v1/panes/hc%3At1/control','POST',{attachmentId:await f.attachment()})).body;
  f.setFail(Object.assign(new Error('timeout'),{code:'herdr_timeout',status:504}));
  assert.equal((await f.request('/v1/panes/hc%3At1/stream-input','POST',{controlId:control.controlId,seq:1,data:'a'})).status,504);
  assert.equal((await f.request('/v1/panes/hc%3At1/stream-input','POST',{controlId:control.controlId,seq:1,data:'a'})).body.error.code,'control_uncertain');
  control=(await f.request('/v1/panes/hc%3At1/control','POST',{attachmentId:await f.attachment()})).body;
  f.pane.terminal_id='occupant-2';
  assert.equal((await f.request('/v1/panes/hc%3At1/stream-input','POST',{controlId:control.controlId,seq:1,data:'a'})).body.error.code,'pane_changed');
  f.pane.terminal_id='occupant-1';
  f.app.store.write('access.json',{enabled:false,devices:{},accounts:{}});
  assert.equal((await f.request('/v1/panes/hc%3At1/stream-input','POST',{controlId:control.controlId,seq:1,data:'a'})).status,403);
  assert.deepEqual(f.writes,[]);
});

test('typing into a plain shell needs the terminal grant; observers cannot take control',async t=>{
  const shell=await fixture(t,{agent:null});
  assert.equal((await shell.request('/v1/panes/hc%3At1/control','POST',{attachmentId:await shell.attachment()})).body.error.code,'terminal_input_disabled');
  const granted=await fixture(t,{agent:null,mode:'terminal',allowTerminalInput:true});
  assert.equal((await granted.request('/v1/panes/hc%3At1/control','POST',{attachmentId:await granted.attachment()})).status,200);
  const observer=await fixture(t,{mode:'observer'});
  assert.equal((await observer.request('/v1/panes/hc%3At1/control','POST',{attachmentId:await observer.attachment()})).status,403);
});

test('relayed phones long-poll the stream; direct phones receive it on their WebSocket and acknowledge it',async t=>{
  const f=await fixture(t);
  const attachmentId=await f.attachment();
  const first=(await f.request(`/v1/panes/hc%3At1/stream?attachmentId=${attachmentId}&wait=1`)).body;
  assert.equal(first.reset,true);assert.equal(Buffer.from(first.data,'base64').toString(),'PAINT1');
  const held=f.request(`/v1/panes/hc%3At1/stream?attachmentId=${attachmentId}&epoch=${first.epoch}&seq=${first.nextSeq}&wait=1`);
  await new Promise(resolve=>setTimeout(resolve,100));
  f.core.attaches[0].onData(Buffer.from('live'));
  const next=(await held).body;
  assert.equal(Buffer.from(next.data,'base64').toString(),'live');assert.equal(next.reset,false);
  // Direct WebSocket.
  const ws=new WebSocket(f.base.replace('http','ws')+'/v1/events',{headers:{Authorization:`Bearer ${f.phone.token}`}});
  const frames=[];ws.on('message',raw=>{const message=JSON.parse(raw);if(message.type==='pane-output')frames.push(message);});
  await once(ws,'open');
  ws.send(JSON.stringify({type:'subscribe',paneId:'hc:t1',attachmentId}));
  const deadline=Date.now()+2000;while(!frames.length&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
  assert.equal(frames[0].reset,true);assert.equal(Buffer.from(frames[0].data,'base64').toString(),'PAINT2');
  ws.send(JSON.stringify({type:'ack',epoch:frames[0].epoch,seq:frames[0].seq+6}));
  f.core.attaches[1].onData(Buffer.from('more'));
  while(frames.length<2&&Date.now()<deadline+1000)await new Promise(r=>setTimeout(r,20));
  assert.equal(Buffer.from(frames[1].data,'base64').toString(),'more');
  ws.close();
});

test('the relay holds at most three live polls and spends its per-laptop budget on live polls first',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-relay-budget-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const laptop={...generateIdentity(),id:'laptop-1'},phone=generateIdentity();
  let release;const gate=new Promise(resolve=>{release=resolve;});
  let big=false;
  const handler=createRelayHandler({identity:laptop,port:9,store:new Store(dir),
    fetchImpl:async url=>{if(url.pathname.endsWith('/stream')&&!big)await gate;return new Response(big?'x'.repeat(200*1024):'{}',{status:200});}});
  const call=async(method,pathName)=>{
    const id=crypto.randomUUID(),key=deriveKey(phone.privateKey,laptop.publicKey,laptop.id,id);
    const envelope={...encryptPayload(key,laptop.id,id,{method,path:pathName,headers:{},body:'',timestamp:Date.now()},'request'),epk:phone.publicKey};
    return decryptPayload(key,laptop.id,await handler(envelope,null),'response').status;
  };
  const held=[1,2,3].map(()=>call('GET','/v1/panes/hc%3At1/stream'));
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(await call('GET','/v1/panes/hc%3At1/stream'),429,'a fourth held poll is refused');
  assert.equal(await call('GET','/v1/snapshot'),200,'ordinary requests keep their slots');
  release();assert.deepEqual(await Promise.all(held),[200,200,200]);
  // About 20 MiB of relayed responses in one minute: live polls back off, reads and actions continue.
  big=true;
  for(let i=0;i<65;i++)await call('GET','/v1/snapshot');
  assert.equal(await call('GET','/v1/panes/hc%3At1/stream'),429);
  assert.equal(await call('GET','/v1/snapshot'),200);
  assert.equal(await call('POST','/v1/panes/hc%3At1/keys'),200);
});
