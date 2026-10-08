import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createUsageSource,normalizeCodexUsage,readCodexRateLimits,readClaudeUsage} from '../src/usage.js';
import {createBridge} from '../src/server.js';
const data={rateLimits:{primary:{usedPercent:24,windowDurationMins:300,resetsAt:2000000000},secondary:{usedPercent:100,windowDurationMins:10080,resetsAt:null}}};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('normalizes real account windows without inventing percentages or exposing account data',()=>{
 const result=normalizeCodexUsage({...data,accountId:'private-account'},1000);
 assert.deepEqual(result.windows,[{id:'primary',label:'5-hour',remainingPercent:76,resetsAt:'2033-05-18T03:33:20.000Z'},{id:'secondary',label:'Weekly',remainingPercent:0,resetsAt:null}]);
 assert.equal(result.updatedAt,'1970-01-01T00:00:01.000Z');assert.ok(!JSON.stringify(result).includes('private-account'));
 assert.throws(()=>normalizeCodexUsage({rateLimits:{primary:{usedPercent:null}}}));
 assert.throws(()=>normalizeCodexUsage({rateLimits:{primary:{usedPercent:101}}}));
 assert.equal(normalizeCodexUsage({...data,rateLimitsByLimitId:{codex:{primary:{usedPercent:10}}}}).windows[0].remainingPercent,90);
});
test('usage cache is nonblocking, deduplicates reads and preserves stale values on failure',async()=>{
 let time=1000,calls=0,resolve,reject;
 const source=createUsageSource({refreshClaude:()=>null,now:()=>time,refreshMs:100,read:()=>{calls++;return {promise:new Promise((yes,no)=>{resolve=yes;reject=no;})};}});
 assert.equal(source.get()[0].status,'unavailable');source.get();assert.equal(calls,1);
 resolve(data);await settle();assert.equal(source.get()[0].status,'available');
 time+=101;source.get();source.get();assert.equal(calls,2);
 reject(new Error('secret error'));await settle();
 const stale=source.get()[0];assert.equal(stale.status,'stale');assert.equal(stale.windows[0].remainingPercent,76);assert.equal(stale.updatedAt,new Date(1000).toISOString());assert.ok(!stale.message.includes('secret'));
 source.close();time+=1000;source.get();assert.equal(calls,2);
});
test('expired windows are stale until freshly read, never auto-refilled',async()=>{
 let time=1000;const source=createUsageSource({refreshClaude:()=>null,now:()=>time,read:()=>({promise:Promise.resolve({rateLimits:{primary:{usedPercent:100,resetsAt:2}}})})});
 source.get();await settle();time=2000;assert.equal(source.get()[0].status,'stale');assert.equal(source.get()[0].windows[0].remainingPercent,0);source.close();
});
function fakeProcess() {
 const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.killed=false;child.kill=()=>{child.killed=true;};return child;
}
test('Codex transport initializes then only reads rate limits and terminates',async()=>{
 const child=fakeProcess(),sent=[];child.stdin.on('data',chunk=>sent.push(JSON.parse(chunk.toString())));
 const read=readCodexRateLimits({spawnProcess:(command,args,options)=>{assert.equal(command,'codex');assert.deepEqual(args,['app-server','--listen','stdio://']);assert.equal(options.stdio[2],'ignore');return child;}});
 assert.equal(sent[0].method,'initialize');child.stdout.write('{"id":1,"result":{}}\n');
 assert.deepEqual(sent.map(x=>x.method),['initialize','initialized','account/rateLimits/read']);
 child.stdout.write(JSON.stringify({id:2,result:data})+'\n');assert.deepEqual(await read.promise,data);assert.equal(child.killed,true);
});
test('Codex transport rejects errors, times out and supports shutdown cancellation',async()=>{
 for(const kind of ['error','timeout','cancel','oversize']) {
  const child=fakeProcess();const read=readCodexRateLimits({spawnProcess:()=>child,timeoutMs:10});const rejected=assert.rejects(read.promise,/Codex usage unavailable/);
  if(kind==='error')child.emit('error',new Error('private detail'));
  if(kind==='cancel')read.cancel();
  if(kind==='oversize')child.stdout.write('x'.repeat(1024*1024+1));
  if(kind==='timeout')await new Promise(resolve=>setTimeout(resolve,20));
  await rejected;assert.equal(child.killed,true);
 }
});
test('bridge includes fresh usage even when Herdr goes offline and closes source',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-usage-'));let offline=false,closed=false,status='available';
 const app=createBridge({socketPath:'/unused',stateDir:dir,projects:[]},{herdr:{call:async()=>{if(offline)throw new Error('offline');return {snapshot:{protocol:22,panes:[],workspaces:[]}};}},usage:{get:()=>[{id:'codex',status}],close:()=>{closed=true;}}});
 try {app.server.listen(0,'127.0.0.1');assert.equal((await app.snapshot()).usage[0].status,'available');offline=true;status='stale';
 const snapshot=await app.snapshot();assert.equal(snapshot.herdrOnline,false);assert.equal(snapshot.usage[0].status,'stale');
 } finally {await app.close();fs.rmSync(dir,{recursive:true,force:true});}assert.equal(closed,true);
});

