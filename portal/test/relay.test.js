import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {MAX_ENVELOPE_BYTES,handleRelay,readEnvelope} from '../src/relay.js';
let mf,db;const sockets=[];
const hash=x=>createHash('sha256').update(x).digest('hex');
const token='t'.repeat(43),origin='https://remote.example.com';
before(async()=>{
 const result=await build({entryPoints:[new URL('../src/worker.js',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'neutral',external:['cloudflare:*','node:*'],conditions:['workerd','worker','browser']});
 mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:"relay-test",modules:true,script:result.outputFiles[0].text,compatibilityDate:'2026-09-20',compatibilityFlags:['nodejs_compat'],bindings:{PORTAL_ORIGIN:origin,DEVICES:'[]',PUBLIC_SIGNUP_ENABLED:'true',LEGACY_RELAY_UNTIL:String(Math.floor(Date.now()/1000)+3600)},d1Databases:['DB'],ratelimits:{EDGE_RELAY_LIMIT:{namespace_id:'1',simple:{limit:12000,period:60}},EDGE_SIGNUP_LIMIT:{namespace_id:'2',simple:{limit:120,period:60}}},durableObjects:{RELAY:{className:'Relay',useSQLite:true}}}],log:new Log(LogLevel.ERROR)}));
 db=await mf.getD1Database('DB');
 for(const f of ['0001_auth.sql','0002_push.sql','0003_public.sql','0004_admission.sql']){const sql=await readFile(new URL('../migrations/'+f,import.meta.url),'utf8');for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();}
});
after(async()=>{for(const ws of sockets)try{ws.close();}catch{}await mf?.dispose();});
async function laptop(){const id=randomUUID();await db.prepare('INSERT INTO laptops(id,label,relay_token_hash,claim_token_hash,public_key,created_at) VALUES (?,?,?,?,?,?)').bind(id,'Test',hash(token),hash('claim'),'public',1).run();return id;}
const envelope=()=>({v:1,id:randomUUID(),iv:'a'.repeat(16),data:'b'.repeat(30),epk:'c'.repeat(122)});
test('relay envelope accepts JSON media type parameters and rejects lookalike types',async()=>{
 const value=envelope();
 assert.deepEqual(await readEnvelope(new Request(origin+'/v1/relay/test/rpc',{method:'POST',headers:{'Content-Type':'application/json; charset=utf-8'},body:JSON.stringify(value)})),value);
 assert.equal(await readEnvelope(new Request(origin+'/v1/relay/test/rpc',{method:'POST',headers:{'Content-Type':'application/jsonx'},body:JSON.stringify(value)})),null);
});
test('body cancellation never waits for a stalled or rejected stream cancel',async()=>{
 for(const cancel of [()=>new Promise(()=>{}),()=>Promise.reject(Error('cancel failed'))]){
  const abort=new AbortController();
  const body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel});
  const request=new Request(origin+'/v1/relay/test/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body,duplex:'half'});
  const pending=readEnvelope(request,{signal:abort.signal});
  abort.abort(Error('upload stopped'));
  await assert.rejects(Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(Error('cancel blocked upload shutdown')),1000))]),/upload stopped/);
 }
});
test('oversized ciphertext returns promptly even if stream cancellation stalls',async()=>{
 const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(MAX_ENVELOPE_BYTES+1));},cancel(){return new Promise(()=>{});}});
 const request=new Request(origin+'/v1/relay/test/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body,duplex:'half'});
 assert.equal(await Promise.race([readEnvelope(request),new Promise((_,reject)=>setTimeout(()=>reject(Error('oversized upload waited for stream cancellation')),1000))]),null);
});
const rpc=(id,e=envelope(),extra={})=>mf.dispatchFetch(`${origin}/v1/relay/${id}/rpc`,{method:'POST',headers:{'Content-Type':'application/json',...extra},body:JSON.stringify(e)});
async function connect(id,credential=token){return mf.dispatchFetch(`${origin}/v1/relay/${id}/connect`,{headers:{Upgrade:'websocket',Authorization:'Bearer '+credential}});}
async function socket(id){const r=await connect(id);assert.equal(r.status,101);const ws=r.webSocket;ws.accept();sockets.push(ws);return ws;}
function next(ws){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.removeEventListener('message',message);reject(Error('relay frame timeout'));},5000);function message(e){clearTimeout(timer);ws.removeEventListener('message',message);resolve(JSON.parse(e.data));}ws.addEventListener('message',message);});}
const reply=(ws,e)=>ws.send(JSON.stringify({type:'response',envelope:{v:e.v,id:e.id,iv:e.iv,data:e.data}}));
test('workerd authenticates laptop sockets and returns opaque responses without leaking credentials',async()=>{
 const id=await laptop();assert.equal((await connect(id,'x'.repeat(43))).status,401);
 assert.equal((await rpc(id)).status,503);
 const ws=await socket(id),e=envelope(),frame=next(ws),pending=rpc(id,e);
 assert.deepEqual(await frame,{type:'request',envelope:e});reply(ws,e);const r=await pending;assert.equal(r.status,200);assert.deepEqual(await r.json(),{v:e.v,id:e.id,iv:e.iv,data:e.data});
});
test('workerd isolates laptops and refuses duplicate in-flight requests',async()=>{
 const a=await laptop(),b=await laptop(),wa=await socket(a),wb=await socket(b),ea=envelope(),eb=envelope();
 const fa=next(wa),fb=next(wb),pa=rpc(a,ea),pb=rpc(b,eb);assert.deepEqual((await fa).envelope,ea);assert.deepEqual((await fb).envelope,eb);
 assert.equal((await rpc(a,ea)).status,409);
 // An authenticated different laptop cannot satisfy another laptop’s request.
 reply(wb,ea);reply(wa,ea);reply(wb,eb);assert.equal((await pa).status,200);assert.equal((await pb).status,200);
});
test('workerd disconnect and replacement fail pending actions with uncertain delivery',async()=>{
 const id=await laptop(),ws=await socket(id),e=envelope(),frame=next(ws),pending=rpc(id,e);await frame;ws.close(1000,'test disconnect');const response=await pending;assert.equal(response.status,503);assert.equal((await response.json()).error.code,'delivery_unknown');
 const ws2=await socket(id),f=next(ws2),p=rpc(id);await f;await socket(id);assert.equal((await p).status,503);
});
test('workerd blocks revoked laptops, plaintext fields, oversized bodies, and cross-origin calls',async()=>{
 const id=await laptop();await socket(id);
 assert.equal((await rpc(id,{...envelope(),prompt:'not ciphertext'})).status,400);
 assert.equal((await rpc(id,{...envelope(),data:'b'.repeat(MAX_ENVELOPE_BYTES)})).status,400);
 assert.equal((await rpc(id,envelope(),{Origin:origin})).status,403);
 await db.prepare('UPDATE laptops SET owner_email=? WHERE id=?').bind('owner@example.com',id).run();
 await db.prepare('INSERT INTO sessions(token_hash,id,request_hash,email,expires_at) VALUES (?,?,?,?,?)').bind(hash('account'),randomUUID(),randomUUID(),'owner@example.com',Math.floor(Date.now()/1000)+600).run();
 const revoked=await mf.dispatchFetch(`${origin}/v1/devices/${id}`,{method:'DELETE',headers:{Authorization:'Bearer account'}});assert.equal(revoked.status,200);assert.equal((await rpc(id)).status,404);assert.equal((await connect(id)).status,401);
});
test('workerd enforces concurrent per-laptop capacity',async()=>{
 const id=await laptop(),ws=await socket(id),received=[];ws.addEventListener('message',event=>received.push(JSON.parse(event.data).envelope));
 const pending=Array.from({length:8},()=>rpc(id));
 for(let i=0;i<100&&received.length<8;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(received.length,8);
 assert.equal((await rpc(id)).status,429);for(const e of received)reply(ws,e);assert.deepEqual((await Promise.all(pending)).map(r=>r.status),Array(8).fill(200));

});
test('encrypted round trip reaches bridge once; replay is rejected by laptop across handler restart',async()=>{
 const {generateIdentity,deriveKey,encryptPayload,decryptPayload,createRelayHandler}=await import('../../bridge/src/relay.js');
 const id=await laptop(),identity={...generateIdentity(),id},phone=generateIdentity(),ws=await socket(id);
 let forwards=0;const persisted=new Map();const store={read:(key,fallback)=>persisted.get(key)||fallback,write:(key,value)=>persisted.set(key,value)};
 const options={identity,port:12345,store,fetchImpl:async()=>{forwards++;return new Response('private response');}};
 let bridge=createRelayHandler(options),onRejected=()=>{};
 ws.addEventListener('message',async event=>{const frame=JSON.parse(event.data);try{const response=await bridge(frame.envelope);ws.send(JSON.stringify({type:'response',envelope:response}));}catch{onRejected();}});
 const requestId=randomUUID(),key=deriveKey(phone.privateKey,identity.publicKey,id,requestId);
 const e={...encryptPayload(key,id,requestId,{timestamp:Date.now(),method:'GET',path:'/v1/health',headers:{},body:''},'request'),epk:phone.publicKey};
 const response=await rpc(id,e);assert.equal(response.status,200);const value=decryptPayload(key,id,await response.json(),'response');assert.equal(Buffer.from(value.body,'base64url').toString(),'private response');assert.equal(forwards,1);
 bridge=createRelayHandler(options);const rejected=new Promise(resolve=>{onRejected=resolve;});const replay=rpc(id,e);await rejected;assert.equal(forwards,1);ws.close(1000,'test complete');assert.equal((await replay).status,503);
});
async function control(ws,capability,action='register') {const id=randomUUID(),ack=next(ws);const {bearer,...safeCapability}=capability;ws.send(JSON.stringify({type:'capability',id,action,capability:safeCapability}));const result=await ack;assert.equal(result.type,'capability-ack');assert.equal(result.id,id);return result;}
async function capability(ws,kind='phone',expires=0){const value={id:randomUUID(),kind,tokenHash:hash(randomUUID()),expires};const bearer=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');value.tokenHash=hash(bearer);assert.equal((await control(ws,value)).ok,true);return {...value,bearer};}
const routed=(id,cap,e=envelope())=>rpc(id,e,{Authorization:'Bearer '+cap.bearer});
test('strict capability admission rejects junk before queueing and preserves owner traffic',async()=>{
 const id=await laptop();await db.prepare('UPDATE laptops SET relay_auth_version=1 WHERE id=?').bind(id).run();const ws=await socket(id);
 for(let i=0;i<20;i++)assert.equal((await rpc(id)).status,401);
 const cap=await capability(ws);const frame=next(ws),pending=routed(id,cap);const request=await frame;assert.deepEqual(request.capability,{id:cap.id,kind:'phone'});reply(ws,request.envelope);assert.equal((await pending).status,200);
 assert.equal((await routed(id,{bearer:'x'.repeat(43)})).status,401);
});
test('capability promotion and revocation survive reconnect and cannot be undone by stale registration',async()=>{
 const id=await laptop(),ws=await socket(id),cap=await capability(ws);
 assert.equal((await rpc(id)).status,401);assert.equal((await control(ws,cap)).ok,true);
 const frame=next(ws),pending=routed(id,cap);await frame;
 assert.equal((await control(ws,{id:cap.id},'revoke')).ok,true);assert.equal((await pending).status,401);
 assert.equal((await control(ws,cap)).error,'capability_revoked');assert.equal((await control(ws,{id:randomUUID()},'revoke')).error,'capability_not_found');
 const replacement=await socket(id);assert.equal((await rpc(id)).status,401);assert.equal((await routed(id,cap)).status,401);assert.equal((await control(replacement,cap)).error,'capability_revoked');
});
test('all bootstrap capabilities share a small pending budget and cannot starve a paired phone',async()=>{
 const id=await laptop(),ws=await socket(id),phone=await capability(ws),one=await capability(ws,'bootstrap',Math.floor(Date.now()/1000)+600),two=await capability(ws,'bootstrap',Math.floor(Date.now()/1000)+600),three=await capability(ws,'bootstrap',Math.floor(Date.now()/1000)+600);
 const f1=next(ws),p1=routed(id,one),r1=(await f1).envelope;const f2=next(ws),p2=routed(id,two),r2=(await f2).envelope;
 assert.equal((await routed(id,three)).status,429);
 const f3=next(ws),p3=routed(id,phone),r3=(await f3).envelope;reply(ws,r3);assert.equal((await p3).status,200);
 reply(ws,r1);reply(ws,r2);assert.equal((await p1).status,200);assert.equal((await p2).status,200);
});
test('routine authorized RPC works without laptops or rate_limits D1 tables',async()=>{
 const id=await laptop(),ws=await socket(id),cap=await capability(ws);
 await db.prepare('ALTER TABLE laptops RENAME TO withheld_laptops').run();await db.prepare('ALTER TABLE rate_limits RENAME TO withheld_limits').run();
 try{const f=next(ws),p=routed(id,cap);reply(ws,(await f).envelope);assert.equal((await p).status,200);}finally{await db.prepare('ALTER TABLE withheld_laptops RENAME TO laptops').run();await db.prepare('ALTER TABLE withheld_limits RENAME TO rate_limits').run();}
});
test('bootstrap expiry is enforced, and capability identity cannot be changed in place',async()=>{
 const id=await laptop(),ws=await socket(id),cap=await capability(ws,'bootstrap',Math.floor(Date.now()/1000)+600);
 assert.equal((await control(ws,{...cap,tokenHash:'a'.repeat(64)})).error,'capability_conflict');
 const expires=Math.floor(Date.now()/1000)+2,shortLived=await capability(ws,'bootstrap',expires);
 const untilExpiry=expires*1000-Date.now()+25;if(untilExpiry>0)await new Promise(resolve=>setTimeout(resolve,untilExpiry));
 assert.equal((await routed(id,shortLived)).status,401);
});
test('slow legacy body cannot pass after strict promotion',async()=>{
 const id=await laptop(),ws=await socket(id);let controller,forwarded=0;
 ws.addEventListener('message',event=>{if(JSON.parse(event.data).type==='request')forwarded++;});
 const body=new ReadableStream({start(value){controller=value;controller.enqueue(new TextEncoder().encode('{'));}});
 const pending=mf.dispatchFetch(`${origin}/v1/relay/${id}/rpc`,{method:'POST',headers:{'Content-Type':'application/json'},body,duplex:'half'})
  .then(response=>response.status,error=>{assert.equal(error.message,'fetch failed');return 'transport_closed';});
 try{
  await new Promise(resolve=>setTimeout(resolve,50));await capability(ws);
  const result=await Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(Error('legacy upload stayed open after strict promotion')),2000))]);
  assert.ok(result===401||result==='transport_closed');assert.equal(forwarded,0);
  assert.equal((await rpc(id)).status,401);
 }finally{try{controller.close();}catch{}}
});
test('WebSocket control flood is bounded across reconnects',async()=>{
 if(Date.now()%60000>54000)await new Promise(resolve=>setTimeout(resolve,60010-Date.now()%60000));
 const id=await laptop(),ws=await socket(id),cap=await capability(ws);
 for(let i=1;i<300;i++)assert.equal((await control(ws,cap)).ok,true);
 const closed=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('control flood was not closed')),5000);ws.addEventListener('close',()=>{clearTimeout(timer);resolve();},{once:true});});
 ws.send(JSON.stringify({type:'capability',id:randomUUID(),action:'register',capability:cap}));await closed;
 const replacement=await socket(id);const again=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('reconnect reset control budget')),5000);replacement.addEventListener('close',()=>{clearTimeout(timer);resolve();},{once:true});});
 replacement.send(JSON.stringify({type:'capability',id:randomUUID(),action:'register',capability:cap}));await again;
});
test('real strict bridge enforces bootstrap pairing scope and binds phone capability to paired control token',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'strict-relay-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const {Store}=await import('../../bridge/src/store.js');const {routingCapabilities}=await import('../../bridge/src/routing-capabilities.js');const {generateIdentity,deriveKey,encryptPayload,decryptPayload,createRelayHandler}=await import('../../bridge/src/relay.js');
 const store=new Store(dir),routing=routingCapabilities(store),id=await laptop(),identity={...generateIdentity(),id},phone=generateIdentity(),ws=await socket(id);
 const boot=routing.create('bootstrap',{expires:Math.floor(Date.now()/1000)+300});assert.equal((await control(ws,boot.capability)).ok,true);routing.onAck(boot.capability.id,'register',{ok:true});
 const paired=store.pair(store.pairCode(),'synthetic phone');const record=routing.create('phone',{deviceId:paired.deviceId});assert.equal((await control(ws,record.capability)).ok,true);routing.onAck(record.capability.id,'register',{ok:true});
 let forwarded=0;const handler=createRelayHandler({identity,port:9,store,routing,fetchImpl:async()=>{forwarded++;return new Response('synthetic-private');}});
 ws.addEventListener('message',async event=>{const frame=JSON.parse(event.data);if(frame.type!=='request')return;const response=await handler(frame.envelope,frame.capability);ws.send(JSON.stringify({type:'response',envelope:response}));});
 async function encrypted(record,authorization){const requestId=randomUUID(),key=deriveKey(phone.privateKey,identity.publicKey,id,requestId),e={...encryptPayload(key,id,requestId,{timestamp:Date.now(),method:'GET',path:'/v1/health',headers:authorization?{Authorization:'Bearer '+authorization}:{},body:''},'request'),epk:phone.publicKey};const result=await routed(id,{bearer:record.token},e);assert.equal(result.status,200);return decryptPayload(key,id,await result.json(),'response');}
 assert.equal((await encrypted(boot,paired.token)).status,403);assert.equal((await encrypted(record,'wrong-control')).status,403);assert.equal(forwarded,0);
 const result=await encrypted(record,paired.token);assert.equal(result.status,200);assert.equal(Buffer.from(result.body,'base64url').toString(),'synthetic-private');assert.equal(forwarded,1);
});
test('edge IP rejection happens before any D1 or unknown-object allocation',async()=>{
 const env={EDGE_RELAY_LIMIT:{limit:async()=>({success:false})},RELAY:{getByName(){throw Error('Must not allocate object');}},DB:{prepare(){throw Error('Must not touch D1');}}};
 const response=await handleRelay(new Request(`${origin}/v1/relay/${randomUUID()}/rpc`,{method:'POST',body:'{}'}),env);assert.equal(response.status,429);
});
test('durable revocation alarm reconciles a failed D1 mirror without another DELETE',async()=>{
 const id=await laptop();await db.prepare('UPDATE laptops SET owner_email=? WHERE id=?').bind('owner@example.com',id).run();const ws=await socket(id),cap=await capability(ws);
 await db.prepare("CREATE TRIGGER fail_revocation BEFORE UPDATE OF revoked_at ON laptops BEGIN SELECT RAISE(ABORT,'synthetic mirror failure'); END").run();
 try{const r=await mf.dispatchFetch(`${origin}/v1/devices/${id}`,{method:'DELETE',headers:{Authorization:'Bearer account'}});assert.equal(r.status,503);assert.equal((await routed(id,cap)).status,404);assert.equal((await db.prepare('SELECT revoked_at FROM laptops WHERE id=?').bind(id).first()).revoked_at,null);}finally{await db.prepare('DROP TRIGGER fail_revocation').run();}
 let value;for(let i=0;i<40;i++){value=await db.prepare('SELECT revoked_at FROM laptops WHERE id=?').bind(id).first();if(value.revoked_at!==null)break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.ok(value.revoked_at>0);assert.equal((await routed(id,cap)).status,404);
});
test('laptop reconnect budget persists without disconnecting the last accepted socket',async()=>{
 if(Date.now()%60000>52000)await new Promise(resolve=>setTimeout(resolve,60010-Date.now()%60000));
 const id=await laptop();let ws;for(let i=0;i<60;i++)ws=await socket(id);
 assert.equal((await connect(id)).status,429);
 const cap=await capability(ws),frame=next(ws),pending=routed(id,cap);reply(ws,(await frame).envelope);assert.equal((await pending).status,200);
});
test('slow bootstrap uploads reserve shared reading capacity while paired phones remain usable',async()=>{
 const id=await laptop(),ws=await socket(id),caps=[];
 for(let i=0;i<3;i++)caps.push(await capability(ws,'bootstrap',Math.floor(Date.now()/1000)+600));
 const phone=await capability(ws);ws.addEventListener('message',event=>{const frame=JSON.parse(event.data);if(frame.type==='request')reply(ws,frame.envelope);});
 const controllers=[],pending=[];
 for(const cap of caps.slice(0,2)){
  const body=new ReadableStream({start(controller){controllers.push(controller);controller.enqueue(new TextEncoder().encode('{'));}});
  pending.push(mf.dispatchFetch(`${origin}/v1/relay/${id}/rpc`,{method:'POST',headers:{Authorization:'Bearer '+cap.bearer},body,duplex:'half'}));
 }
 await new Promise(resolve=>setTimeout(resolve,150));
 assert.equal((await routed(id,caps[2])).status,429);assert.equal((await routed(id,phone)).status,200);
 for(const controller of controllers){controller.enqueue(new TextEncoder().encode('}'));controller.close();}
 assert.deepEqual((await Promise.all(pending)).map(r=>r.status),[400,400]);
 assert.equal((await routed(id,caps[2])).status,200);
});
test('expired stalled uploads release bootstrap capacity without dispatch',async()=>{
 const id=await laptop(),ws=await socket(id),expires=Math.floor(Date.now()/1000)+3;
 const first=await capability(ws,'bootstrap',expires),second=await capability(ws,'bootstrap',expires),fresh=await capability(ws,'bootstrap',Math.floor(Date.now()/1000)+600);
 const controllers=[],pending=[];let forwarded=0;
 ws.addEventListener('message',event=>{const frame=JSON.parse(event.data);if(frame.type==='request'){forwarded++;reply(ws,frame.envelope);}});
 for(const cap of [first,second]){
  const body=new ReadableStream({start(controller){controllers.push(controller);controller.enqueue(new TextEncoder().encode('{'));}});
  pending.push(mf.dispatchFetch(`${origin}/v1/relay/${id}/rpc`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+cap.bearer},body,duplex:'half'}));
 }
 try{
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal((await routed(id,fresh)).status,429);
  const responses=await Promise.race([Promise.all(pending),new Promise((_,reject)=>setTimeout(()=>reject(Error('stalled uploads retained capacity after authorization expiry')),5000))]);
  assert.deepEqual(responses.map(response=>response.status),[401,401]);
  assert.equal((await routed(id,fresh)).status,200);
  assert.equal(forwarded,1);
 }finally{for(const controller of controllers)try{controller.close();}catch{}}
});
test('revoking an open upload releases bootstrap capacity without dispatch',async()=>{
 const id=await laptop(),ws=await socket(id),caps=[];
 for(let i=0;i<4;i++)caps.push(await capability(ws,'bootstrap',Math.floor(Date.now()/1000)+600));
 let forwarded=0;ws.addEventListener('message',event=>{const frame=JSON.parse(event.data);if(frame.type==='request'){forwarded++;reply(ws,frame.envelope);}});
 const controllers=[],pending=caps.slice(0,2).map(cap=>{
  const body=new ReadableStream({start(controller){controllers.push(controller);controller.enqueue(new TextEncoder().encode('{'));}});
  const result=mf.dispatchFetch(`${origin}/v1/relay/${id}/rpc`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+cap.bearer},body,duplex:'half'});
  result.catch(()=>{});return result;
 });
 try{
  let busy=false;
  for(let attempt=0;attempt<8;attempt++){
   const probe=await mf.dispatchFetch(`${origin}/v1/relay/${id}/rpc`,{method:'POST',headers:{'Content-Type':'text/plain',Authorization:'Bearer '+caps[2].bearer},body:'{}'});
   const {error}=await probe.json();
   if(probe.status===429){assert.equal(error.code,'relay_busy');busy=true;break;}
   assert.equal(probe.status,400);assert.equal(error.code,'invalid_envelope');
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(busy,true,'stalled uploads did not reserve both reading slots');
  assert.equal(forwarded,0);
  assert.equal((await control(ws,{id:caps[0].id},'revoke')).ok,true);
  const revoked=await Promise.race([pending[0],new Promise((_,reject)=>setTimeout(()=>reject(Error('revoked upload stayed open')),2000))]);
  assert.equal(revoked.status,401);assert.equal(forwarded,0);
  assert.equal((await routed(id,caps[0])).status,401);
  assert.equal((await routed(id,caps[3])).status,200);assert.equal(forwarded,1);
  assert.equal((await control(ws,{id:caps[1].id},'revoke')).ok,true);
  const second=await Promise.race([pending[1],new Promise((_,reject)=>setTimeout(()=>reject(Error('second revoked upload stayed open')),2000))]);
  assert.equal(second.status,401);
 }finally{for(const controller of controllers)try{controller.close();}catch{}}
});
test('revoking a laptop ends an open upload before it can reach the laptop',async()=>{
 const id=await laptop();await db.prepare('UPDATE laptops SET owner_email=? WHERE id=?').bind('owner@example.com',id).run();
 const accountToken=randomUUID();await db.prepare('INSERT INTO sessions(token_hash,id,request_hash,email,expires_at) VALUES (?,?,?,?,?)').bind(hash(accountToken),randomUUID(),randomUUID(),'owner@example.com',Math.floor(Date.now()/1000)+600).run();
 const ws=await socket(id),cap=await capability(ws);let controller,forwarded=0;
 ws.addEventListener('message',event=>{if(JSON.parse(event.data).type==='request')forwarded++;});
 const body=new ReadableStream({start(value){controller=value;controller.enqueue(new TextEncoder().encode('{'));}});
 const pending=mf.dispatchFetch(`${origin}/v1/relay/${id}/rpc`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+cap.bearer},body,duplex:'half'})
  .then(response=>response.status,error=>{assert.equal(error.message,'fetch failed');return 'transport_closed';});
 try{
  await new Promise(resolve=>setTimeout(resolve,100));
  const revoked=await mf.dispatchFetch(`${origin}/v1/devices/${id}`,{method:'DELETE',headers:{Authorization:'Bearer '+accountToken}});
  assert.equal(revoked.status,200);
  const result=await Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(Error('revoked laptop upload stayed open')),2000))]);
  assert.ok(result===404||result==='transport_closed');assert.equal(forwarded,0);
  assert.equal((await routed(id,cap)).status,404);
 }finally{try{controller.close();}catch{}}
});
test('aborting stalled bootstrap uploads releases their shared reading capacity',async()=>{
 const id=await laptop(),ws=await socket(id),caps=[];
 for(let i=0;i<3;i++)caps.push(await capability(ws,'bootstrap',Math.floor(Date.now()/1000)+600));
 ws.addEventListener('message',event=>{const frame=JSON.parse(event.data);if(frame.type==='request')reply(ws,frame.envelope);});
 const controllers=[],aborts=[],pending=[];
 for(const cap of caps.slice(0,2)){
  const body=new ReadableStream({start(controller){controllers.push(controller);controller.enqueue(new TextEncoder().encode('{'));}});
  const abort=new AbortController();aborts.push(abort);
  pending.push(mf.dispatchFetch(`${origin}/v1/relay/${id}/rpc`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+cap.bearer},body,duplex:'half',signal:abort.signal}));
 }
 try{
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal((await routed(id,caps[2])).status,429);
  for(const abort of aborts)abort.abort();
  const responses=await Promise.race([Promise.allSettled(pending),new Promise((_,reject)=>setTimeout(()=>reject(Error('aborted uploads retained capacity')),2000))]);
  assert.ok(responses.every(result=>result.status==='rejected'||result.value.status===499));
  assert.equal((await routed(id,caps[2])).status,200);
 }finally{for(const controller of controllers)try{controller.close();}catch{}}
});
test('a stalled phone upload times out before dispatch and frees its reading slot',async()=>{
 const id=await laptop(),ws=await socket(id),cap=await capability(ws),controllers=[],pending=[];let forwarded=0;
 ws.addEventListener('message',event=>{const frame=JSON.parse(event.data);if(frame.type==='request'){forwarded++;reply(ws,frame.envelope);}});
 for(let i=0;i<8;i++){
  const body=new ReadableStream({start(controller){controllers.push(controller);controller.enqueue(new TextEncoder().encode('{'));}});
  pending.push(mf.dispatchFetch(`${origin}/v1/relay/${id}/rpc`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+cap.bearer},body,duplex:'half'}));
 }
 try{
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.equal((await routed(id,cap)).status,429);
  const responses=await Promise.race([Promise.all(pending),new Promise((_,reject)=>setTimeout(()=>reject(Error('upload deadline did not release capacity')),19000))]);
  assert.deepEqual(responses.map(response=>response.status),Array(8).fill(408));
  assert.equal((await routed(id,cap)).status,200);assert.equal(forwarded,1);
 }finally{for(const controller of controllers)try{controller.close();}catch{}}
});
test('local synthetic 1/10/100 independent clients measure opaque round-trip budgets',async t=>{
 for(const clients of [1,10,100]){
  const group=[];
  for(let i=0;i<clients;i++){const id=await laptop(),ws=await socket(id),cap=await capability(ws);ws.addEventListener('message',event=>{const frame=JSON.parse(event.data);if(frame.type==='request')reply(ws,frame.envelope);});group.push({id,ws,cap});}
  await db.prepare('ALTER TABLE laptops RENAME TO benchmark_laptops').run();await db.prepare('ALTER TABLE rate_limits RENAME TO benchmark_limits').run();
  let results;const started=performance.now();
  try{results=await Promise.all(group.map(async({id,cap})=>{const start=performance.now();const r=await routed(id,cap);const bytes=(await r.arrayBuffer()).byteLength;return {status:r.status,bytes,ms:performance.now()-start};}));}
  finally{await db.prepare('ALTER TABLE benchmark_laptops RENAME TO laptops').run();await db.prepare('ALTER TABLE benchmark_limits RENAME TO rate_limits').run();}
  assert.equal(results.filter(r=>r.status===200).length,clients);
  const times=results.map(r=>r.ms).sort((a,b)=>a-b);
  t.diagnostic(JSON.stringify({clients,requests:clients,responses:clients,rejected:0,responseBytes:results.reduce((n,r)=>n+r.bytes,0),p50Ms:Math.round(times[Math.floor(times.length*.5)]),p95Ms:Math.round(times[Math.min(times.length-1,Math.floor(times.length*.95))]),elapsedMs:Math.round(performance.now()-started),routineD1Statements:0}));
  for(const {ws} of group)ws.close();
 }
});

