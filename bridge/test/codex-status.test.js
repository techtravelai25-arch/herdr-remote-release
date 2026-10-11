import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {CodexStatus} from '../src/codex-status.js';
import {createBridge} from '../src/server.js';

function fixture(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'codex-status-'));
  const root=path.join(home,'.codex','sessions');fs.mkdirSync(root,{recursive:true});
  const file=path.join(root,'rollout.jsonl');fs.writeFileSync(file,'');
  const db=new DatabaseSync(path.join(home,'.codex','state_1.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,cwd TEXT,title TEXT,name TEXT,archived INTEGER,thread_source TEXT)');
  db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,0,'user')").run('11111111-1111-4111-8111-111111111111',file,home,'Thread','Thread');
  db.close();
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const pane={pane_id:'p1',terminal_id:'term1',workspace_id:'w1',tab_id:'t1',agent:'codex',agent_status:'working',
    cwd:home,terminal_title_stripped:'Thread | project',revision:1,agent_session:{agent:'codex',kind:'path',value:file},
    binding:{state:'verified',generation:'direct-fixture',sessionId:'11111111-1111-4111-8111-111111111111',reason:'fixture'}};
  const append=(type,turn_id,time)=>fs.appendFileSync(file,JSON.stringify({timestamp:new Date(time).toISOString(),type:'event_msg',payload:{type,turn_id}})+'\n');
  const status=new CodexStatus(home);
  return {home,file,pane,append,status};
}
test('native completion clears a retained working title and stays seen after PC focus',async t=>{
  const f=fixture(t);f.append('task_started','a',1000);
  assert.equal((await f.status.observe([f.pane],null))[0].agent_status,'working');
  f.append('task_complete','a',2000);
  assert.equal((await f.status.observe([f.pane],null))[0].agent_status,'done');
  assert.equal((await f.status.observe([f.pane],'p1'))[0].agent_status,'idle');
  assert.equal((await f.status.observe([f.pane],null))[0].agent_status,'idle');
  f.append('task_started','b',3000);
  assert.equal(f.status.status('p1','working'),'working');
  f.append('task_complete','b',4000);
  assert.equal(f.status.status('p1','working'),'done');
});
test('unsupported native event after completion cannot keep a stale Done correction',async t=>{
  const f=fixture(t);f.append('task_started','a',1000);f.append('task_complete','a',2000);
  await f.status.observe([f.pane],null);
  assert.equal(f.status.status('p1','working'),'done');
  fs.appendFileSync(f.file,JSON.stringify({type:'event_msg',payload:{type:'turn_started',turn_id:'b'}})+'\n');
  assert.equal(f.status.status('p1','working'),'working');
  assert.equal(f.status.status('p1','done'),'unknown');
  assert.equal(f.status.metadata('p1').nativeReason,'unsupported_schema');
});
test('completion in a stale other-project binding cannot finish the current pane',async t=>{
  const f=fixture(t);f.append('task_started','current',1000);
  const oldFile=path.join(f.home,'.codex/sessions/old.jsonl');
  fs.writeFileSync(oldFile,JSON.stringify({timestamp:new Date(2000).toISOString(),type:'event_msg',payload:{type:'task_complete',turn_id:'old'}})+'\n');
  const db=new DatabaseSync(path.join(f.home,'.codex/state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,cwd TEXT,title TEXT,name TEXT,archived INTEGER,thread_source TEXT)');
  const insert=db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,0,\'user\')');
  insert.run('old',oldFile,'/other','Old','Old');insert.run('current',f.file,f.home,'Thread','Thread');
  const stale={...f.pane,binding:undefined,agent_session:{agent:'codex',kind:'id',value:'old'}};
  assert.equal((await f.status.observe([stale],null))[0].agent_status,'working');
  f.append('task_complete','current',3000);
  assert.equal(f.status.status('p1','working'),'working','conflicting report cannot establish completion');
  assert.equal((await f.status.observe([f.pane],null))[0].agent_status,'done');
  insert.run('duplicate',f.file,f.home,'Thread','Thread');db.close();
  assert.equal((await f.status.observe([stale],null))[0].agent_status,'working','ambiguous replacement uses raw pane status');
});
test('abort, blocking states, explicit acknowledgement, and unsupported agents retain their meaning',async t=>{
  const f=fixture(t);f.append('task_started','a',1000);f.append('task_complete','a',2000);
  await f.status.observe([f.pane],null);
  assert.equal(f.status.status('p1','blocked'),'blocked');
  assert.equal(f.status.status('p1','idle'),'idle');
  assert.equal(f.status.status('p1','working'),'idle');
  f.append('task_started','b',3000);f.append('turn_aborted','b',4000);
  assert.equal(f.status.status('p1','working'),'idle');
  assert.equal((await f.status.observe([{...f.pane,agent:'claude'}],null))[0].agent_status,'working');
});
test('input invalidates the old completion before ACK, rejection restores it, and fast new reply survives ACK',async t=>{
  const f=fixture(t);f.append('task_started','a',1000);f.append('task_complete','a',2000);
  await f.status.observe([f.pane],null);
  const cancel=f.status.inputStarted(f.pane,3000);
  assert.equal(f.status.status('p1','working'),'working');
  cancel();assert.equal(f.status.status('p1','working'),'done');
  f.status.inputStarted(f.pane,3000);
  assert.equal(f.status.status('p1','working'),'working');
  f.append('task_started','b',4000);f.append('task_complete','b',5000);
  assert.equal(f.status.status('p1','working'),'done');
});
test('pane replacement clears correction and seen state; unreadable or partial native logs leave working',async t=>{
  const f=fixture(t);f.append('task_started','a',1000);f.append('task_complete','a',2000);
  await f.status.observe([f.pane],'p1');
  const replacement={...f.pane,terminal_id:'term2',binding:{...f.pane.binding,generation:'replacement-fixture'}};
  assert.equal((await f.status.observe([replacement],null))[0].agent_status,'done');
  fs.appendFileSync(f.file,'{"type":"event_msg"');
  assert.equal(f.status.status('p1','working'),'working');
  await f.status.observe([],null);assert.equal(f.status.status('p1','working'),'working');
});
test('title and foreground directory changes preserve dispatch barrier and seen completion for the same session',async t=>{
  const f=fixture(t);f.append('task_started','a',1000);f.append('task_complete','a',2000);
  await f.status.observe([f.pane],null);f.status.inputStarted(f.pane,3000);
  const renamed={...f.pane,terminal_title_stripped:'Renamed | elsewhere',foreground_cwd:'/elsewhere'};
  assert.equal((await f.status.observe([renamed],null))[0].agent_status,'working');
  f.append('task_started','b',4000);f.append('task_complete','b',5000);
  assert.equal((await f.status.observe([renamed],'p1'))[0].agent_status,'idle');
  assert.equal((await f.status.observe([f.pane],null))[0].agent_status,'idle');
});
test('a witnessed new turn can complete after its start leaves the bounded tail',async t=>{
  const f=fixture(t);f.append('task_started','a',1000);f.append('task_complete','a',2000);
  await f.status.observe([f.pane],null);f.status.inputStarted(f.pane,3000);
  f.append('task_started','b',4000);assert.equal(f.status.status('p1','working'),'working');
  fs.appendFileSync(f.file,JSON.stringify({type:'response_item',payload:{text:'x'.repeat(2*1024*1024)}})+'\n');
  f.append('task_complete','b',5000);
  assert.equal(f.status.status('p1','working'),'done');
});
test('confirmation within an active turn does not fence its later completion',async t=>{
  const f=fixture(t);f.append('task_started','a',1000);
  await f.status.observe([f.pane],null);f.status.inputStarted(f.pane,2000,true);
  f.append('task_complete','a',3000);assert.equal(f.status.status('p1','working'),'done');
});