// ---- Claude usage ----
const NOW=Date.parse('2026-10-07T12:00:00Z');
const fetched=seconds=>NOW/1000-seconds;
function homeWith(files) {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'claude-usage-'));
 for(const [rel,content] of Object.entries(files)) {
  const file=path.join(home,rel);fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,typeof content==='string'?content:JSON.stringify(content));
 }
 return home;
}
const swapSequence={activeAccountNumber:2,sequence:[1,2,3],accounts:{1:{email:'alex@example.com'},2:{email:'code@example.com'},3:{email:'info@example.com'}}};
const row=(five,scoped,extra={})=>({lastError:null,consecutiveFailures:0,fetchedAt:fetched(30),lastGood:{five_hour:{pct:five,resets_at:'2026-10-07T14:40:00.152994+00:00',countdown:'2h',clock:'20:10'},scoped:[{name:'Fable',pct:scoped,resets_at:'2026-10-13T23:00:00+00:00'}]},...extra});
const swapCache=accounts=>({schemaVersion:2,accounts});
function swapFiles(accounts,sequence=swapSequence) {
 const rows=Object.fromEntries(Object.entries(accounts).map(([slot,value])=>[slot,{
  email:sequence.accounts?.[slot]?.email,organizationUuid:sequence.accounts?.[slot]?.organizationUuid??'',...value,
 }]));
 return {'.local/share/claude-swap/sequence.json':sequence,'.local/share/claude-swap/cache/usage.json':swapCache(rows)};
}
const claudeOnly=(home,time=NOW)=>createUsageSource({refreshClaude:()=>null,now:()=>time,read:()=>({promise:new Promise(()=>{})}),homeDirectory:home});
const cleanup=home=>fs.rmSync(home,{recursive:true,force:true});

test('three claude-swap accounts: active first, slot order, labels and remaining math',()=>{
 const home=homeWith(swapFiles({1:row(24,15),2:row(0,0),3:row(2.5,100)}));
 try {
  const [codex,...claude]=claudeOnly(home).get();
  assert.equal(codex.id,'codex');
  assert.deepEqual(claude.map(p=>p.id),['claude:2','claude:1','claude:3']);
  assert.deepEqual(claude.map(p=>p.name),['Claude · code','Claude · alex','Claude · info']);
  assert.deepEqual(claude.map(p=>p.active),[true,false,false]);
  assert.deepEqual(claude.map(p=>p.account),['code@example.com','alex@example.com','info@example.com']);
  assert.ok(claude.every(p=>p.group==='claude'&&p.status==='available'&&p.updatedAt===new Date(NOW-30000).toISOString()));
  assert.deepEqual(claude[1].windows,[{id:'five_hour',label:'5-hour',remainingPercent:76,resetsAt:'2026-10-07T14:40:00.152Z'},{id:'scoped_0',label:'Fable weekly',remainingPercent:85,resetsAt:'2026-10-13T23:00:00.000Z'}]);
  assert.deepEqual(claude[2].windows.map(w=>w.remainingPercent),[97.5,0]);
  assert.ok(!JSON.stringify(claude).includes('countdown'));
 } finally {cleanup(home);}
});

