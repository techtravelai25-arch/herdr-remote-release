import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {createBridge} from '../src/server.js';

async function until(predicate) {
  for(let i=0;i<200;i++) {if(predicate())return;await delay(5);}
  assert.fail('Timed out waiting for completion state');
}
async function desktopFixture(t,ids=['p1']) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-desktop-ack-'));
  const statuses=new Map(ids.map(id=>[id,'idle']));let hooks;let submission;
  const rawPane=id=>({
    pane_id:id,terminal_id:`terminal-${id}`,workspace_id:'w1',tab_id:`tab-${id}`,cwd:'/tmp',revision:1,agent:'codex',agent_status:statuses.get(id)
  });
  const raw=()=>({snapshot:{protocol:22,workspaces:[{workspace_id:'w1'}],panes:ids.map(rawPane),agents:[]}});
  let provider=raw;
  const herdr={call:async(method,params)=>{
    if(method==='session.snapshot')return provider();
    if(method==='pane.get')return {pane:rawPane(params.pane_id)};
    if(method==='pane.read')return {read:{text:'terminal',revision:1,truncated:false}};
    if(method==='agent.prompt')return new Promise((resolve,reject)=>{submission={resolve,reject};});
    throw Error(`Unexpected RPC ${method}`);
  }};
  const app=createBridge({socketPath:'/unused-test-socket',stateDir:dir,projects:[],activityTimeline:false},
    {herdr,statusEventsFactory:(_path,callbacks)=>{hooks=callbacks;return {update(){},close(){}};}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const credential=app.store.pair(app.store.pairCode(),'phone');
  const base=`http://127.0.0.1:${app.server.address().port}`;const headers={Authorization:`Bearer ${credential.token}`};
  const ws=new WebSocket(base.replace('http','ws')+'/v1/events',{headers});
  const messages=[];ws.on('message',bytes=>messages.push(JSON.parse(bytes.toString())));ws.on('error',()=>{});
  t.after(async()=>{ws.terminate();await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  await once(ws,'open');await until(()=>messages.length>0);
  const latest=(id='p1')=>messages.at(-1).data.panes.find(p=>p.id===id);
  return {app,messages,hooks,raw,latest,setSnapshot:next=>{provider=next;},
    event:async(status,id='p1')=>{statuses.set(id,status);await hooks.onStatus({pane_id:id,workspace_id:'w1',agent_status:status});await until(()=>latest(id)?.status===status);},
    snapshot:async()=>{const response=await fetch(base+'/v1/snapshot',{headers});assert.equal(response.status,200);return response.json();},
    attachment:async(id='p1')=>(await(await fetch(`${base}/v1/panes/${id}/output`,{headers})).json()).attachmentId,
    prompt:(attachmentId,id='p1')=>fetch(`${base}/v1/panes/${id}/prompt`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({text:'Continue',attachmentId})}),
    waitPrompt:()=>until(()=>submission),
    finishPrompt:error=>{const pending=submission;submission=undefined;error?pending.reject(error):pending.resolve({accepted:true});}
  };
}

test('PC opening a done pane publishes its exact completion acknowledgement to HTTP and WebSocket',async t=>{
  const f=await desktopFixture(t);await f.event('working');await f.event('done');
  const done=f.latest();assert.equal(done.completionAcknowledged,false);
  await f.event('idle');const seen=f.latest();
  assert.equal(seen.completionEventId,done.completionEventId);assert.equal(seen.completionAcknowledged,true);
  assert.deepEqual(seen.acknowledgedCompletionEventIds,[done.completionEventId]);
  const http=(await f.snapshot()).panes[0];
  assert.equal(http.completionEventId,done.completionEventId);assert.equal(http.completionAcknowledged,true);
  assert.deepEqual(http.acknowledgedCompletionEventIds,[done.completionEventId]);
});

test('a completion seen on PC directly from working arrives already acknowledged on both snapshot channels',async t=>{
  const f=await desktopFixture(t);await f.event('working');await f.event('idle');
  const idle=f.latest();assert.ok(idle.completionEventId);assert.equal(idle.completionAcknowledged,true);
  assert.deepEqual(idle.acknowledgedCompletionEventIds,[idle.completionEventId]);
  assert.ok(f.messages.every(message=>!message.data.panes.some(p=>p.completionEventId===idle.completionEventId&&!p.completionAcknowledged)));
  const http=(await f.snapshot()).panes[0];
  assert.equal(http.completionEventId,idle.completionEventId);assert.equal(http.completionAcknowledged,true);
  assert.deepEqual(http.acknowledgedCompletionEventIds,[idle.completionEventId]);
});

test('PC response resolves attention for its pane and leaves another pane alert pending',async t=>{
  const f=await desktopFixture(t,['p1','p2']);
  for(const id of ['p1','p2']) {await f.event('working',id);await f.event('blocked',id);}
  const first=f.latest('p1').attentionEventId;const other=f.latest('p2').attentionEventId;
  assert.notEqual(first,other);await f.event('working','p1');
  assert.equal(f.latest('p1').attentionAcknowledged,true);assert.deepEqual(f.latest('p1').acknowledgedAttentionEventIds,[first]);
  assert.equal(f.latest('p2').attentionEventId,other);assert.equal(f.latest('p2').attentionAcknowledged,false);
  assert.deepEqual(f.latest('p2').acknowledgedAttentionEventIds,[]);
  const http=(await f.snapshot()).panes;
  assert.equal(http.find(p=>p.id==='p1').attentionAcknowledged,true);assert.equal(http.find(p=>p.id==='p2').attentionAcknowledged,false);
});

test('an older idle RPC cannot clear a newer completion or attention status event',async t=>{
  const f=await desktopFixture(t);let release;let started=false;
  const oldIdle=f.raw();f.setSnapshot(()=>{started=true;return new Promise(resolve=>{release=resolve;});});
  const refresh=f.hooks.onReady();await until(()=>started);
  await f.event('working');await f.event('done');const completion=f.latest().completionEventId;
  await f.event('blocked');const attention=f.latest().attentionEventId;
  release(oldIdle);await refresh;
  assert.equal(f.latest().status,'blocked');assert.equal(f.latest().completionEventId,completion);
  assert.equal(f.latest().completionAcknowledged,false);assert.equal(f.latest().attentionEventId,attention);
  assert.equal(f.latest().attentionAcknowledged,false);
  assert.deepEqual(f.app.store.read('push-outbox.json').states.p1.acknowledgedCompletionEventIds,[]);
});

test('a rejected prompt preserves completion and attention without publishing an acknowledgement',async t=>{
  const f=await desktopFixture(t);await f.event('working');await f.event('done');await f.event('blocked');
  const before=f.latest();const request=f.prompt(await f.attachment());await f.waitPrompt();
  f.finishPrompt(Error('Herdr rejected input'));assert.equal((await request).status,500);
  const after=(await f.snapshot()).panes[0];
  for(const type of ['completion','attention']) {
    assert.equal(after[`${type}EventId`],before[`${type}EventId`]);assert.equal(after[`${type}Acknowledged`],false);
    assert.equal(f.latest()[`${type}Acknowledged`],false);
  }
});
for(const [type,status] of [['completion','done'],['attention','blocked']]) {
  test(`local bridge acknowledges only the captured ${type} alert after prompt success`,async t=>{
    const f=await desktopFixture(t);const idField=`${type}EventId`;const ackField=`${type}Acknowledged`;
    const historyField=type==='completion'?'acknowledgedCompletionEventIds':'acknowledgedAttentionEventIds';
    await f.event('working');await f.event(status);
    const first=f.latest()[idField];assert.ok(first);assert.equal(f.latest()[ackField],false);
    assert.equal((await f.snapshot()).panes[0][idField],first);
    const attachmentId=await f.attachment();const request=f.prompt(attachmentId);await f.waitPrompt();
    await f.event('working');await f.event(status);const second=f.latest()[idField];assert.notEqual(second,first);
    f.finishPrompt();assert.equal((await request).status,200);
    const after=(await f.snapshot()).panes[0];assert.equal(after[idField],second);assert.equal(after[ackField],false);
    assert.equal(f.app.store.read('push-outbox.json').states.p1[idField],second);
    const next=f.prompt(attachmentId);await f.waitPrompt();f.finishPrompt();assert.equal((await next).status,200);
    await until(()=>f.latest()[ackField]);const acknowledged=(await f.snapshot()).panes[0];
    assert.equal(acknowledged[idField],second);assert.equal(acknowledged[ackField],true);
    assert.deepEqual(acknowledged[historyField],[first,second]);assert.deepEqual(f.latest()[historyField],[first,second]);
  });
}
