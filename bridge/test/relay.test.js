import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {generateIdentity,deriveKey,encryptPayload,decryptPayload,createRelayHandler} from '../src/relay.js';
import {createTransfers} from '../src/relay-transfers.js';
import {Store} from '../src/store.js';
import {setDeviceMode,setRemoteEnabled} from '../src/access.js';
import {routingCapabilities} from '../src/routing-capabilities.js';
const laptop={...generateIdentity(),id:'laptop-test',claimToken:'private-claim'},phone=generateIdentity();
function request(value={method:'GET',path:'/v1/health',headers:{authorization:'Bearer secret'},body:'',timestamp:Date.now()}){const id=randomUUID(),key=deriveKey(phone.privateKey,laptop.publicKey,laptop.id,id);return {key,envelope:{...encryptPayload(key,laptop.id,id,value,'request'),epk:phone.publicKey}};}
test('encrypted loopback round trip, auth preserved and pair claim encrypted',async t=>{
 const server=http.createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer secret');res.setHeader('content-type','application/json');res.end(req.url==='/v1/pair'?JSON.stringify({token:'paired'}):JSON.stringify({ok:true}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const handle=createRelayHandler({identity:laptop,port:server.address().port});
 for(const path of ['/v1/health','/v1/pair']){const {key,envelope}=request({method:'POST',path,headers:{authorization:'Bearer secret'},body:'',timestamp:Date.now()});const out=await handle(envelope),value=decryptPayload(key,laptop.id,out,'response');assert.equal(value.status,200);const body=JSON.parse(Buffer.from(value.body,'base64url'));if(path==='/v1/pair')assert.equal(body.claimToken,'private-claim');else assert.equal(body.ok,true);await assert.rejects(handle(envelope),/replayed/);}
});
test('tamper, wrong key and expiry rejected without forwarding',async()=>{
 let calls=0;const handle=createRelayHandler({identity:laptop,port:1234,fetchImpl:()=>{calls++;throw Error();}});
 const a=request();a.envelope.data=(a.envelope.data[0]==='A'?'B':'A')+a.envelope.data.slice(1);await assert.rejects(handle(a.envelope));
 const b=request();b.envelope.epk=generateIdentity().publicKey;await assert.rejects(handle(b.envelope));
 const c=request({timestamp:Date.now()-120001});await assert.rejects(handle(c.envelope),/expired/);assert.equal(calls,0);
});
test('local failure and invalid host produce authenticated bounded errors',async()=>{
 const handle=createRelayHandler({identity:laptop,port:1234,fetchImpl:()=>{throw Error('private diagnostic');}});
 for(const [path,status] of [['/v1/health',502],['//evil.test/v1/pair',400],['/v1/../../secret',400]]){const a=request({method:'GET',path,timestamp:Date.now()});const out=decryptPayload(a.key,laptop.id,await handle(a.envelope),'response');assert.equal(out.status,status);assert.doesNotMatch(Buffer.from(out.body,'base64url').toString(),/private diagnostic/);}
});
test('transfers require device ownership, contiguous chunks, bounded size and expiry',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new Store(dir),first=store.pair(store.pairCode(),'phone'),second=store.pair(store.pairCode(),'other');let now=1000,uploaded;
 const transfers=createTransfers({store,port:1234,now:()=>now,fetchImpl:async(_url,options)=>{const chunks=[];for await(const bytes of options.body)chunks.push(bytes);uploaded=Buffer.concat(chunks);return new Response('{"id":"done"}');}});t.after(()=>transfers.close());
 const call=(method,path,body={},token=first.token)=>transfers.handle({method,path,headers:{authorization:`Bearer ${token}`},body:method==='GET'?Buffer.alloc(0):Buffer.from(JSON.stringify(body))});
 assert.equal((await call('POST','/v1/relay-transfer/upload',{paneId:'1',name:'test',size:21*1024*1024})).status,400);
 const created=await call('POST','/v1/relay-transfer/upload',{paneId:'1',name:'test',size:3}),id=JSON.parse(created.bytes).transferId,p=`/v1/relay-transfer/upload/${id}`;
 assert.equal((await call('POST',p,{offset:0,data:'YWJj'},second.token)).status,404);
 assert.equal((await call('POST',p,{offset:1,data:'YWJj'})).status,400);
 assert.equal((await call('POST',p,{offset:0,data:'YWJj'})).status,200);
 assert.equal((await call('POST',p+'/finish')).status,200);assert.equal(uploaded.toString(),'abc');
 const next=JSON.parse((await call('POST','/v1/relay-transfer/upload',{paneId:'1',name:'test',size:3})).bytes).transferId;now+=300001;assert.equal((await call('DELETE',`/v1/relay-transfer/upload/${next}`)).status,404);
});

