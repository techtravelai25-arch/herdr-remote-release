import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {claudeSessionFromProcess,withClaudeSession} from '../src/claude-session.js';

const sessionId='3d69680a-1111-4222-8333-444455556666';
const start=fs.readFileSync(`/proc/${process.pid}/stat`,'utf8').split(') ').at(-1).split(' ')[19];
function fixture(t,record,processes) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-claude-session-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  fs.mkdirSync(path.join(home,'.claude/sessions'),{recursive:true});
  if(record)fs.writeFileSync(path.join(home,`.claude/sessions/${process.pid}.json`),JSON.stringify(record));
  const herdr={call:async method=>{assert.equal(method,'pane.process_info');return {process_info:{foreground_processes:processes}};}};
  return {home,herdr,pane:{pane_id:'w:p',agent:'claude',cwd:'/work/app',foreground_cwd:'/work/app'}};
}
const claude=[{name:'claude',pid:process.pid,cwd:'/work/app'}];

test('Claude session is found from the pane process without Herdr hooks',async t=>{
  const f=fixture(t,{pid:process.pid,procStart:start,sessionId,cwd:'/work/app'},claude);
  assert.deepEqual(await claudeSessionFromProcess(f.herdr,f.pane,f.home),{agent:'claude',kind:'id',source:'process:claude',value:sessionId});
});
test('Claude session lookup fails closed on mismatches',async t=>{
  for(const [record,processes] of [
    [{pid:process.pid,procStart:start,sessionId,cwd:'/elsewhere'},claude],
    [{pid:1,procStart:start,sessionId,cwd:'/work/app'},claude],
    [{pid:process.pid,procStart:start,sessionId:'not-a-uuid',cwd:'/work/app'},claude],
    [{pid:process.pid,procStart:'old-process',sessionId,cwd:'/work/app'},claude],
    [{pid:process.pid,procStart:start,sessionId,cwd:'/work/app'},[...claude,{name:'claude',pid:4243,cwd:'/work/app'}]],
    [{pid:process.pid,procStart:start,sessionId,cwd:'/work/app'},[{name:'bash',pid:process.pid,cwd:'/work/app'}]],
    [null,claude],
  ]) {
    const f=fixture(t,record,processes);
    assert.equal(await claudeSessionFromProcess(f.herdr,f.pane,f.home),null);
  }
});
test('a reported Claude session is not trusted without a live process generation',async t=>{
  const f=fixture(t,{pid:process.pid,procStart:start,sessionId,cwd:'/work/app'},claude);
  const reported={...f.pane,agent_session:{agent:'claude',kind:'id',value:'x'}};
  const bound=await withClaudeSession(f.herdr,reported,f.home);
  assert.equal(bound.agent_session,null);
  assert.equal(bound.binding.state,'unverified');
  const other={...f.pane,agent:'codex'};
  assert.equal((await withClaudeSession(f.herdr,other,f.home)).agent_session,null);
});

