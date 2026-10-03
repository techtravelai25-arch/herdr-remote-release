import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Store} from '../src/store.js';
import {createPushMonitor} from '../src/push.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(t,fetcher=async()=>({ok:true})) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'push-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const tokenFile=path.join(dir,'token');fs.writeFileSync(tokenFile,'b'.repeat(43),{mode:0o600});
  const store=new Store(path.join(dir,'state'));let time=2000000000000;
  const config={cloudPush:{portalOrigin:'https://remote.example.com',deviceId:'laptop',tokenFile}};
  const make=()=>{const m=createPushMonitor(config,store,{fetcher,now:()=>time,interval:1000000});t.after(()=>m.close());return m;};
  const observe=(m,status,extra={})=>m.observe({herdrOnline:true,panes:[{id:'w1:p1',kind:'codex',status,...extra}]});
  return {make,observe,store,config,advance:ms=>{time+=ms;},now:()=>time};
}
test('push monitor fails closed on unsafe config and first snapshot never alerts',async t=>{
  let calls=0;const s=setup(t,async()=>{calls++;return {ok:true};});const m=s.make();s.observe(m,'blocked');await tick();assert.equal(calls,0);
  assert.equal(createPushMonitor({},s.store).enabled,false);
  const legacy=createPushMonitor({cloudPush:{...s.config.cloudPush,portalOrigin:'https://legacy.example.com'}},s.store);t.after(()=>legacy.close());
  assert.equal(legacy.enabled,true);
  assert.throws(()=>createPushMonitor({cloudPush:{...s.config.cloudPush,portalOrigin:'http://evil.example'}},s.store));
  fs.chmodSync(s.config.cloudPush.tokenFile,0o644);assert.throws(()=>s.make());
});
test('relay-backed push uses its private laptop identity at the transport boundary',async t=>{
  const calls=[];const s=setup(t,async(url,options)=>{calls.push({url,options});return {ok:true};});
  const identity={id:'relay-laptop',relayToken:'r'.repeat(43),url:'https://selfhost.example'};
  s.store.write('relay-identity.json',identity);
  s.config.cloudPush={source:'relay'};
  const m=s.make();s.observe(m,'working');s.observe(m,'done',{text:'private terminal output',title:'private title'});await tick();
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://selfhost.example/v1/push/events');
  assert.equal(calls[0].options.headers.Authorization,`Bearer ${identity.relayToken}`);
  assert.equal(calls[0].options.headers['X-Herdr-Laptop-ID'],identity.id);
  assert.deepEqual(Object.keys(JSON.parse(calls[0].options.body)).sort(),['createdAt','eventId','kind','paneId']);
  assert.equal(JSON.parse(calls[0].options.body).kind,'done');
  assert.doesNotMatch(JSON.stringify(s.config)+JSON.stringify(s.store.read('push-outbox.json')),/rrrrrrrrrrrr/);
});
test('relay-backed push rejects missing, exposed or invalid identity before transport',t=>{
  const s=setup(t);s.config.cloudPush={source:'relay'};
  const file=path.join(s.store.dir,'relay-identity.json');
  assert.throws(()=>s.make(),/identity/i);
  const valid={id:'relay-laptop',relayToken:'r'.repeat(43),url:'https://remote.example.com'};
  s.store.write('relay-identity.json',valid);
  fs.chmodSync(file,0o644);assert.throws(()=>s.make(),/private/i);
  fs.chmodSync(file,0o600);
  for(const invalid of [{...valid,id:'bad id'},{...valid,relayToken:'short'},
    {...valid,url:'http://remote.example.com'},{...valid,url:'https://remote.example.com/path'}]) {
    s.store.write('relay-identity.json',invalid);
    assert.throws(()=>s.make(),/identity/i);
  }
  fs.writeFileSync(file,'',{mode:0o600});
  assert.throws(()=>s.make(),/identity/i);
  fs.writeFileSync(file,JSON.stringify(valid)+' '.repeat(16*1024),{mode:0o600});
  assert.throws(()=>s.make(),/identity/i,'oversized but valid JSON must not be read as a credential');
  fs.unlinkSync(file);fs.mkdirSync(file,{mode:0o700});
  assert.throws(()=>s.make(),/private/i);
  fs.rmdirSync(file);
  assert.equal(spawnSync('mkfifo',[file]).status,0);
  const probe=`
    import {Store} from ${JSON.stringify(new URL('../src/store.js',import.meta.url).href)};
    import {createPushMonitor} from ${JSON.stringify(new URL('../src/push.js',import.meta.url).href)};
    try { createPushMonitor({cloudPush:{source:'relay'}},new Store(process.argv[1])); process.exitCode=2; }
    catch(error) { if(!/private|identity/i.test(error.message)) process.exitCode=3; }
  `;
  const fifo=spawnSync(process.execPath,['--input-type=module','--eval',probe,s.store.dir],{timeout:1500,encoding:'utf8'});
  assert.equal(fifo.error?.code,undefined,'identity FIFO must not block startup');
  assert.equal(fifo.status,0,'identity FIFO must fail closed');
  fs.unlinkSync(file);
  s.store.write('relay-identity.json',valid);
  const link=path.join(s.store.dir,'linked-identity.json');fs.renameSync(file,link);fs.symlinkSync(link,file);
  assert.throws(()=>s.make(),/private/i);
});
test('monitor emits only transitions, preserves working across unknown and excludes terminal content',async t=>{
  const calls=[];const s=setup(t,async(url,options)=>{calls.push({url,options,body:JSON.parse(options.body)});return {ok:true};});const m=s.make();
  s.observe(m,'working');s.observe(m,'unknown');s.observe(m,'idle',{text:'secret output',title:'secret title'});await tick();
  s.observe(m,'idle');await tick();assert.equal(calls.length,1);assert.equal(calls[0].body.kind,'done');assert.deepEqual(Object.keys(calls[0].body).sort(),['createdAt','eventId','kind','paneId']);assert.equal(calls[0].options.redirect,'error');
  s.observe(m,'blocked');await tick();assert.equal(calls.at(-1).body.kind,'needs_input');
  s.observe(m,'error');await tick();assert.equal(calls.at(-1).body.kind,'error');
  s.observe(m,'working',{kind:'terminal'});s.observe(m,'idle',{kind:'terminal'});await tick();assert.equal(calls.length,3);
});
test('durable outbox retries same event after restart without replaying agent input',async t=>{
  const sent=[];let online=false;const s=setup(t,async(_url,options)=>{sent.push(JSON.parse(options.body));return {ok:online};});let m=s.make();s.observe(m,'working');s.observe(m,'idle');await tick();
  const saved=s.store.read('push-outbox.json');assert.equal(saved.queue.length,1);m.close();online=true;m=s.make();await m.flush();assert.equal(sent.length,2);assert.equal(sent[0].eventId,sent[1].eventId);assert.equal(s.store.read('push-outbox.json').queue.length,0);
  m.close();m=s.make();s.observe(m,'idle');await tick();assert.equal(sent.length,2);
});
test('persisted working state produces one completion after bridge restart and Herdr outage',async t=>{
  const sent=[];const s=setup(t,async(_url,options)=>{sent.push(JSON.parse(options.body));return {ok:true};});let m=s.make();s.observe(m,'working');await tick();m.close();m=s.make();m.observe({herdrOnline:false,panes:[]});s.observe(m,'done');await tick();assert.equal(sent.length,1);assert.equal(sent[0].kind,'done');
});
test('expired outbox events are not sent and are removed from persistent storage',async t=>{
  let calls=0;const s=setup(t,async()=>{calls++;return {ok:true};});s.store.write('push-outbox.json',{states:{},queue:[{eventId:'old',paneId:'p',kind:'done',createdAt:Math.floor((s.now()-86400001)/1000)}]});const m=s.make();await m.flush();assert.equal(calls,0);assert.equal(s.store.read('push-outbox.json').queue.length,0);
});