test('observer devices cannot stage relay uploads',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-observer-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir),paired=store.pair(store.pairCode(),'phone');
 const transfers=createTransfers({store,port:1234});t.after(()=>transfers.close());
 setDeviceMode(store,paired.deviceId,'observer');
 for(const route of ['/v1/relay-transfer/upload','/v1/relay-transfer/download/../upload','/v1/relay-transfer/download/%2e%2e/upload']){
  const response=await transfers.handle({method:'POST',path:route,headers:{authorization:`Bearer ${paired.token}`},body:Buffer.from(JSON.stringify({paneId:'test',name:'file.txt',size:1}))});
  assert.equal(response.status,403,route);
 }
});

test('cached relay downloads and capability rotation honor the laptop disable switch',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-access-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir),paired=store.pair(store.pairCode(),'phone'),routing=routingCapabilities(store);
 const transfers=createTransfers({store,port:1234,fetchImpl:async()=>new Response('sample')});t.after(()=>transfers.close());
 const call=(method,path,body={})=>transfers.handle({method,path,headers:{authorization:`Bearer ${paired.token}`},body:Buffer.from(JSON.stringify(body))});
 setDeviceMode(store,paired.deviceId,'observer');
 const download=await call('POST','/v1/relay-transfer/download',{path:'/v1/attachments/sample/content'});
 assert.equal(download.status,200);
 const transferId=JSON.parse(download.bytes).transferId;
 const capability=routing.create('phone',{deviceId:paired.deviceId});
 const auth={authorization:`Bearer ${paired.token}`};
 assert.equal(routing.check({id:capability.capability.id,kind:'phone'},{method:'GET',path:'/v1/health',headers:auth}),true);
 setRemoteEnabled(store,false);
 assert.equal((await call('GET',`/v1/relay-transfer/download/${transferId}?offset=0`)).status,403);
 assert.equal((await call('DELETE',`/v1/relay-transfer/download/${transferId}`)).status,403);
 assert.equal((await call('POST','/v1/relay-transfer/download',{path:'/v1/attachments/sample/content'})).status,403);
 assert.equal(routing.check({id:capability.capability.id,kind:'phone'},{method:'GET',path:'/v1/health',headers:auth}),false);
 const encrypted=request({method:'POST',path:'/v1/relay-capability/rotate',headers:auth,body:'',timestamp:Date.now()});
 const response=decryptPayload(encrypted.key,laptop.id,await createRelayHandler({identity:laptop,port:1234,store,routing})(encrypted.envelope,{id:capability.capability.id,kind:'phone'}),'response');
 assert.equal(response.status,403);
});

test('relay reconnects with fresh socket and never replays requests',async t=>{
 const {EventEmitter}=await import('node:events');const {startRelay}=await import('../src/relay.js');
 class Socket extends EventEmitter{static sockets=[];constructor(){super();this.readyState=1;this.bufferedAmount=0;this.sent=[];Socket.sockets.push(this);}send(value){this.sent.push(value);}ping(){}terminate(){this.readyState=3;this.emit('close');}}
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-reconnect-'));t.after(()=>fs.rmSync(stateDir,{recursive:true,force:true}));
 const states=[],relay=startRelay({identity:{...laptop,url:'https://relay.example',relayToken:'secret'},port:1234,store:new Store(stateDir),WebSocketImpl:Socket,onStatus:v=>states.push(v)});t.after(()=>relay.stop());
 Socket.sockets[0].emit('open');assert.equal(states.at(-1),true);Socket.sockets[0].emit('close');await new Promise(r=>setTimeout(r,1100));assert.equal(Socket.sockets.length,2);assert.equal(Socket.sockets[1].sent.length,0);relay.stop();const count=Socket.sockets.length;await new Promise(r=>setTimeout(r,1100));assert.equal(Socket.sockets.length,count);
});

