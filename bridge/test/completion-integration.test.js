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
test('local bridge annotates HTTP and WebSocket snapshots and acknowledges only the prompt target',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-completion-'));
  let status='idle';let hooks;let submit;
  const herdr={call:async(method)=>{
    if(method==='session.snapshot')return {snapshot:{protocol:22,workspaces:[{workspace_id:'w1'}],panes:[{pane_id:'p1',terminal_id:'terminal-1',workspace_id:'w1',tab_id:'t1',cwd:'/tmp',revision:1,agent:'codex',agent_status:status}],agents:[]}};
    if(method==='pane.get')return {pane:{pane_id:'p1',terminal_id:'terminal-1',workspace_id:'w1',tab_id:'t1',agent:'codex',cwd:'/tmp',agent_status:status}};
    if(method==='pane.read')return {read:{text:'terminal',revision:1,truncated:false}};
    if(method==='agent.prompt')return new Promise(resolve=>{submit=resolve;});
    throw Error(`Unexpected RPC ${method}`);
  }};
  const app=createBridge({socketPath:'/unused-test-socket',stateDir:dir,projects:[],activityTimeline:false},
    {herdr,statusEventsFactory:(_path,callbacks)=>{hooks=callbacks;return {update(){},close(){}};}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const credential=app.store.pair(app.store.pairCode(),'phone');
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const headers={Authorization:`Bearer ${credential.token}`};
  const ws=new WebSocket(base.replace('http','ws')+'/v1/events',{headers});
  const messages=[];ws.on('message',bytes=>messages.push(JSON.parse(bytes.toString())));ws.on('error',()=>{});
  t.after(async()=>{ws.terminate();await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  await once(ws,'open');await until(()=>messages.length>0);
  const event=agent_status=>hooks.onStatus({pane_id:'p1',workspace_id:'w1',agent_status});
  await event('working');await event('done');
  await until(()=>messages.length>=3);
  const first=messages.at(-1).data.panes[0].completionEventId;
  assert.ok(first);assert.equal(messages.at(-1).data.panes[0].completionAcknowledged,false);
  status='done';
  const response=await fetch(base+'/v1/snapshot',{headers});const snapshot=await response.json();
  assert.equal(snapshot.panes[0].completionEventId,first);
  const attachmentId=(await(await fetch(base+'/v1/panes/p1/output',{headers})).json()).attachmentId;
  const request=fetch(base+'/v1/panes/p1/prompt',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({text:'Continue',attachmentId})});
  await until(()=>typeof submit==='function');
  await event('working');await event('done');
  await until(()=>messages.length>=5);
  const second=messages.at(-1).data.panes[0].completionEventId;
  assert.notEqual(second,first);
  submit({accepted:true});assert.equal((await request).status,200);
  const after=await (await fetch(base+'/v1/snapshot',{headers})).json();
  assert.equal(after.panes[0].completionEventId,second);
  assert.equal(after.panes[0].completionAcknowledged,false);
  assert.equal(app.store.read('push-outbox.json').states.p1.completionEventId,second);
  submit=undefined;
  const nextRequest=fetch(base+'/v1/panes/p1/prompt',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({text:'Continue again',attachmentId})});
  await until(()=>typeof submit==='function');submit({accepted:true});
  assert.equal((await nextRequest).status,200);
  const acknowledged=await (await fetch(base+'/v1/snapshot',{headers})).json();
  assert.equal(acknowledged.panes[0].completionEventId,second);
  assert.equal(acknowledged.panes[0].completionAcknowledged,true);
  assert.deepEqual(acknowledged.panes[0].acknowledgedCompletionEventIds,[first,second]);
});