test('bridge HTTP and immediate events reconcile native completion without duplicate reply alerts',async t=>{
  const f=fixture(t);f.append('task_started','a',1000);let hooks;let reads=0;
  const herdr={call:async method=>{
    if(method==='pane.get')return {pane:f.pane};
    if(method==='pane.process_info')return {process_info:{foreground_processes:[{name:'codex',pid:process.pid,cwd:f.home,argv:['codex']}]}};
    if(method==='pane.read')return {read:{text:'terminal',revision:1,truncated:false}};
    if(['pane.send_keys','pane.send_input','agent.prompt'].includes(method))return {accepted:true};
    assert.equal(method,'session.snapshot');reads++;
    return {snapshot:{protocol:22,workspaces:[{workspace_id:'w1'}],panes:[f.pane],agents:[],focused_pane_id:null}};
  }};
  const observed=[];
  const app=createBridge({socketPath:'/unused',stateDir:path.join(f.home,'state'),projects:[],activityTimeline:false},
    {herdr,homeDirectory:f.home,onSnapshot:data=>observed.push(data),statusEventsFactory:(_path,callbacks)=>{
      hooks=callbacks;return {update(){},close(){}};
    }});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>app.close());
  const credential=app.store.pair(app.store.pairCode(),'test');
  const get=async()=>{
    const response=await fetch(`http://127.0.0.1:${app.server.address().port}/v1/snapshot`,{headers:{Authorization:`Bearer ${credential.token}`}});
    assert.equal(response.status,200);return (await response.json()).panes[0];
  };
  assert.equal((await get()).status,'working');
  f.append('task_complete','a',2000);
  const before=reads;await hooks.onStatus({pane_id:'p1',agent_status:'working'});
  assert.equal(reads,before+1,'native event reconciliation rechecks the live binding');
  const done=await get();assert.equal(done.status,'done');assert.ok(done.completionEventId);
  await hooks.onStatus({pane_id:'p1',agent_status:'working'});
  assert.equal((await get()).completionEventId,done.completionEventId);
  f.append('task_started','b',3000);
  await hooks.onStatus({pane_id:'p1',agent_status:'working'});
  assert.equal((await get()).status,'working');
  await hooks.onStatus({pane_id:'p1',agent_status:'blocked'});
  assert.equal(observed.at(-1).panes[0].status,'blocked');
  await hooks.onStatus({pane_id:'p1',agent_status:'working'});
  f.append('task_complete','b',4000);
  const next=await get();assert.equal(next.status,'done');assert.notEqual(next.completionEventId,done.completionEventId);
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const headers={Authorization:`Bearer ${credential.token}`,'Content-Type':'application/json'};
  const output=await(await fetch(base+'/v1/panes/p1/output',{headers})).json();assert.ok(output.attachmentId);
  const act=async(action,body)=>{
    const response=await fetch(base+'/v1/panes/p1/'+action,{method:'POST',headers,
      body:JSON.stringify({attachmentId:output.attachmentId,...body})});
    assert.equal(response.status,200,await response.text());
  };
  await act('keys',{keys:['up']});assert.equal((await get()).status,'done');
  await act('input',{text:'draft without enter'});assert.equal((await get()).status,'done');
  await act('prompt',{text:'New task'});assert.equal((await get()).status,'working');
  const now=Date.now()+10;f.append('task_started','c',now);
  assert.equal((await get()).status,'working');
  await act('keys',{keys:['enter']});
  f.append('task_complete','c',now+10);assert.equal((await get()).status,'done');
  f.append('task_started','d',now+20);assert.equal((await get()).status,'working');
  await act('stop',{});f.append('turn_aborted','d',now+30);
  assert.equal((await get()).status,'idle');
});