import {DatabaseSync} from 'node:sqlite';
import {codexSessionFromState} from '../src/codex-session.js';
import {createHistory} from '../src/history.js';
function codexHome(t,threads) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-codex-session-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  fs.mkdirSync(path.join(home,'.codex/sessions/2026/10/07'),{recursive:true});
  const db=new DatabaseSync(path.join(home,'.codex/state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,cwd TEXT,title TEXT,name TEXT,archived INTEGER,thread_source TEXT,updated_at_ms INTEGER)');
  threads.forEach(([id,cwd,name,source='user',archived=0],index)=>db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)').run(id,path.join(home,`.codex/sessions/2026/10/07/rollout-2026-10-07T00-00-00-${id}.jsonl`),cwd,name?`${name} first message`:'',name,archived,source,index));
  db.close();
  return home;
}
const codexPane=title=>({pane_id:'w:p',agent:'codex',cwd:'/home/me',foreground_cwd:'/home/me',terminal_title_stripped:title});
test('Codex thread is matched from Codex state by directory and pane title',async t=>{
  const home=codexHome(t,[['01a-aaa','/home/me','Explain KEK'],['01a-bbb','/home/me','Fix headphones'],['01a-ccc','/home/me',null,'subagent'],['01a-ddd','/other','Fix headphones']]);
  const session=await codexSessionFromState(codexPane('[ . ] Action Required | Fix headphones | me'),home);
  assert.equal(session.kind,'path');assert.ok(session.value.endsWith('01a-bbb.jsonl'));
  assert.ok((await codexSessionFromState(codexPane('Explain KEK | me'),home)).value.endsWith('01a-aaa.jsonl'));
  assert.equal(await codexSessionFromState(codexPane('Something else | me'),home),null);
  assert.equal(await codexSessionFromState({...codexPane('Fix headphones | me'),agent_session:{kind:'id',value:'x'}},home),null);
  assert.equal(await codexSessionFromState({...codexPane('x'),agent:'claude'},home),null);
});
test('Codex lookup requires a title match, ignores archived ones and rejects rollouts outside the sessions folder',async t=>{
  assert.equal(await codexSessionFromState(codexPane('New chat | me'),codexHome(t,[['01a-one','/home/me','Only one']])),null);
  assert.equal(await codexSessionFromState(codexPane('x | me'),codexHome(t,[['01a-one','/home/me','Gone','user',1]])),null);
  const home=codexHome(t,[['01a-one','/home/me','Only one']]);
  const db=new DatabaseSync(path.join(home,'.codex/state_5.sqlite'));db.prepare('UPDATE threads SET rollout_path=?').run('/etc/passwd.jsonl');db.close();
  assert.equal(await codexSessionFromState(codexPane('Only one | me'),home),null);
  assert.equal(await codexSessionFromState(codexPane('x | me'),fs.mkdtempSync(path.join(os.tmpdir(),'herdr-empty-'))),null);
});
test('Codex lookup sees duplicate titles beyond the thirty newest threads',async t=>{
  const threads=[['01a-old','/home/me','Shared title'],
    ...Array.from({length:30},(_,i)=>[`01a-${i}`,'/home/me',`Other ${i}`]),
    ['01a-new','/home/me','Shared title']];
  assert.equal(await codexSessionFromState(codexPane('Shared title | me'),codexHome(t,threads)),null);
});
test('a reported Codex thread from another project is quarantined',async t=>{
  const home=codexHome(t,[['old','/other','Old conversation'],['current','/home/me','Current conversation']]);
  const pane={...codexPane('Current conversation | me'),agent_session:{agent:'codex',kind:'id',source:'herdr:codex',value:'old'}};
  const session=await codexSessionFromState(pane,home);
  assert.equal(session,null);
  assert.equal(pane.agent_session.value,'old','resolution does not mutate Herdr metadata');
  const oldPath=path.join(home,'.codex/sessions/2026/10/07/rollout-2026-10-07T00-00-00-old.jsonl');
  assert.equal(await codexSessionFromState({...pane,agent_session:{agent:'codex',kind:'path',value:oldPath}},home),null);
});
test('a known wrong Codex binding is cleared when no unique current thread exists',async t=>{
  for(const threads of [[],[['a','/home/me','Current'],['b','/home/me','Current']]]) {
    const home=codexHome(t,[['old','/other','Old'],...threads]);
    const pane={...codexPane('Current | me'),agent_session:{agent:'codex',kind:'id',value:'old'}};
    assert.equal(await codexSessionFromState(pane,home),null);
    assert.equal((await withClaudeSession(null,pane,home)).agent_session,null);
  }
});
test('an unverified reported Codex session does not survive title changes or native DB loss',async t=>{
  const home=codexHome(t,[['current','/home/me','Original']]);
  const pane={...codexPane('Renamed | me'),agent_session:{agent:'codex',kind:'id',value:'current'}};
  assert.equal(await codexSessionFromState(pane,home),null);
  const explicitPath={...pane,agent_session:{agent:'codex',kind:'path',value:path.join(home,'.codex/sessions/2026/10/07/rollout-2026-10-07T00-00-00-current.jsonl')}};
  assert.equal(await codexSessionFromState(explicitPath,home),null);
  fs.rmSync(path.join(home,'.codex/state_5.sqlite'));
  assert.equal(await codexSessionFromState(pane,home),null);
});