test('a pane completion is cleared on work resumption and persists its acknowledgement across restart',async t=>{
  const sent=[];const s=setup(t,async(_url,options)=>{sent.push(JSON.parse(options.body));return {ok:true};});let m=s.make();
  s.observe(m,'working');const completed=m.observe({herdrOnline:true,panes:[{id:'w1:p1',kind:'codex',status:'done'}]});
  const id=completed.panes[0].completionEventId;
  assert.equal(completed.panes[0].completionAcknowledged,false);
  assert.equal(sent[0]?.kind,'done');
  const resumed=m.observe({herdrOnline:true,panes:[{id:'w1:p1',kind:'codex',status:'working'}]});
  await tick();assert.equal(resumed.panes[0].completionEventId,id);assert.equal(resumed.panes[0].completionAcknowledged,true);
  assert.deepEqual(sent.map(e=>e.kind),['done','clear']);assert.equal(sent[1].targetEventId,id);assert.notEqual(sent[1].eventId,id);
  m.close();m=s.make();assert.equal(m.completionFor('w1:p1'),null);
  assert.equal(m.annotate({panes:[{id:'w1:p1'}]}).panes[0].completionAcknowledged,true);
});

test('done to idle clears the seen completion, while working to idle creates a completion without a clear',async t=>{
  const sent=[];const s=setup(t,async(_url,options)=>{sent.push(JSON.parse(options.body));return {ok:true};});const m=s.make();
  s.observe(m,'working');s.observe(m,'idle');await tick();
  assert.deepEqual(sent.map(e=>e.kind),['done']);const first=sent[0].eventId;
  s.observe(m,'working');s.observe(m,'done');await tick();
  assert.deepEqual(sent.map(e=>e.kind),['done','clear','done']);
  assert.equal(sent[1].targetEventId,first);const second=sent[2].eventId;
  s.observe(m,'idle');await tick();assert.equal(sent[3].kind,'clear');assert.equal(sent[3].targetEventId,second);
});

