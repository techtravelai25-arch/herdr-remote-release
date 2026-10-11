import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {ClaudeStatus} from '../src/claude-status.js';
import {createBridge} from '../src/server.js';

const sessionId='3d69680a-1111-4222-8333-444455556666';
const procStart=()=>fs.readFileSync(`/proc/${process.pid}/stat`,'utf8').split(') ').at(-1).split(' ')[19];
function fixture(t,{kind='path'}={}) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-claude-status-'));
  const dir=path.join(home,'.claude','projects','project');
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,`${sessionId}.jsonl`);
  fs.writeFileSync(file,'');
  const sessionDir=path.join(home,'.claude','sessions');fs.mkdirSync(sessionDir,{recursive:true});
  fs.writeFileSync(path.join(sessionDir,`${process.pid}.json`),JSON.stringify({pid:process.pid,procStart:procStart(),cwd:home,sessionId}));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  let clock=10_000;
  const status=new ClaudeStatus({home,herdr:{call:async()=>{throw Error('unexpected Herdr call');}},now:()=>clock,settleMs:2000});
  const pane={pane_id:'p1',terminal_id:'term1',workspace_id:'w1',tab_id:'t1',agent:'claude',
    agent_status:'working',cwd:home,terminal_title_stripped:'Claude | project',revision:1,
    agent_session:{agent:'claude',kind,value:kind==='path'?file:sessionId},
    binding:{state:'verified',generation:'direct-fixture',sessionId,reason:'fixture'}};
  const append=(type,time,extra={})=>fs.appendFileSync(file,JSON.stringify({type,timestamp:new Date(time).toISOString(),sessionId,...extra})+'\n');
  const user=(time,text='Next task')=>append('user',time,{message:{role:'user',content:text}});
  const assistant=(time,{stop='end_turn',content=[{type:'text',text:'Finished.'}],id=`msg-${time}`}={})=>
    append('assistant',time,{message:{id,type:'message',role:'assistant',content,stop_reason:stop}});
  const duration=time=>append('system',time,{subtype:'turn_duration',durationMs:1000});
  const observe=async(raw='working',focused=null)=>(await status.observe([{...pane,agent_status:raw}],focused))[0].agent_status;
  return {home,file,pane,status,append,user,assistant,duration,observe,now:value=>{clock=value;}};
}

test('only native final text plus turn duration can settle a raw done title',async t=>{
  const f=fixture(t);
  f.user(1000);
  assert.equal(await f.observe('working'),'working');
  f.assistant(2000,{stop:'tool_use',content:[{type:'tool_use',id:'tool-1',name:'Read',input:{}}]});
  f.append('user',2100,{message:{role:'user',content:[{type:'tool_result',tool_use_id:'tool-1',content:'ok'}]}});
  assert.equal(f.status.status('p1','done'),'working');
  f.assistant(3000,{stop:'end_turn',content:[{type:'thinking',thinking:'Private reasoning'}]});
  f.duration(3100);
  assert.equal(f.status.status('p1','done'),'working','a thinking-only end cannot complete');
  f.user(4000);
  f.assistant(5000);
  assert.equal(f.status.status('p1','done'),'working','assistant text alone is not a full turn');
  f.duration(5100);
  assert.equal(f.status.status('p1','done'),'working','raw done must settle');
  f.now(11_999);
  assert.equal(f.status.status('p1','done'),'working');
  f.now(12_000);
  assert.equal(f.status.status('p1','done'),'done');
});
test('unsupported system subtype after completion cannot retain Done',async t=>{
  const f=fixture(t);
  f.user(1000);f.assistant(2000);f.duration(2100);
  assert.equal(await f.observe('done'),'done');
  f.append('system',2200,{subtype:'turn_started'});
  assert.equal(f.status.status('p1','done'),'unknown');
  assert.equal(f.status.metadata('p1').nativeReason,'unsupported_schema');
});