function liveHerdr(pane,agent) {
  const proc={name:agent,pid:process.pid,cwd:pane.cwd,argv:[agent,agent==='codex'?'resume':'']};
  return {call:async method=>{
    if(method==='pane.process_info')return {process_info:{pane_id:pane.pane_id,foreground_processes:[proc]}};
    if(method==='pane.get')return {pane};
    throw Error(method);
  }};
}
test('same-project wrong Codex report cannot select old history; unique live title selects current history',async t=>{
  const home=codexHome(t,[['old','/home/me','Old work'],['current','/home/me','Current work']]);
  const root=path.join(home,'.codex/sessions');
  const old=path.join(root,'2026/10/07/rollout-2026-10-07T00-00-00-old.jsonl');
  const current=path.join(root,'2026/10/07/rollout-2026-10-07T00-00-00-current.jsonl');
  fs.writeFileSync(old,JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'OLD SECRET'}]}})+'\n');
  fs.writeFileSync(current,JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Current answer'}]}})+'\n');
  const pane={...codexPane('Current work | me'),terminal_id:'terminal-a',
    agent_session:{agent:'codex',kind:'id',value:'old'}};
  const herdr=liveHerdr(pane,'codex');
  const history=createHistory({homeDirectory:home});
  const rejected=await withClaudeSession(herdr,pane,home);
  assert.equal(rejected.binding.state,'conflict');
  assert.equal(rejected.agent_session,null);
  assert.equal((await history.read(rejected)).available,false);
  const corrected={...pane,agent_session:{agent:'codex',kind:'id',value:'current'}};
  const selected=await withClaudeSession(liveHerdr(corrected,'codex'),corrected,home);
  assert.equal(selected.binding.state,'verified');
  const page=await history.read(selected);
  assert.deepEqual(page.messages.map(message=>message.text),['Current answer']);
  const switched={...pane,terminal_title_stripped:'Old work | me'};
  const oldBound=await withClaudeSession(liveHerdr(switched,'codex'),switched,home);
  assert.equal(oldBound.binding.state,'verified');
  assert.notEqual(oldBound.binding.generation,selected.binding.generation);
});
test('verified Codex identity survives rename and short DB outage only in the same process generation',async t=>{
  const home=codexHome(t,[['current','/home/me','Current work']]);
  const initial={...codexPane('Current work | me'),terminal_id:'terminal-b',
    agent_session:{agent:'codex',kind:'id',value:'current'}};
  const first=await withClaudeSession(liveHerdr(initial,'codex'),initial,home);
  assert.equal(first.binding.state,'verified');
  const renamed={...initial,terminal_title_stripped:'Renamed | me'};
  const retained=await withClaudeSession(liveHerdr(renamed,'codex'),renamed,home);
  assert.equal(retained.binding.state,'verified');
  assert.equal(retained.binding.generation,first.binding.generation);
  assert.equal(retained.binding.sessionId,'current');
  fs.rmSync(path.join(home,'.codex/state_5.sqlite'));
  const outage=await withClaudeSession(liveHerdr(renamed,'codex'),renamed,home);
  assert.equal(outage.binding.state,'verified');
  assert.equal(outage.binding.reason,'prior_verified_same_generation');
  const replacement={...renamed,terminal_id:'terminal-c'};
  const unverified=await withClaudeSession(liveHerdr(replacement,'codex'),replacement,home);
  assert.equal(unverified.binding.state,'unverified');
  assert.equal(unverified.agent_session,null);
});
test('Claude reported ID must agree with its foreground process record',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-claude-binding-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  fs.mkdirSync(path.join(home,'.claude/sessions'),{recursive:true});
  fs.writeFileSync(path.join(home,`.claude/sessions/${process.pid}.json`),JSON.stringify({pid:process.pid,procStart:start,sessionId,cwd:'/work/app'}));
  const pane={pane_id:'w:claude',terminal_id:'terminal-d',agent:'claude',cwd:'/work/app',foreground_cwd:'/work/app',
    agent_session:{agent:'claude',kind:'id',value:'9d69680a-1111-4222-8333-444455556666'}};
  const conflict=await withClaudeSession(liveHerdr(pane,'claude'),pane,home);
  assert.equal(conflict.binding.state,'conflict');
  assert.equal(conflict.agent_session,null);
  const corrected={...pane,agent_session:{...pane.agent_session,value:sessionId}};
  const bound=await withClaudeSession(liveHerdr(corrected,'claude'),corrected,home);
  assert.equal(bound.binding.state,'verified');
  assert.equal(bound.binding.sessionId,sessionId);
});
test('a delayed old pane read cannot replace a newer terminal generation',async t=>{
  const home=codexHome(t,[['current','/home/me','Current work']]);
  const old={...codexPane('Current work | me'),terminal_id:'old-terminal',
    agent_session:{agent:'codex',kind:'id',value:'current'}};
  const next={...old,terminal_id:'new-terminal'};
  let current=old;
  let release;
  const paused=new Promise(resolve=>{release=resolve;});
  let calls=0;
  const proc={name:'codex',pid:process.pid,cwd:'/home/me',argv:['codex','resume']};
  const herdr={call:async method=>{
    if(method==='pane.process_info'){
      if(++calls===1)await paused;
      return {process_info:{pane_id:old.pane_id,foreground_processes:[proc]}};
    }
    if(method==='pane.get')return {pane:current};
    throw Error(method);
  }};
  const delayed=withClaudeSession(herdr,old,home);
  current=next;
  const newBinding=await withClaudeSession(herdr,next,home);
  assert.equal(newBinding.binding.state,'verified');
  release();
  const stale=await delayed;
  assert.equal(stale.binding.state,'unverified');
  assert.equal(stale.agent_session,null);
  assert.notEqual(stale.binding.generation,newBinding.binding.generation);
});
test('a Claude session switch inside one process cannot publish the old record',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-claude-rebind-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const directory=path.join(home,'.claude/sessions');
  fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,`${process.pid}.json`);
  const nextId='4d69680a-1111-4222-8333-444455556666';
  fs.writeFileSync(file,JSON.stringify({pid:process.pid,procStart:start,sessionId,cwd:home}));
  const pane={pane_id:'w:rebind',terminal_id:'terminal-rebind',agent:'claude',cwd:home,foreground_cwd:home,
    agent_session:{agent:'claude',kind:'id',value:sessionId}};
  const proc={name:'claude',pid:process.pid,cwd:home,argv:['claude']};
  const herdr={call:async method=>{
    if(method==='pane.process_info')return {process_info:{foreground_processes:[proc]}};
    if(method==='pane.get'){
      fs.writeFileSync(file,JSON.stringify({pid:process.pid,procStart:start,sessionId:nextId,cwd:home}));
      return {pane};
    }
    throw Error(method);
  }};
  const bound=await withClaudeSession(herdr,pane,home);
  assert.notEqual(bound.binding.state,'verified');
  assert.equal(bound.agent_session,null);
});
test('a missing Claude record does not preserve a prior session in the same process',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-claude-record-loss-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const directory=path.join(home,'.claude/sessions');
  fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,`${process.pid}.json`);
  fs.writeFileSync(file,JSON.stringify({pid:process.pid,procStart:start,sessionId,cwd:home}));
  const pane={pane_id:'w:record-loss',terminal_id:'terminal-record-loss',agent:'claude',cwd:home,foreground_cwd:home,
    agent_session:{agent:'claude',kind:'id',value:sessionId}};
  const proc={name:'claude',pid:process.pid,cwd:home,argv:['claude']};
  const herdr={call:async method=>method==='pane.get'?{pane}:{process_info:{foreground_processes:[proc]}}};
  assert.equal((await withClaudeSession(herdr,pane,home)).binding.state,'verified');
  fs.rmSync(file);
  const lost=await withClaudeSession(herdr,pane,home);
  assert.equal(lost.binding.state,'unverified');
  assert.equal(lost.agent_session,null);
});
test('a Codex title switch during native resolution cannot publish the old thread',async t=>{
  const home=codexHome(t,[['old','/home/me','Old work'],['next','/home/me','Next work']]);
  const pane={...codexPane('Old work | me'),terminal_id:'terminal-title-switch',
    agent_session:{agent:'codex',kind:'id',value:'old'}};
  const latest={...pane,terminal_title_stripped:'Next work | me'};
  const proc={name:'codex',pid:process.pid,cwd:'/home/me',argv:['codex']};
  const herdr={call:async method=>{
    if(method==='pane.process_info')return {process_info:{foreground_processes:[proc]}};
    if(method==='pane.get')return {pane:latest};
    throw Error(method);
  }};
  const bound=await withClaudeSession(herdr,pane,home);
  assert.notEqual(bound.binding.state,'verified');
  assert.equal(bound.agent_session,null);
});
test('a foreground process change within one PID cannot publish the earlier Codex binding',async t=>{
  const home=codexHome(t,[['old','/home/me','Old work']]);
  const pane={...codexPane('Old work | me'),terminal_id:'terminal-process-switch',
    agent_session:{agent:'codex',kind:'id',value:'old'}};
  for(const next of [
    {name:'codex',pid:process.pid,cwd:'/elsewhere',argv:['codex']},
    {name:'codex',pid:process.pid,cwd:'/home/me',argv:['codex','resume','other']},
  ]) {
    let reads=0;
    const herdr={call:async method=>{
      if(method==='pane.get')return {pane};
      if(method==='pane.process_info')return {process_info:{foreground_processes:[++reads===1
        ? {name:'codex',pid:process.pid,cwd:'/home/me',argv:['codex']}:next]}};
      throw Error(method);
    }};
    const bound=await withClaudeSession(herdr,pane,home);
    assert.equal(bound.binding.state,'unverified');
    assert.equal(bound.agent_session,null);
  }
});
test('a historical completed or aborted Codex row cannot be recovered from title alone',async t=>{
  for(const event of ['task_complete','turn_aborted']) {
    const id=event==='task_complete'?'2d69680a-1111-4222-8333-444455556666':'5d69680a-1111-4222-8333-444455556666';
    const home=codexHome(t,[[id,'/home/me','Old work']]);
    const rollout=path.join(home,`.codex/sessions/2026/10/07/rollout-2026-10-07T00-00-00-${id}.jsonl`);
    fs.writeFileSync(rollout,[
      {timestamp:'2026-10-11T10:00:00.000Z',type:'event_msg',payload:{type:'task_started',turn_id:'old-turn'}},
      {timestamp:'2026-10-11T10:01:00.000Z',type:'event_msg',payload:{type:event,turn_id:'old-turn'}},
    ].map(row=>JSON.stringify(row)).join('\n')+'\n');
    for(const reported of [null,{agent:'codex',kind:'id',value:id}]) {
      const pane={...codexPane('Old work | me'),terminal_id:'terminal-historical-'+event,
        agent_session:reported};
      const bound=await withClaudeSession(liveHerdr(pane,'codex'),pane,home);
      assert.equal(bound.binding.state,'unverified');
      assert.equal(bound.binding.reason,'historical_title_only_session');
      assert.equal(bound.agent_session,null);
      assert.equal((await createHistory({homeDirectory:home}).read(bound)).available,false);
    }
  }
});
test('an already verified Codex title binding remains valid when its own turn completes',async t=>{
  const id='6d69680a-1111-4222-8333-444455556666';
  const home=codexHome(t,[[id,'/home/me','Current work']]);
  const rollout=path.join(home,`.codex/sessions/2026/10/07/rollout-2026-10-07T00-00-00-${id}.jsonl`);
  const startEvent={timestamp:'2026-10-11T10:00:00.000Z',type:'event_msg',payload:{type:'task_started',turn_id:'current-turn'}};
  const completeEvent={timestamp:'2026-10-11T10:01:00.000Z',type:'event_msg',payload:{type:'task_complete',turn_id:'current-turn'}};
  fs.writeFileSync(rollout,JSON.stringify(startEvent)+'\n');
  const pane={...codexPane('Current work | me'),terminal_id:'terminal-current-turn',
    agent_session:{agent:'codex',kind:'id',value:id}};
  const herdr=liveHerdr(pane,'codex');
  assert.equal((await withClaudeSession(herdr,pane,home)).binding.state,'verified');
  fs.appendFileSync(rollout,JSON.stringify(completeEvent)+'\n');
  const completed=await withClaudeSession(herdr,pane,home);
  assert.equal(completed.binding.state,'verified');
  assert.equal(completed.binding.sessionId,id);
});
test('explicit Codex resume argument can bind a completed native row',async t=>{
  const id='7d69680a-1111-4222-8333-444455556666';
  const home=codexHome(t,[[id,'/home/me','Old work']]);
  const rollout=path.join(home,`.codex/sessions/2026/10/07/rollout-2026-10-07T00-00-00-${id}.jsonl`);
  fs.writeFileSync(rollout,[
    {timestamp:'2026-10-11T10:00:00.000Z',type:'event_msg',payload:{type:'task_started',turn_id:'old-turn'}},
    {timestamp:'2026-10-11T10:01:00.000Z',type:'event_msg',payload:{type:'task_complete',turn_id:'old-turn'}},
  ].map(row=>JSON.stringify(row)).join('\n')+'\n');
  const pane={...codexPane('Old work | me'),terminal_id:'terminal-explicit-resume',
    agent_session:{agent:'codex',kind:'id',value:id}};
  const proc={name:'codex',pid:process.pid,cwd:'/home/me',argv:['codex','resume',id]};
  const herdr={call:async method=>method==='pane.get'?{pane}:{process_info:{foreground_processes:[proc]}}};
  const bound=await withClaudeSession(herdr,pane,home);
  assert.equal(bound.binding.state,'verified');
  assert.equal(bound.binding.reason,'process_argument_native_row');
});
