import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {claudeSessionFromProcess,withClaudeSession} from '../src/claude-session.js';

const sessionId='3d69680a-1111-4222-8333-444455556666';
function fixture(t,record,processes) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-claude-session-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  fs.mkdirSync(path.join(home,'.claude/sessions'),{recursive:true});
  if(record)fs.writeFileSync(path.join(home,'.claude/sessions/4242.json'),JSON.stringify(record));
  const herdr={call:async method=>{assert.equal(method,'pane.process_info');return {process_info:{foreground_processes:processes}};}};
  return {home,herdr,pane:{pane_id:'w:p',agent:'claude',cwd:'/work/app',foreground_cwd:'/work/app'}};
}
const claude=[{name:'claude',pid:4242,cwd:'/work/app'}];

test('Claude session is found from the pane process without Herdr hooks',async t=>{
  const f=fixture(t,{pid:4242,sessionId,cwd:'/work/app'},claude);
  assert.deepEqual(await claudeSessionFromProcess(f.herdr,f.pane,f.home),{agent:'claude',kind:'id',source:'process:claude',value:sessionId});
  assert.equal((await withClaudeSession(f.herdr,f.pane,f.home)).agent_session.value,sessionId);
});
test('Claude session lookup fails closed on mismatches',async t=>{
  for(const [record,processes] of [
    [{pid:4242,sessionId,cwd:'/elsewhere'},claude],
    [{pid:1,sessionId,cwd:'/work/app'},claude],
    [{pid:4242,sessionId:'not-a-uuid',cwd:'/work/app'},claude],
    [{pid:4242,sessionId,cwd:'/work/app'},[...claude,{name:'claude',pid:4243,cwd:'/work/app'}]],
    [{pid:4242,sessionId,cwd:'/work/app'},[{name:'bash',pid:4242,cwd:'/work/app'}]],
    [null,claude],
  ]) {
    const f=fixture(t,record,processes);
    assert.equal(await claudeSessionFromProcess(f.herdr,f.pane,f.home),null);
  }
});
test('reported Herdr sessions and other agents are left alone',async t=>{
  const f=fixture(t,{pid:4242,sessionId,cwd:'/work/app'},claude);
  const reported={...f.pane,agent_session:{agent:'claude',kind:'id',value:'x'}};
  assert.equal(await withClaudeSession(f.herdr,reported,f.home),reported);
  const other={...f.pane,agent:'codex'};
  assert.equal(await withClaudeSession(f.herdr,other,f.home),other);
});

import {DatabaseSync} from 'node:sqlite';
import {codexSessionFromState} from '../src/codex-session.js';
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
  assert.equal(await codexSessionFromState({...codexPane('Fix headphones | me'),agent_session:{kind:'id',value:'x'}},home).then(s=>s.value),'x');
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
