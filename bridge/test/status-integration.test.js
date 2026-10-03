import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {createBridge} from '../src/server.js';

async function until(predicate, timeout=2500) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) { if(predicate())return;await delay(5); }
  assert.fail('Timed out waiting for integration state');
}
function raw(status='idle') {
  return {snapshot:{protocol:22,workspaces:[{workspace_id:'w1',label:'Project'}],panes:[{
    pane_id:'p1',workspace_id:'w1',tab_id:'t1',cwd:'/tmp',revision:1,agent:'codex',agent_status:status,title:'Agent'
  }],agents:[]}};
}
async function fixture(t,{pushEnabled=false,activityTimeline=false}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-status-integration-'));
  const observed=[];const updates=[];const sockets=[];let hooks;let closed=false;let reads=0;let snapshotProvider=()=>raw();
  const push={enabled:pushEnabled,observe:data=>observed.push(structuredClone(data)),close:()=>{}};
  const herdr={call:async(method)=>{assert.equal(method,'session.snapshot');reads++;return snapshotProvider();}};
  const app=createBridge({socketPath:'/unused-test-socket',stateDir:dir,projects:[],allowTerminalInput:false,activityTimeline},{
    herdr,push,statusEventsFactory:(_socketPath,callbacks)=>{
      hooks=callbacks;return {update:panes=>updates.push(panes.map(p=>typeof p==='string'?p:p.id)),close:()=>{closed=true;}};
    }
  });
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const credential=app.store.pair(app.store.pairCode(),'test phone');
  let appClosed=false;
  const close=async()=>{if(appClosed)return;appClosed=true;for(const ws of sockets)ws.terminate();await app.close();};
  t.after(async()=>{await close();fs.rmSync(dir,{recursive:true,force:true});});
  return {app,push,observed,updates,hooks,credential,close,get closed(){return closed;},get reads(){return reads;},
    setSnapshot:provider=>{snapshotProvider=provider;},
    connect:async()=>{
      const messages=[];const ws=new WebSocket(`ws://127.0.0.1:${app.server.address().port}/v1/events`,{headers:{Authorization:`Bearer ${credential.token}`}});
      ws.on('error',()=>{});ws.on('message',payload=>messages.push(JSON.parse(payload.toString())));sockets.push(ws);
      await once(ws,'open');await until(()=>messages.length>0);return {ws,messages};
    }
  };
}
const event=agent_status=>({pane_id:'p1',workspace_id:'w1',agent_status});
const statuses=messages=>messages.map(message=>message.data.panes[0]?.status);

test('rapid structured transitions reach authenticated WebSocket and push observer before polling',async t=>{
  const f=await fixture(t);const client=await f.connect();const reads=f.reads;
  const start=Date.now();
  await f.hooks.onStatus(event('working'));
  await f.hooks.onStatus(event('blocked'));
  await f.hooks.onStatus(event('working'));
  await f.hooks.onStatus(event('done'));
  await until(()=>client.messages.length===5);
  assert.ok(Date.now()-start<900,'transitions should publish immediately without the one-second poll');
  assert.equal(f.reads,reads,'events must not need another RPC snapshot');
  assert.deepEqual(statuses(client.messages),['idle','working','blocked','working','done']);
  assert.deepEqual(f.observed.map(s=>s.panes[0].status),['idle','working','blocked','working','done']);
  assert.ok(f.updates.some(ids=>ids.includes('p1')));
});

test('snapshot begun before a status event cannot overwrite the newer event',async t=>{
  const f=await fixture(t);const client=await f.connect();let release;let started=false;
  f.setSnapshot(()=>{started=true;return new Promise(resolve=>release=resolve);});
  const reconcile=f.hooks.onReady();await until(()=>started);
  await f.hooks.onStatus(event('working'));await f.hooks.onStatus(event('done'));
  release(raw('idle'));await reconcile;
  await until(()=>statuses(client.messages).includes('done'));
  assert.equal(f.observed.at(-1).panes[0].status,'done');
  const done=client.messages.findIndex(m=>m.data.panes[0].status==='done');
  assert.ok(client.messages.slice(done).every(m=>m.data.panes[0].status==='done'));
});

test('an outage retains the latest status event in the cached snapshot',async t=>{
  const f=await fixture(t);await f.connect();await f.hooks.onStatus(event('blocked'));
  f.setSnapshot(()=>{throw new Error('Herdr offline');});
  await f.hooks.onReady();
  assert.equal(f.observed.at(-1).stale,true);
  assert.equal(f.observed.at(-1).panes[0].status,'blocked');
});

test('subscription stops without WebSocket or configured monitoring, and closes with bridge',async t=>{
  const f=await fixture(t);const client=await f.connect();
  client.ws.close();await once(client.ws,'close');
  await until(()=>f.updates.at(-1)?.length===0,1500);
  await f.close();assert.equal(f.closed,true);
});

test('configured push maintains structured subscription without a phone WebSocket',async t=>{
  const f=await fixture(t,{pushEnabled:true});
  await until(()=>f.updates.some(ids=>ids.includes('p1')),1500);
  const reads=f.reads;await f.hooks.onStatus(event('working'));await f.hooks.onStatus(event('blocked'));
  assert.equal(f.reads,reads);assert.equal(f.observed.at(-1).panes[0].status,'blocked');
  f.push.enabled=false;await until(()=>f.updates.at(-1)?.length===0,1500);
});

test('revocation is rechecked before event publication and closes the former client',async t=>{
  const f=await fixture(t);const client=await f.connect();
  f.app.store.revoke(f.credential.deviceId);
  const ended=once(client.ws,'close');await f.hooks.onStatus(event('working'));const [code]=await ended;
  assert.equal(code,4001);assert.deepEqual(statuses(client.messages),['idle']);
});

test('unknown pane events do not publish fabricated snapshots',async t=>{
  const f=await fixture(t);const client=await f.connect();const count=f.observed.length;
  await f.hooks.onStatus({...event('done'),pane_id:'unknown'});
  assert.equal(f.observed.length,count);assert.deepEqual(statuses(client.messages),['idle']);
});

test('a snapshot already in flight before reconciliation cannot overwrite a newer event',async t=>{
  const f=await fixture(t);await f.connect();let release;let started=false;
  f.setSnapshot(()=>{started=true;return new Promise(resolve=>release=resolve);});
  const request=f.app.snapshot();await until(()=>started);
  await f.hooks.onStatus(event('working'));await f.hooks.onStatus(event('done'));
  const reconciliation=f.hooks.onReady();release(raw('idle'));
  await request;await reconciliation;
  assert.equal(f.observed.at(-1).panes[0].status,'done');
});


test('configured timeline keeps status monitoring without a phone or push',async t=>{
  const f=await fixture(t,{activityTimeline:true});
  await until(()=>f.updates.some(ids=>ids.includes('p1')),1500);
  await f.hooks.onStatus(event('working'));await f.hooks.onStatus(event('done'));
  const response=await fetch(`http://127.0.0.1:${f.app.server.address().port}/v1/activity`,{headers:{Authorization:`Bearer ${f.credential.token}`}});
  const activity=await response.json();assert.equal(activity.events[0].status,'done');assert.equal(activity.events[1].status,'working');
});