test('socket discovery detects one live session and refuses ambiguous sessions',async t=>{
 const net=await import('node:net');const {detectHerdrSocket}=await import('../src/companion.js');const home=fs.mkdtempSync(path.join(os.tmpdir(),'companion-test-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const socket=path.join(home,'.config/herdr/sessions/one/herdr.sock');fs.mkdirSync(path.dirname(socket),{recursive:true});const server=net.createServer(c=>c.end());await new Promise(r=>server.listen(socket,r));t.after(()=>server.close());assert.equal(await detectHerdrSocket({home}),socket);
 const other=path.join(home,'.config/herdr/herdr.sock'),second=net.createServer(c=>c.end());await new Promise(r=>second.listen(other,r));t.after(()=>second.close());await assert.rejects(detectHerdrSocket({home}),/Several/);assert.equal(await detectHerdrSocket({home,explicit:socket}),socket);
});


test('replay IDs survive companion restart',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new Store(dir),options={identity:laptop,port:1234,store,fetchImpl:async()=>new Response('{}')},a=request();await createRelayHandler(options)(a.envelope);await assert.rejects(createRelayHandler(options)(a.envelope),/replayed/);
});

test('download chunks retain headers and reconstruct attachments and project files privately',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'download-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new Store(dir),device=store.pair(store.pairCode(),'phone');const source=Buffer.alloc(200000,153),forwarded=[];
 const transfers=createTransfers({store,port:1234,fetchImpl:async(url,options)=>{forwarded.push(url);assert.equal(options.headers.authorization,`Bearer ${device.token}`);return new Response(source,{headers:{'content-type':'application/octet-stream','content-disposition':'attachment; filename="sample.bin"'}});}});t.after(()=>transfers.close());
 const call=(method,path,body)=>transfers.handle({method,path,headers:{authorization:`Bearer ${device.token}`},body:body?Buffer.from(JSON.stringify(body)):Buffer.alloc(0)});
 const artifact='project-'+'a'.repeat(64);
 for(const path of ['http://evil.test','//evil.test/v1/attachments/sample/content',`/v1/panes/w1:p2/artifacts/${artifact}?extra=1`,`/v1/panes/w1:p2/artifacts/${artifact}/../secret`])assert.equal((await call('POST','/v1/relay-transfer/download',{path})).status,400);
 assert.deepEqual(forwarded,[]);
 // Android's HttpUrl leaves colons in path segments; other clients escape them.
 for(const path of ['/v1/attachments/sample/content',`/v1/panes/w1:p2/artifacts/${artifact}`,`/v1/panes/w1%3Ap2/artifacts/${artifact}`]){
  const result=await call('POST','/v1/relay-transfer/download',{path});assert.equal(result.status,200,path);
  const created=JSON.parse(result.bytes);assert.equal(created.size,200000);assert.equal(created.headers['content-type'],'application/octet-stream');assert.equal(forwarded.at(-1),'http://127.0.0.1:1234'+path);
  const base=`/v1/relay-transfer/download/${created.transferId}`;const a=JSON.parse((await call('GET',base+'?offset=0')).bytes),b=JSON.parse((await call('GET',base+'?offset=131072')).bytes);assert.equal(a.eof,false);assert.equal(b.eof,true);assert.deepEqual(Buffer.concat([Buffer.from(a.data,'base64url'),Buffer.from(b.data,'base64url')]),source);assert.equal((await call('DELETE',base)).status,200);assert.equal((await call('GET',base+'?offset=0')).status,404);
 }
});
test('capability WebSocket control acknowledges bootstrap and paired phone before encrypted success',async t=>{
 const {EventEmitter}=await import('node:events'),{startRelay}=await import('../src/relay.js'),{routingCapabilities}=await import('../src/routing-capabilities.js');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-control-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new Store(dir),routing=routingCapabilities(store);const code=store.pairCode(),bootstrap=routing.create('bootstrap',{expires:Math.floor(Date.now()/1000)+60});
 const server=http.createServer(async(req,res)=>{assert.equal(req.headers['x-pairing-nonce'],undefined);let body='';for await(const chunk of req)body+=chunk;res.setHeader('content-type','application/json');if(req.url==='/v1/pair'){const value=JSON.parse(body);res.end(JSON.stringify(store.pair(value.code,value.deviceName)));}else{res.end('{"ok":true}');}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 let socket;const replies=[],registered=[];
 class Socket extends EventEmitter{constructor(){super();socket=this;this.readyState=1;this.bufferedAmount=0;}send(raw){const msg=JSON.parse(raw);if(msg.type==='capability'){registered.push(msg);queueMicrotask(()=>this.emit('message',Buffer.from(JSON.stringify({type:'capability-ack',id:msg.id,ok:true}))));}else replies.push(msg);}ping(){}terminate(){this.readyState=3;this.emit('close');}}
 const relay=startRelay({identity:{...laptop,url:'https://relay.example',relayToken:'test'},port:server.address().port,store,WebSocketImpl:Socket});t.after(()=>relay.stop());socket.emit('open');await routing.acknowledged(bootstrap.capability.id);
 const a=request({method:'POST',path:'/v1/pair',headers:{'content-type':'application/json','X-Pairing-Nonce':'N'.repeat(43)},body:Buffer.from(JSON.stringify({code,deviceName:'synthetic'})).toString('base64url'),timestamp:Date.now()});socket.emit('message',Buffer.from(JSON.stringify({type:'request',capability:{id:bootstrap.capability.id,kind:'bootstrap'},envelope:a.envelope})));
 const deadline=Date.now()+3000;while(!replies.length&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert.equal(replies.length,1);const response=decryptPayload(a.key,laptop.id,replies[0].envelope,'response');assert.equal(response.status,200);const paired=JSON.parse(Buffer.from(response.body,'base64url'));assert.match(paired.routingToken,/^[A-Za-z0-9_-]{43}$/);assert.equal(paired.routingExpires,0);const phone=routing.records().find(r=>r.deviceId===paired.deviceId);assert.ok(registered.some(r=>r.capability.id===phone.capability.id));assert.equal(store.authenticate(paired.token).deviceId,paired.deviceId);
 const blocked=request({method:'GET',path:'/v1/health',headers:{authorization:`Bearer ${paired.token}`},timestamp:Date.now()});socket.emit('message',Buffer.from(JSON.stringify({type:'request',capability:{id:bootstrap.capability.id,kind:'bootstrap'},envelope:blocked.envelope})));while(replies.length<2&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert.equal(decryptPayload(blocked.key,laptop.id,replies[1].envelope,'response').status,403);
});