test('native completion persists across title flicker; PC idle marks it seen; new user activity reopens work',async t=>{
  const f=fixture(t,{kind:'id'});
  f.user(1000);
  assert.equal(await f.observe('working'),'working');
  f.assistant(2000);f.duration(2100);
  assert.equal(await f.observe('done'),'working');
  f.now(12_000);
  assert.equal(f.status.status('p1','done'),'done');
  assert.equal(f.status.status('p1','working'),'done','a title spinner cannot reopen the completed turn');
  assert.equal(await f.observe('idle','p1'),'idle');
  assert.equal(f.status.status('p1','working'),'idle','focus acknowledgement survives title flicker');
  f.user(13_000);
  assert.equal(await f.observe('done',null),'working','new transcript activity starts a new turn');
  f.assistant(14_000);f.duration(14_100);
  assert.equal(f.status.status('p1','done'),'working');
  f.now(13_999);
  assert.equal(f.status.status('p1','done'),'working');
  f.now(16_000);
  assert.equal(f.status.status('p1','done'),'done');
});

test('idle final stays seen, raw working never completes, and blocked or error pass through',async t=>{
  const f=fixture(t);
  f.user(1000);f.assistant(2000);f.duration(2100);
  assert.equal(await f.observe('idle'),'idle');
  f.now(20_000);
  assert.equal(f.status.status('p1','working'),'idle');
  assert.equal(f.status.status('p1','blocked'),'blocked');
  assert.equal(f.status.status('p1','error'),'error');
  f.user(21_000);f.assistant(22_000);f.duration(22_100);
  assert.equal(f.status.status('p1','working'),'working');
});

test('missing or unsafe native transcript never turns a raw done title into completion',async t=>{
  const f=fixture(t);
  assert.equal(await f.observe('done'),'unknown');
  assert.equal(f.status.status('p1','idle'),'idle');
  const outside=path.join(f.home,'outside.jsonl');
  fs.writeFileSync(outside,JSON.stringify({type:'assistant',message:{stop_reason:'end_turn',content:[{type:'text',text:'Done'}]}})+'\n');
  const unsafe={...f.pane,agent_session:{agent:'claude',kind:'path',value:outside}};
  assert.equal((await f.status.observe([{...unsafe,agent_status:'done'}],null))[0].agent_status,'unknown');
});

test('dispatch fences an old completion; rejection restores it; a later native turn completes',async t=>{
  const f=fixture(t);
  f.user(1000);
  assert.equal(await f.observe('working'),'working');
  f.assistant(2000);f.duration(2100);
  assert.equal(f.status.status('p1','done'),'working');f.now(12_000);
  assert.equal(f.status.status('p1','done'),'done');
  const cancel=f.status.inputStarted(f.pane,13_000);
  assert.equal(f.status.status('p1','done'),'working');
  cancel();
  assert.equal(f.status.status('p1','done'),'done');
  f.status.inputStarted(f.pane,13_000);
  f.user(13_100);f.assistant(13_200);f.duration(13_300);
  assert.equal(f.status.status('p1','done'),'working');
  f.now(13_999);
  assert.equal(f.status.status('p1','done'),'working');
  f.now(16_000);
  assert.equal(f.status.status('p1','done'),'done');
});

test('historical native completion is a baseline rather than a fresh phone alert',async t=>{
  const f=fixture(t);
  f.user(1000);f.assistant(2000);f.duration(2100);
  assert.equal(await f.observe('done'),'done');
});
test('post-turn auto compaction cannot leave a ready Claude pane working or replay completion',async t=>{
  const f=fixture(t);
  f.user(1000);assert.equal(await f.observe('working'),'working');
  f.assistant(2000);f.duration(2100);
  assert.equal(await f.observe('done'),'working');f.now(12_000);
  assert.equal(await f.observe('done'),'done');
  f.append('system',3000,{subtype:'compact_boundary'});
  f.append('user',3001,{isCompactSummary:true,isVisibleInTranscriptOnly:true,message:{content:'Saved context'}});
  f.append('attachment',3002);
  assert.equal(await f.observe('done'),'done');
  assert.equal(await f.observe('idle'),'idle');
  assert.equal(await f.observe('done'),'idle','the same reply stays acknowledged');
  f.user(4000);assert.equal(await f.observe('done'),'working','actual new input still reopens work');
});

