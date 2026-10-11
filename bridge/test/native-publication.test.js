import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {createBridge} from '../src/server.js';

const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
const procStart=()=>fs.readFileSync(`/proc/${process.pid}/stat`,'utf8').split(') ').at(-1).split(' ')[19];
const codexEvent=(type,turn,time)=>JSON.stringify({type:'event_msg',timestamp:new Date(time).toISOString(),payload:{type,turn_id:turn}})+'\n';
const claudeRecord=(type,time,extra={})=>JSON.stringify({type,timestamp:new Date(time).toISOString(),...extra})+'\n';

async function fixture(t,agent) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'native-publication-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const files=[];
  if(agent==='codex') {
    const dir=path.join(home,'.codex','sessions');fs.mkdirSync(dir,{recursive:true});
    const db=new DatabaseSync(path.join(home,'.codex','state_5.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,cwd TEXT,title TEXT,name TEXT,archived INTEGER,thread_source TEXT)');
    for(let i=0;i<2;i++) {
      const file=path.join(dir,`rollout-${ids[i]}.jsonl`);fs.writeFileSync(file,'');files.push(file);
      db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,0,'user')").run(ids[i],file,home,`Thread ${i}`,`Thread ${i}`);
    }
    db.close();
  } else {
    const dir=path.join(home,'.claude','projects','project');fs.mkdirSync(dir,{recursive:true});
    for(const id of ids) {const file=path.join(dir,`${id}.jsonl`);fs.writeFileSync(file,'');files.push(file);}
    const sessionDir=path.join(home,'.claude','sessions');fs.mkdirSync(sessionDir,{recursive:true});
  }
  let index=0,rawStatus='working',clock=10_000,holdNext=null,hooks;
  const observed=[];
  const pane=()=>({pane_id:'p',terminal_id:'terminal',workspace_id:'w',tab_id:'t',cwd:home,
    agent,agent_status:rawStatus,terminal_title_stripped:`Thread ${index} | project`,
    agent_session:{agent,kind:'id',value:ids[index]}});
  const herdr={call:async(method)=>{
    if(method==='session.snapshot') {
      const captured={protocol:22,panes:[pane()],agents:[],workspaces:[{workspace_id:'w'}],focused_pane_id:null};
      if(holdNext) {const hold=holdNext;holdNext=null;hold.started();await hold.release;}
      return {snapshot:captured};
    }
    if(method==='pane.get')return {pane:pane()};
    if(method==='pane.process_info')return {process_info:{foreground_processes:[{name:agent,pid:process.pid,cwd:home,
      argv:agent==='codex'?['codex','resume',ids[index]]:[agent]}]}};
    throw Error(`Unexpected fake RPC: ${method}`);
  }};
  const app=createBridge({socketPath:'/unused',stateDir:path.join(home,'state'),projects:[],activityTimeline:false},
    {herdr,homeDirectory:home,statusNow:()=>clock,onSnapshot:data=>observed.push(data),
      statusEventsFactory:(_path,callbacks)=>{hooks=callbacks;return {update(){},close(){}};}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>app.close());
  const credential=app.store.pair(app.store.pairCode(),'native fixture');
  const get=async()=>{
    const response=await fetch(`http://127.0.0.1:${app.server.address().port}/v1/snapshot`,
      {headers:{Authorization:`Bearer ${credential.token}`}});
    assert.equal(response.status,200);return (await response.json()).panes[0];
  };
  const select=(next,status)=>{index=next;rawStatus=status;};
  const status=value=>{rawStatus=value;};
  const now=value=>{clock=value;};
  const codex=(i,type,turn,time)=>fs.appendFileSync(files[i],codexEvent(type,turn,time));
  const claude=(i,type,time,extra)=>fs.appendFileSync(files[i],claudeRecord(type,time,extra));
  const claudeComplete=(i,time)=>{
    claude(i,'user',time,{message:{content:'synthetic'}});
    claude(i,'assistant',time+100,{message:{stop_reason:'end_turn',content:[{type:'text',text:'synthetic'}]}});
    claude(i,'system',time+200,{subtype:'turn_duration'});
  };
  const setClaudeSession=i=>fs.writeFileSync(path.join(home,'.claude','sessions',`${process.pid}.json`),
    JSON.stringify({pid:process.pid,procStart:procStart(),cwd:home,sessionId:ids[i]}));
  const holdSnapshot=()=>{
    let started,release;
    const waiting=new Promise(resolve=>{started=resolve;});
    const paused=new Promise(resolve=>{release=resolve;});
    holdNext={started,release:paused};
    return {waiting,release};
  };
  if(agent==='claude')setClaudeSession(0);
  return {get,select,status,now,codex,claude,claudeComplete,setClaudeSession,holdSnapshot,observed,
    event:status=>hooks.onStatus({pane_id:'p',agent_status:status})};
}