test('claude-swap seven_day maps to Weekly and bad percentages are rejected or clamped',()=>{
 const home=homeWith(swapFiles({1:{fetchedAt:fetched(5),lastGood:{five_hour:{pct:'x'},seven_day:{pct:130,resets_at:'bad'},scoped:[{name:'Opus',pct:Infinity},{pct:5},{name:'Sonnet',pct:40}]}}},{accounts:{1:{email:'a@example.com'}},sequence:[1]}));
 try {
  const [,provider]=claudeOnly(home).get();
  assert.deepEqual(provider.windows,[{id:'seven_day',label:'Weekly',remainingPercent:0,resetsAt:null},{id:'scoped_2',label:'Sonnet weekly',remainingPercent:60,resetsAt:null}]);
  assert.equal(provider.active,false);
 } finally {cleanup(home);}
});

test('same local part across accounts falls back to the full email',()=>{
 const sequence={activeAccountNumber:1,sequence:[1,2],accounts:{1:{email:'dev@one.com'},2:{email:'DEV@two.com'}}};
 const home=homeWith(swapFiles({1:row(1,1),2:row(2,2)},sequence));
 try {assert.deepEqual(claudeOnly(home).get().slice(1).map(p=>p.name),['Claude · dev@one.com','Claude · DEV@two.com']);} finally {cleanup(home);}
});

test('claude entries are stale when old or errored and unavailable without a reading',()=>{
 const home=homeWith(swapFiles({1:row(10,10,{fetchedAt:fetched(11*60)}),2:row(10,10,{lastError:'secret failure text',consecutiveFailures:3}),3:{lastError:'boom',consecutiveFailures:9,lastGood:null}}));
 try {
  const [,two,one,three]=claudeOnly(home).get();
  assert.equal(two.status,'stale');assert.match(two.message,/Could not refresh/);assert.equal(two.windows.length,2);assert.ok(!JSON.stringify(two).includes('secret'));
  assert.equal(one.status,'stale');assert.match(one.message,/last usage reading/);assert.equal(one.windows[0].remainingPercent,90);
  assert.equal(three.status,'unavailable');assert.deepEqual(three.windows,[]);assert.equal(three.updatedAt,null);assert.ok(three.message&&!three.message.includes('boom'));
 } finally {cleanup(home);}
});

test('claude windows whose reset has passed are stale until a fresh reading',()=>{
 const home=homeWith(swapFiles({1:row(10,10)},{activeAccountNumber:1,sequence:[1],accounts:{1:{email:'a@example.com'}}}));
 try {
  assert.equal(claudeOnly(home,NOW).get()[1].status,'available');
  const late=claudeOnly(home,Date.parse('2026-10-07T14:41:00Z')).get()[1];
  assert.equal(late.status,'stale');assert.equal(late.windows[0].remainingPercent,90);
 } finally {cleanup(home);}
});

test('malformed, oversized and non-object JSON are tolerated',()=>{
 for(const files of [
  {'.local/share/claude-swap/sequence.json':'{not json','.local/share/claude-swap/cache/usage.json':'also {bad'},
  {'.local/share/claude-swap/sequence.json':'[1,2]','.local/share/claude-swap/cache/usage.json':'null'},
  {'.local/share/claude-swap/sequence.json':JSON.stringify({accounts:{1:{email:'a@example.com'}},pad:'x'.repeat(1024*1024)}),'.local/share/claude-swap/cache/usage.json':JSON.stringify({...swapCache({1:row(1,1)}),pad:'x'.repeat(1024*1024)})},
  {'.cache/claude-herdr/oauth-usage.json':'<<<'},
  {}
 ]) {
  const home=homeWith(files);
  try {
   const providers=claudeOnly(home).get();
   assert.equal(providers.length,1);assert.equal(providers[0].id,'codex');
  } finally {cleanup(home);}
 }
 assert.deepEqual(readClaudeUsage({homeDirectory:path.join(os.tmpdir(),'definitely-missing-claude-home')}),[]);
});

