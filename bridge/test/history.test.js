import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {createHistory,parseHistoryRecords} from '../src/history.js';
const parseFirst=(...args)=>parseHistoryRecords(...args)[0]??null;
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
  assert.equal(parseFirst({type:'assistant',message:{content:[{type:'thinking',thinking:'private'}]}},'claude','1'),null);
  assert.equal(parseFirst({type:'assistant',isSidechain:true,message:{content:'child'}},'claude','1'),null);
  const parsed=parseFirst({type:'user',message:{role:'user',content:[{type:'tool_result',content:'test passed'}]}},'claude','2');
  assert.equal(parsed.role,'tool');assert.equal(parsed.text,'test passed');
});
test('Codex canonical response items avoid duplicate event messages',()=>{
  assert.equal(parseFirst({type:'event_msg',payload:{type:'agent_message',message:'duplicate'}},'codex','1'),null);
  const parsed=parseFirst({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Hello'}]}},'codex','2');
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

test('injected agent and terminal context is not shown as something the person typed',()=>{
  const claude=(content,extra={})=>parseHistoryRecords({type:'user',message:{role:'user',content},...extra},'claude','1');
  assert.deepEqual(claude('<command-name>/clear</command-name>\n<command-message>clear</command-message>'),[]);
  assert.deepEqual(claude('<local-command-caveat>Caveat: generated while running local commands</local-command-caveat>'),[]);
  assert.deepEqual(claude('anything',{isMeta:true}),[]);
  assert.deepEqual(claude([{type:'text',text:'<system-reminder>hidden</system-reminder>'}]),[]);
  assert.equal(claude('Fix it<system-reminder>hidden</system-reminder>')[0].text,'Fix it');
  assert.equal(claude('[Request interrupted by user]')[0].role,'system');
  const codex=text=>parseHistoryRecords({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}},'codex','1');
  assert.deepEqual(codex('# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>x</INSTRUCTIONS>'),[]);
  assert.deepEqual(codex('<environment_context>\n<cwd>/repo</cwd>\n</environment_context>'),[]);
  assert.deepEqual(codex('<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>'),[]);
  assert.equal(codex('<send_user_message_question_reply>\n[{"answer":"Use option two"}]\n</send_user_message_question_reply>')[0].text,'Use option two');
  assert.equal(codex('Go ahead')[0].role,'user');
});
test('tool calls become short tool steps instead of raw JSON inside the reply',()=>{
  const reply=parseHistoryRecords({type:'assistant',message:{role:'assistant',content:[
    {type:'text',text:'Looking now.'},{type:'tool_use',name:'Bash',input:{command:'ls -la',description:'List'}},{type:'tool_use',name:'Read',input:{file_path:'/repo/a.js'}}]}},'claude','r');
  assert.deepEqual(reply.map(m=>[m.role,m.text,m.toolName]),[['assistant','Looking now.',undefined],['tool','ls -la','Bash'],['tool','/repo/a.js','Read']]);
  assert.equal(new Set(reply.map(m=>m.id)).size,3);
  const call=parseHistoryRecords({type:'response_item',payload:{type:'function_call',name:'exec_command',arguments:JSON.stringify({cmd:'git status',workdir:'/repo'})}},'codex','c');
  assert.deepEqual([call[0].role,call[0].text,call[0].toolName],['tool','git status','exec_command']);
  const output=parseHistoryRecords({type:'response_item',payload:{type:'function_call_output',output:JSON.stringify({output:'x'.repeat(5000)})}},'codex','o');
  assert.ok(output[0].text.length<=601);
});
test('tool bursts cannot push conversation turns off the page and records are never split across pages',async t=>{
  const f=fixture(t);
  const lines=[];
  for(let i=0;i<30;i++){
    lines.push(JSON.stringify({type:'user',message:{role:'user',content:`Question ${i}`}}));
    lines.push(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:`Answer ${i}`},...Array.from({length:6},(_,n)=>({type:'tool_use',name:'Bash',input:{command:`step ${i}.${n}`}}))]}}));
  }
  fs.writeFileSync(f.file,lines.join('\n')+'\n');
  const page=await f.reader.read(f.pane);
  assert.equal(page.messages.filter(m=>m.role!=='tool').length,40);
  assert.equal(page.messages.at(-1).role,'tool');
  const older=await f.reader.read(f.pane,page.nextCursor);
  const ids=[...page.messages,...older.messages].map(m=>m.id);
  assert.equal(new Set(ids).size,ids.length);
  assert.equal([...older.messages,...page.messages].filter(m=>m.role==='user').length,30);
});
test('history revision lets a polling client skip unchanged conversations',async t=>{
  const f=fixture(t);fs.writeFileSync(f.file,JSON.stringify({type:'user',message:{role:'user',content:'Hello'}})+'\n');
  const first=await f.reader.read(f.pane);assert.ok(first.revision);
  const same=await f.reader.read(f.pane,null,first.revision);assert.equal(same.unchanged,true);assert.deepEqual(same.messages,[]);
  fs.appendFileSync(f.file,JSON.stringify({type:'assistant',message:{role:'assistant',content:'Hi'}})+'\n');
  const next=await f.reader.read(f.pane,null,first.revision);assert.notEqual(next.unchanged,true);assert.equal(next.messages.at(-1).text,'Hi');assert.notEqual(next.revision,first.revision);
});
for (const [name, count, commandSize] of [['item cap',161,8],['byte cap',120,600]]) {
  test(`one Claude record paginates through the ${name} without dropping or repeating items`,async t=>{
    const f=fixture(t);
    const content=[{type:'text',text:'Answer'},...Array.from({length:count},(_,i)=>
      ({type:'tool_use',name:'Bash',input:{command:`step-${i}-`+'x'.repeat(commandSize)}}))];
    const record={type:'assistant',message:{role:'assistant',content}};
    fs.writeFileSync(f.file,JSON.stringify(record)+'\n');
    const all=[]; let cursor;
    for(let pageNumber=0;pageNumber<10;pageNumber++) {
      const page=await f.reader.read(f.pane,cursor);
      assert.ok(page.messages.length>0,'each page must make progress');
      assert.ok(Buffer.byteLength(JSON.stringify(page))<66000,'page stays within the response budget');
      all.unshift(...page.messages);
      if(!page.hasMore)break;
      assert.ok(page.nextCursor);
      if(pageNumber===0) fs.appendFileSync(f.file,JSON.stringify({type:'user',message:{role:'user',content:'Newer message'}})+'\n');
      cursor=page.nextCursor;
    }
    assert.equal(all.length,count+1);
    assert.equal(new Set(all.map(message=>message.id)).size,count+1);
    const expected=parseHistoryRecords(record,'claude','record');
    assert.equal(all.every((message,index)=>message.text===expected[index].text),true,'all items retain their original order and text');
  });
}
test('intra-record cursors reject malformed positions and cross record boundaries once',async t=>{
  const f=fixture(t);
  const crowded={type:'assistant',message:{role:'assistant',content:[{type:'text',text:'Middle answer'},
    ...Array.from({length:161},(_,i)=>({type:'tool_use',name:'Bash',input:{command:`middle-${i}`}}))]}};
  const records=[{type:'user',message:{role:'user',content:'Earlier question'}},crowded,
    {type:'user',message:{role:'user',content:'Newest question'}}];
  fs.writeFileSync(f.file,records.map(record=>JSON.stringify(record)).join('\n')+'\n');
  const first=await f.reader.read(f.pane);
  assert.ok(first.hasMore);
  const decoded=JSON.parse(Buffer.from(first.nextCursor,'base64url').toString());
  assert.ok(decoded.within>0,'the first page ends inside the crowded record');
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  for(const patch of [{within:-1},{within:1.5},{recordStart:-1},{recordStart:decoded.before},{recordStart:null}]) {
    await assert.rejects(f.reader.read(f.pane,encode({...decoded,...patch})),error=>error.code==='history_changed');
  }
  const all=[...first.messages];let cursor=first.nextCursor;
  for(let pageNumber=0;pageNumber<10;pageNumber++) {
    const page=await f.reader.read(f.pane,cursor);
    assert.ok(page.messages.length>0);
    all.unshift(...page.messages);
    if(!page.hasMore)break;
    cursor=page.nextCursor;
  }
  assert.equal(all.length,164);
  assert.equal(new Set(all.map(message=>message.id)).size,164);
  assert.equal(all[0].text,'Earlier question');
  assert.equal(all[1].text,'Middle answer');
  assert.equal(all.at(-1).text,'Newest question');
  assert.equal(all.filter(message=>message.role==='tool').length,161);
});