test('a prompt acknowledgement targets only the captured completion identity',async t=>{
  const sent=[];const s=setup(t,async(_url,options)=>{sent.push(JSON.parse(options.body));return {ok:true};});const m=s.make();
  s.observe(m,'working');s.observe(m,'done');await tick();const captured=m.completionFor('w1:p1');
  s.observe(m,'working');s.observe(m,'done');await tick();const latest=m.completionFor('w1:p1');
  assert.notEqual(latest,captured);assert.equal(m.acknowledge('w1:p1',captured),false);
  assert.equal(m.completionFor('w1:p1'),latest);assert.equal(m.acknowledge('w1:p1',latest),true);
  assert.equal(m.acknowledge('w1:p1',latest),false);await tick();
  assert.deepEqual(sent.filter(e=>e.kind==='clear').map(e=>e.targetEventId),[captured,latest]);
});

test('offline clears retry from the durable outbox without losing acknowledgement',async t=>{
  let online=false;const sent=[];const s=setup(t,async(_url,options)=>{sent.push(JSON.parse(options.body));return {ok:online};});let m=s.make();
  s.observe(m,'working');s.observe(m,'done');await tick();const id=m.completionFor('w1:p1');
  assert.equal(m.acknowledge('w1:p1',id),true);m.close();
  const saved=s.store.read('push-outbox.json');assert.equal(saved.queue.length,2);assert.equal(saved.states['w1:p1'].completionAcknowledged,true);
  online=true;s.advance(60000);m=s.make();await m.flush();
  assert.deepEqual(sent.slice(-2).map(e=>e.kind),['done','clear']);assert.equal(sent.at(-1).targetEventId,id);
  assert.equal(s.store.read('push-outbox.json').queue.length,0);
});

test('local mode tracks and annotates completion without cloud configuration',t=>{
  const s=setup(t);const m=createPushMonitor({},s.store);t.after(()=>m.close());
  assert.equal(m.enabled,false);assert.equal(m.tracking,true);
  m.observe({herdrOnline:true,panes:[{id:'w1:p1',kind:'codex',status:'working'}]});
  const done=m.observe({herdrOnline:true,panes:[{id:'w1:p1',kind:'codex',status:'done'}]});
  const id=done.panes[0].completionEventId;assert.ok(id);assert.equal(done.panes[0].completionAcknowledged,false);
  const restarted=createPushMonitor({},s.store);t.after(()=>restarted.close());assert.equal(restarted.completionFor('w1:p1'),id);
  assert.equal(restarted.acknowledge('w1:p1',id),true);
  assert.equal(restarted.annotate({panes:[{id:'w1:p1'}]}).panes[0].completionAcknowledged,true);
  assert.deepEqual(s.store.read('push-outbox.json').queue,[]);
});