test('without claude-swap data the statusline cache becomes a single Claude provider',()=>{
 const oauth={five_hour:{utilization:3,resets_at:'2026-10-07T16:39:59.809783+00:00'},seven_day:null,limits:[
  {group:'session',percent:3,resets_at:'2026-10-07T16:39:59.809783+00:00',scope:null},
  {group:'weekly',percent:1,resets_at:'2026-10-13T14:59:59.810010+00:00',scope:{model:{id:null,display_name:'Fable'}}}]};
 const home=homeWith({'.cache/claude-herdr/oauth-usage.json':oauth});
 fs.utimesSync(path.join(home,'.cache/claude-herdr/oauth-usage.json'),NOW/1000-20,NOW/1000-20);
 try {
  const [,claude,...rest]=claudeOnly(home).get();
  assert.equal(rest.length,0);
  assert.deepEqual({id:claude.id,name:claude.name,group:claude.group,status:claude.status,active:claude.active},{id:'claude',name:'Claude',group:'claude',status:'available',active:true});
  assert.deepEqual(claude.windows.map(w=>[w.id,w.label,w.remainingPercent]),[['five_hour','5-hour',97],['scoped_1','Fable weekly',99]]);
  assert.equal(claude.updatedAt,new Date(NOW-20000).toISOString());
 } finally {cleanup(home);}
});

test('switching accounts never attributes the anonymous statusline cache to the new active account',()=>{
 const sequence={activeAccountNumber:1,sequence:[1,2],accounts:{1:{email:'a@example.com'},2:{email:'b@example.com'}}};
 const home=homeWith({...swapFiles({1:row(10,10)},sequence),'.cache/claude-herdr/oauth-usage.json':{five_hour:{utilization:50,resets_at:'2026-10-07T16:00:00Z'}}});
 fs.utimesSync(path.join(home,'.cache/claude-herdr/oauth-usage.json'),NOW/1000-5,NOW/1000-5);
 try {
  assert.equal(claudeOnly(home).get()[1].account,'a@example.com');
  fs.writeFileSync(path.join(home,'.local/share/claude-swap/sequence.json'),JSON.stringify({...sequence,activeAccountNumber:2}));
  const [,b,a]=claudeOnly(home).get();
  assert.equal(b.id,'claude:2');assert.equal(b.account,'b@example.com');assert.equal(b.active,true);
  assert.equal(b.status,'unavailable');assert.deepEqual(b.windows,[]);assert.equal(b.updatedAt,null);
  assert.equal(a.id,'claude:1');assert.equal(a.windows[0].remainingPercent,90);
 } finally {cleanup(home);}
});

test('reused Claude slots reject cache rows for a different email or organization',()=>{
 const sequence={activeAccountNumber:1,sequence:[1],accounts:{1:{email:'new@example.com',organizationUuid:'new-org'}}};
 for(const identity of [{email:'old@example.com',organizationUuid:'new-org'},{email:'new@example.com',organizationUuid:'old-org'}]) {
  const home=homeWith(swapFiles({1:row(87,90,{...identity,lastError:'old failure',consecutiveFailures:2})},sequence));
  try {
   const [,provider]=claudeOnly(home).get();
   assert.equal(provider.account,'new@example.com');assert.equal(provider.status,'unavailable');
   assert.deepEqual(provider.windows,[]);assert.equal(provider.updatedAt,null);
   assert.ok(!provider.message.includes('old failure'));
  } finally {cleanup(home);}
 }
});

test('matching Claude email and organization preserve account-specific quota',()=>{
 const sequence={activeAccountNumber:1,sequence:[1,2],accounts:{1:{email:'same@example.com',organizationUuid:'org-one'},2:{email:'same@example.com',organizationUuid:'org-two'}}};
 const home=homeWith(swapFiles({1:row(10,20),2:row(80,90)},sequence));
 try {
  const providers=claudeOnly(home).get().slice(1);
  assert.deepEqual(providers.map(p=>p.status),['available','available']);
  assert.deepEqual(providers.map(p=>p.windows[0].remainingPercent),[90,20]);
 } finally {cleanup(home);}
});

