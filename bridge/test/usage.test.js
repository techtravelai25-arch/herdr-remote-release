import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createUsageSource,normalizeCodexUsage,readCodexRateLimits} from '../src/usage.js';
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
 const source=createUsageSource({now:()=>time,refreshMs:100,read:()=>{calls++;return {promise:new Promise((yes,no)=>{resolve=yes;reject=no;})};}});
 assert.equal(source.get()[0].status,'unavailable');source.get();assert.equal(calls,1);
 resolve(data);await settle();assert.equal(source.get()[0].status,'available');
 time+=101;source.get();source.get();assert.equal(calls,2);
 reject(new Error('secret error'));await settle();
 const stale=source.get()[0];assert.equal(stale.status,'stale');assert.equal(stale.windows[0].remainingPercent,76);assert.equal(stale.updatedAt,new Date(1000).toISOString());assert.ok(!stale.message.includes('secret'));
 source.close();time+=1000;source.get();assert.equal(calls,2);
});
test('expired windows are stale until freshly read, never auto-refilled',async()=>{
 let time=1000;const source=createUsageSource({now:()=>time,read:()=>({promise:Promise.resolve({rateLimits:{primary:{usedPercent:100,resetsAt:2}}})})});
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