test('acknowledged A remains in the snapshot after newer B completes and after restart',t=>{
  const s=setup(t);let m=createPushMonitor({},s.store);t.after(()=>m.close());
  const pane=status=>({herdrOnline:true,panes:[{id:'w1:p1',kind:'codex',status}]});
  m.observe(pane('working'));
  const a=m.observe(pane('done')).panes[0].completionEventId;
  const afterAck=m.observe(pane('working')).panes[0];
  assert.deepEqual(afterAck.acknowledgedCompletionEventIds,[a]);
  const b=m.observe(pane('done')).panes[0];
  assert.notEqual(b.completionEventId,a);assert.equal(b.completionAcknowledged,false);
  assert.deepEqual(b.acknowledgedCompletionEventIds,[a]);
  m.close();m=createPushMonitor({},s.store);t.after(()=>m.close());
  assert.deepEqual(m.annotate(pane('done')).panes[0].acknowledgedCompletionEventIds,[a]);
  assert.equal(m.completionFor('w1:p1'),b.completionEventId);
});

test('acknowledged completion history is bounded to the latest 128 exact IDs',t=>{
  const s=setup(t);const m=createPushMonitor({},s.store);t.after(()=>m.close());
  const pane=status=>({herdrOnline:true,panes:[{id:'w1:p1',kind:'codex',status}]});
  m.observe(pane('working'));
  const ids=[];
  for(let i=0;i<130;i++) {
    const id=m.observe(pane('done')).panes[0].completionEventId;ids.push(id);
    assert.equal(m.acknowledge('w1:p1',id),true);
    if(i<129)m.observe(pane('working'));
  }
  const visible=m.annotate(pane('done')).panes[0];
  assert.deepEqual(visible.acknowledgedCompletionEventIds,ids.slice(-128));
  assert.equal(visible.completionEventId,ids.at(-1));assert.equal(visible.completionAcknowledged,true);
  assert.deepEqual(s.store.read('push-outbox.json').states['w1:p1'].acknowledgedCompletionEventIds,ids.slice(-128));
});

test('stale and offline snapshots cannot acknowledge or discard a pending completion',t=>{
  const s=setup(t);const m=createPushMonitor({},s.store);t.after(()=>m.close());
  s.observe(m,'working');s.observe(m,'done');const id=m.completionFor('w1:p1');
  for(const extra of [{herdrOnline:false},{stale:true}]) {
    m.observe({herdrOnline:true,panes:[{id:'w1:p1',kind:'codex',status:'working'}],...extra});
    m.observe({herdrOnline:true,panes:[],...extra});
    assert.equal(m.completionFor('w1:p1'),id);
  }
  m.observe({herdrOnline:true,panes:[]});
  assert.equal(m.completionFor('w1:p1'),null);
});

test('outbox trimming during delivery does not discard a different queued event',async t=>{
  let release;const sent=[];
  const s=setup(t,async(_url,options)=>{
    sent.push(JSON.parse(options.body));
    if(sent.length===1)await new Promise(resolve=>{release=resolve;});
    return {ok:true};
  });
  const m=s.make();s.observe(m,'working');s.observe(m,'done');
  for(let i=0;i<70;i++) {s.observe(m,'working');s.observe(m,'done');}
  const queued=s.store.read('push-outbox.json').queue.map(e=>e.eventId);
  assert.equal(queued.length,128);assert.ok(!queued.includes(sent[0].eventId));
  release();await tick();
  assert.deepEqual(sent.slice(1).map(e=>e.eventId),queued);
  assert.equal(s.store.read('push-outbox.json').queue.length,0);
});
