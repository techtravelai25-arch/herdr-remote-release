import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {createHistory,parseHistoryRecord} from '../src/history.js';
import {createBridge} from '../src/server.js';
const sessionId='12345678-1234-1234-1234-123456789abc';
function fixture(t,source='claude') {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-history-'));
  const root=path.join(home,'transcripts');fs.mkdirSync(root);
  const config={homeDirectory:home,historyRoots:{[source]:root},projects:[],stateDir:path.join(home,'state')};
  const pane={pane_id:'w:p',agent:source,agent_session:{kind:'id',value:sessionId,agent:source}};
  const file=path.join(root,source==='codex'?`rollout-2026-09-22-${sessionId}.jsonl`:`${sessionId}.jsonl`);
  const reader=createHistory(config);
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  return {home,root,config,pane,file,reader};
}
test('Claude records retain message roles/tools and omit hidden reasoning and sidechains',()=>{
  assert.equal(parseHistoryRecord({type:'assistant',message:{content:[{type:'thinking',thinking:'private'}]}},'claude','1'),null);
  assert.equal(parseHistoryRecord({type:'assistant',isSidechain:true,message:{content:'child'}},'claude','1'),null);
  const parsed=parseHistoryRecord({type:'user',message:{role:'user',content:[{type:'tool_result',content:'test passed'}]}},'claude','2');
  assert.equal(parsed.role,'tool');assert.equal(parsed.text,'test passed');
});
test('Codex canonical response items avoid duplicate event messages',()=>{
  assert.equal(parseHistoryRecord({type:'event_msg',payload:{type:'agent_message',message:'duplicate'}},'codex','1'),null);
  const parsed=parseHistoryRecord({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Hello'}]}},'codex','2');
  assert.equal(parsed.text,'Hello');assert.equal(parsed.role,'assistant');
});
test('history pages are chronological, append stable, session bound and tolerate partial writes',async t=>{
  const f=fixture(t);
  const record=i=>JSON.stringify({type:'user',timestamp:'2026-09-22T00:00:00Z',message:{content:`Message ${i}`}})+'\n';
  fs.writeFileSync(f.file,Array.from({length:75},(_,i)=>record(i)).join(''));
  const page=await f.reader.read(f.pane);assert.equal(page.messages.length,40);assert.equal(page.messages[0].text,'Message 35');assert.equal(page.hasMore,true);
  fs.appendFileSync(f.file,record(75)+'{"type":');
  const older=await f.reader.read(f.pane,page.nextCursor);assert.equal(older.messages.length,35);assert.equal(older.messages[0].text,'Message 0');assert.equal(older.hasMore,false);
  const latest=await f.reader.read(f.pane);assert.equal(latest.messages.at(-1).text,'Message 75');
  const other={...f.pane,agent_session:{...f.pane.agent_session,kind:'path',value:f.file}};
  await assert.rejects(f.reader.read(other,page.nextCursor),e=>e.code==='history_changed');
});
test('transcript lookup fails closed for missing identity, provider mismatch, symlinks, hardlinks and outside-root paths',async t=>{
  const f=fixture(t);const outside=path.join(f.home,'outside.jsonl');fs.writeFileSync(outside,JSON.stringify({type:'user',message:{content:'secret'}})+'\n');
  assert.equal((await f.reader.read({...f.pane,agent_session:null})).available,false);
  assert.equal((await f.reader.read({...f.pane,agent_session:{...f.pane.agent_session,agent:'codex'}})).available,false);
  assert.equal((await f.reader.read({...f.pane,agent_session:{kind:'path',value:outside}})).available,false);
  fs.symlinkSync(outside,f.file);assert.equal((await f.reader.read(f.pane)).available,false);fs.unlinkSync(f.file);
  fs.linkSync(outside,f.file);assert.equal((await f.reader.read(f.pane)).available,false);
});
test('large transcript pages respect serialized byte bound and make progress',async t=>{
  const f=fixture(t,'codex');fs.writeFileSync(f.file,Array.from({length:25},()=>JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'\u0001'.repeat(50000)}]}})+'\n').join(''));
  const page=await f.reader.read(f.pane);assert.ok(page.messages.length>0);assert.ok(Buffer.byteLength(JSON.stringify(page))<66000);assert.ok(page.hasMore);
});
test('OpenCode SQLite reads only the exact session and paginates without live append duplication',async t=>{
  const f=fixture(t,'opencode');f.pane.agent_session.value='ses_test12345678';
  const db=new DatabaseSync(path.join(f.root,'opencode.db'));
  db.exec('CREATE TABLE message(id TEXT, session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT)');
  for(let i=0;i<45;i++){db.prepare('INSERT INTO message VALUES (?,?,?,?)').run(`msg${i}`,f.pane.agent_session.value,i,JSON.stringify({role:'assistant'}));db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run(`prt${i}`,`msg${i}`,f.pane.agent_session.value,i,JSON.stringify({type:'text',text:`Answer ${i}`}));}
  db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('other','ses_other',100,JSON.stringify({role:'user'}));db.close();
  const first=await f.reader.read(f.pane);assert.equal(first.source,'opencode');assert.equal(first.messages.length,40);assert.equal(first.messages.at(-1).text,'Answer 44');
  const older=await f.reader.read(f.pane,first.nextCursor);assert.equal(older.messages.length,5);assert.equal(older.hasMore,false);
});
test('HTTP history requires pairing and rejects session replacement during read',async t=>{
  const f=fixture(t);fs.writeFileSync(f.file,JSON.stringify({type:'user',message:{content:'Hello'}})+'\n');
  let changed=false,calls=0;
  const herdr={call:async method=>{if(method==='pane.get'){calls++;return {pane:changed&&calls%2===0?{...f.pane,terminal_id:'replacement'}:f.pane};}if(method==='session.snapshot')return {snapshot:{protocol:22,panes:[],workspaces:[]}};throw Error(method);}};
  const app=createBridge({...f.config,activityTimeline:false},{herdr,homeDirectory:f.home});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>app.close());
  const url=`http://127.0.0.1:${app.server.address().port}/v1/panes/w%3Ap/history`;
  assert.equal((await fetch(url)).status,401);
  const auth=app.store.pair(app.store.pairCode(),'Test'),headers={Authorization:`Bearer ${auth.token}`};
  assert.equal((await(await fetch(url,{headers})).json()).messages[0].text,'Hello');
  changed=true;assert.equal((await fetch(url,{headers})).status,409);
  assert.equal((await fetch(url+'?path=/etc/passwd',{headers})).status,400);
});
test('OpenCode clips extracted text while retaining large answers/tools and valid neighbors',async t=>{
 const f=fixture(t,'opencode');f.pane.agent_session.value='ses_long12345678';const session=f.pane.agent_session.value;
 const db=new DatabaseSync(path.join(f.root,'opencode.db'));db.exec('CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT)');
 for(const [i,data] of [[1,{role:'assistant',metadata:'m'.repeat(70000)}],[2,null],[3,{role:'user'}]])db.prepare('INSERT INTO message VALUES(?,?,?,?)').run(`msg${i}`,session,i,data?JSON.stringify(data):'{bad');
 const part=(id,msg,data)=>db.prepare('INSERT INTO part VALUES(?,?,?,?,?)').run(id,msg,session,1,data);
 part('a','msg1',JSON.stringify({type:'text',text:'answer '.repeat(3000)}));part('b','msg1','{bad');part('c','msg3',JSON.stringify({type:'tool',tool:'test',state:{output:'output '.repeat(3000)}}));db.close();
 const result=await f.reader.read(f.pane);assert.equal(result.available,true);assert.equal(result.messages.length,2);assert.ok(result.messages[0].text.startsWith('answer '));assert.ok(result.messages[1].text.startsWith('test\noutput '));assert.ok(result.messages.every(m=>m.truncated));assert.equal(result.hasMore,false);assert.ok(Buffer.byteLength(JSON.stringify(result))<66000);
});