test('startup with a completed transcript and stale working title does not replay that completion',async t=>{
  const f=fixture(t);
  f.user(1000);f.assistant(2000);f.duration(2100);
  assert.equal(await f.observe('working'),'idle');
  f.now(20_000);
  assert.equal(f.status.status('p1','done'),'idle');
});

test('a partial append and a resumed turn during settling cannot publish an early reply',async t=>{
  const f=fixture(t);
  f.user(1000);
  assert.equal(await f.observe('working'),'working');
  f.assistant(2000);
  const partial=JSON.stringify({type:'system',timestamp:new Date(2100).toISOString(),subtype:'turn_duration'});
  fs.appendFileSync(f.file,partial);
  assert.notEqual(f.status.status('p1','done'),'done');
  fs.appendFileSync(f.file,'\n');
  assert.equal(f.status.status('p1','done'),'working');
  f.now(11_000);
  f.user(2200,'Continue before the stop hook finishes');
  assert.equal(f.status.status('p1','done'),'working');
  f.now(20_000);
  assert.equal(f.status.status('p1','done'),'working','old candidate must not mature during the continued turn');
  f.assistant(3000);f.duration(3100);
  assert.equal(f.status.status('p1','done'),'working');
  f.now(21_999);
  assert.equal(f.status.status('p1','done'),'working');
  f.now(22_000);
  assert.equal(f.status.status('p1','done'),'done');
});