test('cache-only Claude entries keep their own account labels and usage',()=>{
 const home=homeWith({'.local/share/claude-swap/cache/usage.json':swapCache({4:row(25,30,{email:'cache@example.com',organizationUuid:'cache-org'})})});
 try {
  const [,provider]=claudeOnly(home).get();
  assert.equal(provider.id,'claude:4');assert.equal(provider.account,'cache@example.com');
  assert.equal(provider.name,'Claude · cache');assert.equal(provider.active,false);
  assert.equal(provider.status,'available');assert.equal(provider.windows[0].remainingPercent,75);
 } finally {cleanup(home);}
});

test('claude reads are cached for ~15 seconds',()=>{
 let time=NOW,reads=0;
 const source=createUsageSource({refreshClaude:()=>null,now:()=>time,read:()=>({promise:new Promise(()=>{})}),homeDirectory:'/unused',readClaude:()=>{reads++;return [];}});
 source.get();source.get();time+=14000;source.get();assert.equal(reads,1);
 time+=2000;source.get();assert.equal(reads,2);
 source.close();time+=60000;source.get();assert.equal(reads,2);
});

test('claude usage never opens credential files',()=>{
 const secret='SECRET_TOKEN_DO_NOT_LEAK';
 const home=homeWith({...swapFiles({1:row(10,10)}),'.claude/.credentials.json':{token:secret},'.local/share/claude-swap/credentials/1.json':{token:secret}});
 const opened=[],realOpen=fs.openSync,realRead=fs.readFileSync;
 fs.openSync=(file,...rest)=>{opened.push(String(file));return realOpen(file,...rest);};
 fs.readFileSync=(file,...rest)=>{opened.push(String(file));return realRead(file,...rest);};
 try {
  const text=JSON.stringify(claudeOnly(home).get());
  assert.ok(!text.includes(secret));
  assert.ok(opened.length>0);
  const allowed=['.local/share/claude-swap/sequence.json','.local/share/claude-swap/cache/usage.json','.cache/claude-herdr/oauth-usage.json'].map(rel=>path.join(home,rel));
  for(const file of opened.filter(file=>file.startsWith(home)))assert.ok(allowed.includes(file),`unexpected read of ${file}`);
  assert.ok(!opened.some(file=>/credentials/.test(file)));
 } finally {fs.openSync=realOpen;fs.readFileSync=realRead;cleanup(home);}
});

test('bridge fixtures do not read the real home for Claude usage',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-usage-'));
 const app=createBridge({socketPath:'/unused',stateDir:dir,projects:[]},{herdr:{call:async()=>({snapshot:{protocol:22,panes:[],workspaces:[]}})}});
 try {assert.deepEqual((await app.snapshot()).usage.map(p=>p.id),['codex']);}
 finally {await app.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('Claude usage asks claude-swap to refresh on its own cadence and rereads afterwards',async()=>{
  let time=1000,asked=0,reads=0,finish;
  const source=createUsageSource({now:()=>time,read:()=>({promise:new Promise(()=>{})}),homeDirectory:'/unused',claudeRefreshMs:10,claudeCollectMs:1000,
    refreshClaude:()=>{asked++;return {promise:new Promise(resolve=>{finish=resolve;})};},readClaude:()=>{reads++;return [];}});
  source.get();source.get();assert.equal(asked,1);
  time+=500;source.get();assert.equal(asked,1);
  const before=reads;finish();await new Promise(resolve=>setImmediate(resolve));
  source.get();assert.ok(reads>before);
  time+=1000;source.get();assert.equal(asked,2);
  source.close();
});
test('refreshClaudeUsage never runs without claude-swap data and tolerates a missing tool',async()=>{
  const {refreshClaudeUsage}=await import('../src/usage.js');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'usage-refresh-'));
  let spawned=0;const fake=()=>{spawned++;throw Object.assign(new Error('missing'),{code:'ENOENT'});};
  assert.equal(refreshClaudeUsage({homeDirectory:home,spawnProcess:fake}),null);assert.equal(spawned,0);
  fs.mkdirSync(path.join(home,'.local/share/claude-swap'),{recursive:true});fs.writeFileSync(path.join(home,'.local/share/claude-swap/sequence.json'),'{}');
  const run=refreshClaudeUsage({homeDirectory:home,spawnProcess:fake});await run.promise;assert.equal(spawned,1);
  fs.rmSync(home,{recursive:true,force:true});
});
