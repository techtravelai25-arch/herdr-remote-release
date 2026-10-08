import {test,before} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createHash,randomUUID} from 'node:crypto';

// Runs the Durable Object class in Node with an instrumented storage fake, so
// storage writes per RPC and per WebSocket frame can be counted exactly.
let Relay;
before(async()=>{
 const shim={name:'cloudflare-workers-shim',setup(b){
  b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cloudflare:workers',namespace:'shim'}));
  b.onLoad({filter:/.*/,namespace:'shim'},()=>({contents:'export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}',loader:'js'}));
 }};
 const result=await build({entryPoints:[new URL('../src/relay-object.js',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node',external:['node:*'],plugins:[shim]});
 ({Relay}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64')));
});
const sha=value=>createHash('sha256').update(value).digest('hex');
const envelope=()=>({v:1,id:randomUUID(),iv:'a'.repeat(16),data:'b'.repeat(30),epk:'c'.repeat(122)});
function storage(initial={}){
 const data=new Map(Object.entries(initial).map(([k,v])=>[k,structuredClone(v)]));const writes=[];
 const put=(key,value)=>{const entries=typeof key==='object'?Object.entries(key):[[key,value]];for(const [k,v] of entries){writes.push(k);data.set(k,structuredClone(v));}};
 return {data,writes,async get(key){return structuredClone(data.get(key));},async put(key,value){put(key,value);},async transaction(fn){await fn({put:async(k,v)=>put(k,v),setAlarm:async()=>{}});},async setAlarm(){}};
}
async function relay(store){
 const sockets=[];let ready;
 const ctx={storage:store,blockConcurrencyWhile(fn){ready=fn();return ready;},getWebSockets:()=>sockets,acceptWebSocket(){}};
 const object=new Relay(ctx,{LEGACY_RELAY_UNTIL:'0'});await ready;
 const socket={readyState:1,closed:null,sent:[],deserializeAttachment:()=>({generation:object.state.generation}),close(code){this.closed=code;this.readyState=3;},
  send(data){this.sent.push(data);const frame=JSON.parse(data);if(frame.type==='request')queueMicrotask(()=>object.webSocketMessage(socket,JSON.stringify({type:'response',envelope:{v:1,id:frame.envelope.id,iv:frame.envelope.iv,data:frame.envelope.data}})));}};
 sockets.push(socket);
 return {object,socket};
}
const persisted=bearer=>({state:{initialized:true,strict:true,revoked:false,generation:3,revocations:0,laptopId:randomUUID(),mirrorPending:false,mirrorAttempts:0,caps:{[randomUUID()]:{hash:sha(bearer),kind:'phone',expires:0}},
 budget:{bucket:Math.floor(Date.now()/60000),rpc:1800,connect:60,ws:2400,control:300,bytes:0,cap:{}}}});
const rpc=(object,bearer)=>object.fetch(new Request('https://relay.internal/rpc',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+bearer},body:JSON.stringify(envelope())}));

test('routine relay RPCs and WebSocket frames never write Durable Object storage',async()=>{
 const bearer='p'.repeat(43),store=storage(persisted(bearer)),{object,socket}=await relay(store);
 // Legacy persisted counters (here saturated) are ignored after a reload.
 assert.equal(object.state.budget,undefined);
 for(let i=0;i<50;i++)assert.equal((await rpc(object,bearer)).status,200);
 const e=envelope();for(let i=0;i<50;i++)await object.webSocketMessage(socket,JSON.stringify({type:'response',envelope:{v:1,id:e.id,iv:e.iv,data:e.data}}));
 assert.equal(socket.closed,null);assert.deepEqual(store.writes,[]);
});
test('capability state persists only on change and survives eviction without counters',async()=>{
 const bearer='q'.repeat(43),store=storage(persisted(bearer)),{object,socket}=await relay(store);
 const cap={id:randomUUID(),kind:'phone',tokenHash:sha('r'.repeat(43)),expires:0};
 const register=()=>object.webSocketMessage(socket,JSON.stringify({type:'capability',id:randomUUID(),action:'register',capability:cap}));
 await register();assert.deepEqual(store.writes,['state']);
 for(let i=0;i<5;i++)await register();assert.deepEqual(store.writes,['state']);
 assert.ok(socket.sent.every(frame=>JSON.parse(frame).ok===true));
 assert.equal('budget' in store.data.get('state'),false);
 const reloaded=await relay(store);
 assert.deepEqual(reloaded.object.state.caps[cap.id],{hash:cap.tokenHash,kind:'phone',expires:0});
 assert.equal(reloaded.object.state.generation,3);assert.equal(reloaded.object.counters.rpc,0);
 assert.equal((await rpc(reloaded.object,'r'.repeat(43))).status,200);
});
test('in-memory counters still enforce per-minute budgets',async()=>{
 const bearer='s'.repeat(43),store=storage(persisted(bearer)),{object,socket}=await relay(store);
 for(let i=0;i<300;i++)object.budget('control');
 await object.webSocketMessage(socket,JSON.stringify({type:'capability',id:randomUUID(),action:'register',capability:{id:randomUUID(),kind:'phone',tokenHash:sha('t'),expires:0}}));
 assert.equal(socket.closed,1008);
 for(let i=0;i<600;i++)object.budget('rpc',0,'cap');assert.equal(object.budget('rpc',0,'cap'),false);
 assert.deepEqual(store.writes,[]);
});