// Opt in separately from the regression suite: HERDR_RELAY_LOAD_DURATION_MS=180000
// node --test --test-name-pattern='bounded sustained' test/relay.test.js
// These synthetic envelopes exercise routing and budgets, not cryptographic clients.
test('bounded sustained strict-capability relay traffic preserves isolation across reconnect', {skip:!process.env.HERDR_RELAY_LOAD_DURATION_MS,timeout:660000}, async t=>{
 const duration=Number(process.env.HERDR_RELAY_LOAD_DURATION_MS);
 assert.ok(Number.isInteger(duration)&&duration>=4000&&duration<=600000,'load duration must be 4–600 seconds to exercise the midpoint reconnect');
 const clients=100,interval=2000,group=[],latencies=[],statuses={};
 let requests=0,responseBytes=0,errors=0,forwarded=0,isolationErrors=0,reconnected=false,rounds=0;
 const respond=client=>client.ws.addEventListener('message',event=>{
  const frame=JSON.parse(event.data);if(frame.type!=='request')return;
  forwarded++;
  if(frame.capability?.id!==client.cap.id||!frame.envelope.data.startsWith(client.prefix))isolationErrors++;
  reply(client.ws,frame.envelope);
 });
 try{
  for(let i=0;i<clients;i++){
   const id=await laptop();await db.prepare('UPDATE laptops SET relay_auth_version=1 WHERE id=?').bind(id).run();
   const ws=await socket(id),cap=await capability(ws),prefix=Buffer.from(`synthetic-client-${i}:`).toString('base64url');
   const client={id,ws,cap,prefix,size:[2048,32768,65536][i%3]};respond(client);group.push(client);
  }
  // Another laptop's valid capability must fail before any envelope forwarding.
  assert.equal((await routed(group[0].id,group[1].cap)).status,401);
  const started=performance.now();let nextReport=60000;
  while(performance.now()-started<duration){
   const roundStart=performance.now();
   if(!reconnected&&roundStart-started>=duration/2){
    const client=group[0];client.ws.close(1000,'bounded load reconnect');client.ws=await socket(client.id);respond(client);reconnected=true;
   }
   await Promise.all(group.map(async client=>{
    const e={...envelope(),data:client.prefix+'b'.repeat(client.size-client.prefix.length)},start=performance.now();requests++;
    try{
     const response=await routed(client.id,client.cap,e),bytes=await response.arrayBuffer();
     statuses[response.status]=(statuses[response.status]||0)+1;responseBytes+=bytes.byteLength;latencies.push(performance.now()-start);
     if(response.status!==200){errors++;return;}
     const result=JSON.parse(Buffer.from(bytes).toString());
     if(result.id!==e.id||result.iv!==e.iv||result.data!==e.data){isolationErrors++;errors++;}
    }catch{errors++;}
   }));
   rounds++;
   if(performance.now()-started>=nextReport){t.diagnostic(JSON.stringify({phase:'progress',elapsedMs:Math.round(performance.now()-started),requests,errors,isolationErrors,reconnected}));nextReport+=60000;}
   const remaining=duration-(performance.now()-started),pause=Math.min(interval-(performance.now()-roundStart),remaining);
   if(pause>0)await new Promise(resolve=>setTimeout(resolve,pause));
  }
  const sorted=latencies.sort((a,b)=>a-b),percentile=p=>Math.round(sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]||0);
  t.diagnostic(JSON.stringify({phase:'complete',environment:'local Miniflare/workerd',clients,durationRequestedMs:duration,elapsedMs:Math.round(performance.now()-started),intervalMs:interval,rounds,requests,statuses,errors,forwarded,isolationErrors,reconnected,responseBytes,p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),envelopeDataBytes:[2048,32768,65536]}));
  assert.equal(errors,0);assert.equal(isolationErrors,0);assert.equal(statuses[200],requests);assert.equal(forwarded,requests);assert.equal(reconnected,true);
 }finally{for(const client of group)try{client.ws.close(1000,'bounded load completed');}catch{}}
});