test('bridge publishes one verified Claude completion across HTTP and status events',async t=>{
  const f=fixture(t);
  let rawStatus='working',hooks,clock=10_000;
  f.user(1000);
  const herdr={call:async method=>{
    if(method==='pane.get')return {pane:{...f.pane,agent_status:rawStatus,agent_session:{agent:'claude',kind:'id',value:sessionId}}};
    if(method==='pane.process_info')return {process_info:{foreground_processes:[{name:'claude',pid:process.pid,cwd:f.home,argv:['claude']}]}};
    assert.equal(method,'session.snapshot');
    return {snapshot:{protocol:22,workspaces:[{workspace_id:'w1'}],panes:[{...f.pane,agent_status:rawStatus,agent_session:{agent:'claude',kind:'id',value:sessionId}}],agents:[],focused_pane_id:null}};
  }};
  const observed=[];
  const app=createBridge({socketPath:'/unused',stateDir:path.join(f.home,'state'),projects:[],activityTimeline:false},
    {herdr,homeDirectory:f.home,statusNow:()=>clock,onSnapshot:data=>observed.push(data),
      statusEventsFactory:(_path,callbacks)=>{hooks=callbacks;return {update(){},close(){}};}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>app.close());
  const credential=app.store.pair(app.store.pairCode(),'test');
  const get=async()=>{
    const response=await fetch(`http://127.0.0.1:${app.server.address().port}/v1/snapshot`,
      {headers:{Authorization:`Bearer ${credential.token}`}});
    assert.equal(response.status,200);return (await response.json()).panes[0];
  };
  assert.equal((await get()).status,'working');
  f.assistant(2000,{stop:'tool_use',content:[{type:'tool_use',id:'tool-1',name:'Read',input:{}}]});
  rawStatus='done';
  assert.equal((await get()).status,'working');
  assert.equal((await get()).completionEventId,null);
  f.append('user',2100,{message:{role:'user',content:[{type:'tool_result',tool_use_id:'tool-1',content:'ok'}]}});
  assert.equal((await get()).status,'working');
  f.assistant(3000);f.duration(3100);
  assert.equal((await get()).status,'working');
  clock=12_000;
  const done=await get();assert.equal(done.status,'done');assert.ok(done.completionEventId);
  await hooks.onStatus({pane_id:'p1',agent_status:'working'});
  const same=await get();assert.equal(same.status,'done');assert.equal(same.completionEventId,done.completionEventId);
  f.append('system',3200,{subtype:'compact_boundary'});
  f.append('user',3201,{isCompactSummary:true,isVisibleInTranscriptOnly:true,message:{content:'Saved context'}});
  const compacted=await get();assert.equal(compacted.status,'done');
  assert.equal(compacted.completionEventId,done.completionEventId,'compaction must not issue a second notification');
  f.user(13_000);rawStatus='working';
  const resumed=await get();assert.equal(resumed.status,'working');
  f.assistant(14_000);f.duration(14_100);rawStatus='done';clock=14_000;
  assert.equal((await get()).status,'working');
  clock=16_000;
  const next=await get();assert.equal(next.status,'done');assert.ok(next.completionEventId);
  assert.notEqual(next.completionEventId,done.completionEventId);
  await hooks.onStatus({pane_id:'p1',agent_status:'blocked'});
  assert.equal(observed.at(-1).panes[0].status,'blocked');
});

test('newer done event survives an in-flight focused idle snapshot',async t=>{
  const f=fixture(t);
  let rawStatus='working',focusedPaneId=null,hooks,clock=10_000,releaseSnapshot;
  let snapshotStarted;
  const started=new Promise(resolve=>{snapshotStarted=resolve;});
  let holdNext=false;
  f.user(1000);
  const herdr={call:async method=>{
    if(method==='pane.get')return {pane:{...f.pane,agent_status:rawStatus,agent_session:{agent:'claude',kind:'id',value:sessionId}}};
    if(method==='pane.process_info')return {process_info:{foreground_processes:[{name:'claude',pid:process.pid,cwd:f.home,argv:['claude']}]}};
    assert.equal(method,'session.snapshot');
    const captured={protocol:22,workspaces:[{workspace_id:'w1'}],
      panes:[{...f.pane,agent_status:rawStatus,agent_session:{agent:'claude',kind:'id',value:sessionId}}],agents:[],focused_pane_id:focusedPaneId};
    if(holdNext) {
      holdNext=false;snapshotStarted();
      await new Promise(resolve=>{releaseSnapshot=resolve;});
    }
    return {snapshot:captured};
  }};
  const app=createBridge({socketPath:'/unused',stateDir:path.join(f.home,'state'),projects:[],activityTimeline:false},
    {herdr,homeDirectory:f.home,statusNow:()=>clock,
      statusEventsFactory:(_path,callbacks)=>{hooks=callbacks;return {update(){},close(){}};}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>app.close());
  const credential=app.store.pair(app.store.pairCode(),'test');
  const get=async()=>{
    const response=await fetch(`http://127.0.0.1:${app.server.address().port}/v1/snapshot`,
      {headers:{Authorization:`Bearer ${credential.token}`}});
    assert.equal(response.status,200);return (await response.json()).panes[0];
  };
  assert.equal((await get()).status,'working');
  rawStatus='idle';focusedPaneId='p1';holdNext=true;
  const pending=get();
  await started;
  f.assistant(2000);f.duration(2100);
  const event=hooks.onStatus({pane_id:'p1',agent_status:'done'});
  clock=12_000;
  rawStatus='done';focusedPaneId=null;
  releaseSnapshot();
  await event;
  assert.equal((await pending).status,'working','native completion still needs the confirmation window');
  clock=14_000;
  const completed=await get();
  assert.equal(completed.status,'done');
  assert.ok(completed.completionEventId);
  assert.equal(completed.completionAcknowledged,false);
  const same=await get();
  assert.equal(same.status,'done');
  assert.equal(same.completionEventId,completed.completionEventId);
});