test('paired Codex publication vetoes raw Done during an active native turn, then emits for its terminal event',async t=>{
  const f=await fixture(t,'codex');
  f.codex(0,'task_started','turn-a',1000);
  const first=await f.get();assert.equal(first.status,'working');
  f.status('done');
  const active=await f.get();assert.equal(active.status,'working');assert.equal(active.completionEventId,null);
  assert.equal(active.bindingVerification,'verified');
  assert.equal(active.nativeReason,'native_active');
  f.codex(0,'task_complete','turn-a',2000);
  const done=await f.get();assert.equal(done.status,'done');assert.ok(done.completionEventId);
  assert.equal(done.nativeTurnId,'turn-a');
  assert.equal((await f.get()).completionEventId,done.completionEventId);
});

test('native status event waits for a fresh binding after an older snapshot was captured',async t=>{
  const f=await fixture(t,'codex');
  f.codex(0,'task_started','turn-a',1000);
  f.codex(1,'task_started','old-b',1000);f.codex(1,'task_complete','old-b',2000);
  assert.equal((await f.get()).status,'working');
  const hold=f.holdSnapshot();const oldSnapshot=f.get();await hold.waiting;
  f.codex(0,'task_complete','turn-a',3000);
  f.select(1,'done');
  const event=f.event('done');
  hold.release();await Promise.all([oldSnapshot,event]);
  const historical=await f.get();
  assert.equal(historical.bindingVerification,'verified');
  assert.equal(historical.status,'done');
  assert.equal(historical.completionEventId,null);
  assert.equal(f.observed.some(snapshot=>snapshot.panes[0]?.nativeTurnId==='turn-a'&&
    snapshot.panes[0]?.completionEventId),false,'old binding must never publish a completion event');
  f.codex(1,'task_started','new-b',4000);f.status('working');
  assert.equal((await f.get()).status,'working');
  f.codex(1,'task_complete','new-b',5000);f.status('done');
  const completed=await f.get();assert.ok(completed.completionEventId);
  assert.equal(completed.nativeTurnId,'new-b');
});

for(const agent of ['codex','claude'])test(`paired ${agent} rebind baselines old completion and alerts only for a new bound turn`,async t=>{
  const f=await fixture(t,agent);
  if(agent==='codex') {
    f.codex(0,'task_started','turn-a',1000);
    f.codex(1,'task_started','old-b',1000);f.codex(1,'task_complete','old-b',2000);
  } else {
    f.claude(0,'user',1000,{message:{content:'synthetic'}});
    f.claudeComplete(1,1000);
  }
  const working=await f.get();assert.equal(working.status,'working');
  f.select(1,'done');if(agent==='claude')f.setClaudeSession(1);
  const historical=await f.get();assert.equal(historical.status,'done');assert.equal(historical.completionEventId,null);
  assert.equal(working.bindingVerification,'verified');
  assert.notEqual(historical.bindingGeneration,working.bindingGeneration);
  if(agent==='codex') {
    f.codex(1,'task_started','new-b',3000);f.status('working');
    assert.equal((await f.get()).status,'working');
    f.codex(1,'task_complete','new-b',4000);
  } else {
    f.claude(1,'user',3000,{message:{content:'new synthetic task'}});f.status('working');
    assert.equal((await f.get()).status,'working');
    f.claude(1,'assistant',4000,{message:{stop_reason:'end_turn',content:[{type:'text',text:'synthetic'}]}});
    f.claude(1,'system',4100,{subtype:'turn_duration'});
    f.status('done');
    assert.equal((await f.get()).status,'working');
    f.now(12_000);
  }
  const done=await f.get();assert.equal(done.status,'done');assert.ok(done.completionEventId);
  assert.equal((await f.get()).completionEventId,done.completionEventId);
});
