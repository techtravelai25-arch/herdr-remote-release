import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {createBridge} from '../src/server.js';
import {Store} from '../src/store.js';
import {setRemoteEnabled,setDeviceMode} from '../src/access.js';
import {readJsonBody} from '../src/request-body.js';
import {generateKeyPair, exportJWK, SignJWT} from 'jose';
import {Herdr} from '../src/herdr.js';

async function fixture(t,options={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-remote-test-'));const calls=[];
 const p={pane_id:'w1Y:p1',terminal_id:'terminal-1',workspace_id:'w1Y',tab_id:'w1Y:t1',cwd:dir,revision:1,agent_status:'working',agent:'codex',name:'test-agent'};
 let recordCalls=true;
 const herdr={call:async(method,params)=>{if(recordCalls)calls.push({method,params});
  if(method==='session.snapshot')return {snapshot:{protocol:22,workspaces:[{workspace_id:'w1Y',label:'Project'}],panes:[p],agents:[p]}};
  if(method==='pane.get')return {pane:p};
  if(method==='agent.get')return {agent:p};
  if(method==='pane.read')return {read:{text:'hello\nworld',revision:1,truncated:false}};
  if(method==='workspace.create'||method==='tab.create')return {root_pane:{pane_id:'w1Y:p2'}};
  if(method==='agent.list')return {agents:[p]};
  return {type:'ok'};
 }};
 const config={socketPath:'/unused',stateDir:dir,projects:[{id:'project',label:'Project',path:dir}],...options};
 const app=createBridge(config,{herdr});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 const url=`http://127.0.0.1:${app.server.address().port}`;const code=app.store.pairCode();const credential=app.store.pair(code,'Test phone');
 const request=async(route,method='GET',body,token=credential.token)=>{
  if(method==='POST'&&token&&/\/(prompt|input|keys|stop)$/.test(route)&&body?.attachmentId===undefined) {
   recordCalls=false;
   try {const output=await fetch(url+route.replace(/\/(prompt|input|keys|stop)$/,'/output'),{headers:{Authorization:`Bearer ${token}`}});
    if(output.ok)body={...body,attachmentId:(await output.json()).attachmentId};}
   finally {recordCalls=true;}
  }
  return fetch(url+route,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 };
 t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {app,url,request,credential,calls,p,dir,herdr};
}
test('pairing is one-use, expires and persists only credential hashes',async t=>{
 const f=await fixture(t);const code=f.app.store.pairCode();
 let r=await f.request('/v1/pair','POST',{code,deviceName:'Phone'},'');assert.equal(r.status,200);const {token}=await r.json();assert.ok(token);
 r=await f.request('/v1/pair','POST',{code,deviceName:'Phone'},'');assert.equal(r.status,403);
 assert.ok(!fs.readFileSync(path.join(f.dir,'devices.json'),'utf8').includes(token));
 const next=f.app.store.pairCode();const pending=f.app.store.read('pairing.json');pending.expires=0;f.app.store.write('pairing.json',pending);
 assert.throws(()=>f.app.store.pair(next,'Phone'),/Generate/);
});
test('JSON body reader preserves UTF-8 characters split across stream chunks',async()=>{
 const expected={deviceName:'Phone 📱'};const bytes=Buffer.from(JSON.stringify(expected));
 const split=bytes.indexOf(Buffer.from('📱'))+1;
 const req={headers:{'content-type':'application/json'},async *[Symbol.asyncIterator](){yield bytes.subarray(0,split);yield bytes.subarray(split);}};
 assert.deepEqual(await readJsonBody(req),expected);
 req.headers['content-type']='application/jsonx';
 await assert.rejects(readJsonBody(req),error=>error.code==='content_type');
});
test('all inspection and control endpoints require valid credentials',async t=>{
 const f=await fixture(t);
 for(const endpoint of ['/v1/health','/v1/snapshot','/v1/panes/w1Y%3Ap1/output'])assert.equal((await f.request(endpoint,'GET',undefined,'bad')).status,401);
 assert.equal((await f.request('/v1/panes/w1Y%3Ap1/keys','POST',{keys:['enter']},'bad')).status,401);
 assert.equal(f.calls.length,0);
});
test('project browsing and file download remain authenticated and bound to the current pane',async t=>{
 const f=await fixture(t);fs.mkdirSync(path.join(f.dir,'source'));fs.writeFileSync(path.join(f.dir,'source','résumé example.py'),'print(42)');
 const route='/v1/panes/w1Y%3Ap1/files';
 assert.equal((await f.request(route,'GET',undefined,'bad')).status,401);
 assert.equal((await f.request(route+'?directory=../')).status,400);
 assert.equal((await f.request(route+'?directory=source&directory=source')).status,400);
 const listed=await (await f.request(route+'?directory=source')).json();
 assert.ok(listed.entries,JSON.stringify(listed));
 const download='/v1/panes/w1Y%3Ap1/artifacts/'+listed.entries[0].id;
 const downloaded=await f.request(download);
 assert.match(downloaded.headers.get('content-disposition'),/filename\*=UTF-8''r%C3%A9sum%C3%A9%20example.py/);
 assert.equal(await downloaded.text(),'print(42)');
 f.p.cwd=path.join(f.dir,'source');assert.equal((await f.request(download)).status,404);
});
test('encoded traversal and hostile filenames cannot turn project downloads into active content',async t=>{
 const f=await fixture(t);
 for(const directory of ['%2e%2e','%2e%2e%2f','%2fetc','%2eenv']){
   const response=await f.request('/v1/panes/w1Y%3Ap1/files?directory='+directory);
   assert.ok(response.status>=400,directory);
 }
 const html='<script>throw Error("executed")</script>';
 fs.writeFileSync(path.join(f.dir,'$(touch should-not-exist).html'),html);
 fs.writeFileSync(path.join(f.dir,'binary.bin'),Buffer.from([0,255,60,62]));
 const listing=await(await f.request('/v1/panes/w1Y%3Ap1/files')).json();
 const entry=listing.entries.find(item=>item.name.endsWith('.html'));
 assert.ok(entry);
 const response=await f.request('/v1/panes/w1Y%3Ap1/artifacts/'+entry.id);
 assert.equal(response.headers.get('content-type'),'application/octet-stream');
 assert.match(response.headers.get('content-disposition'),/^attachment;/);
 assert.equal(response.headers.get('x-content-type-options'),'nosniff');
 assert.equal(await response.text(),html);
 assert.equal(fs.existsSync(path.join(f.dir,'should-not-exist')),false);
 const binary=listing.entries.find(item=>item.name==='binary.bin');
 assert.deepEqual(Buffer.from(await(await f.request('/v1/panes/w1Y%3Ap1/artifacts/'+binary.id)).arrayBuffer()),Buffer.from([0,255,60,62]));
});
test('revocation takes effect on next request',async t=>{const f=await fixture(t);f.app.store.revoke(f.credential.deviceId);assert.equal((await f.request('/v1/snapshot')).status,401);});
test('observer cannot mutate sessions, prompts, answers, attachments or Herdr',async t=>{
 const f=await fixture(t,{allowHerdrStart:true,allowTerminalInput:true});
 setDeviceMode(f.app.store,f.credential.deviceId,'observer');
 const snapshot=await(await f.request('/v1/snapshot')).json();
 assert.equal(snapshot.permissionMode,'observer');assert.equal(snapshot.canControl,false);assert.equal(snapshot.allowTerminalInput,false);assert.equal(snapshot.canStartHerdr,false);assert.equal(snapshot.terminalCreationEnabled,false);
 const ws=new WebSocket(f.url.replace('http','ws')+'/v1/events',{headers:{Authorization:`Bearer ${f.credential.token}`}});
 const [event]=await once(ws,'message');assert.equal(JSON.parse(event).data.permissionMode,'observer');ws.close();
 const routes=[['/v1/agents','POST',{}],['/v1/herdr/start','POST',{}],['/v1/panes/w1Y%3Ap1/prompt','POST',{text:'hi'}],['/v1/panes/w1Y%3Ap1/answer','POST',{}],['/v1/panes/w1Y%3Ap1/keys','POST',{keys:['enter']}],['/v1/panes/w1Y%3Ap1/restart','POST',{}],['/v1/panes/w1Y%3Ap1','DELETE'],['/v1/panes/w1Y%3Ap1/attachments','POST',{}]];
 for(const [route,method,body] of routes){const r=await f.request(route,method,body);assert.equal(r.status,403,route);assert.equal((await r.json()).error.code,'permission_denied');}
 assert.equal(f.calls.filter(c=>c.method!=='session.snapshot').length,0);
});
test('terminal input needs per-device grant and local enablement',async t=>{
 const f=await fixture(t,{allowTerminalInput:true});f.p.agent=null;
 const route='/v1/panes/w1Y%3Ap1/keys';
 assert.equal((await f.request(route,'POST',{keys:['enter']})).status,403);
 setDeviceMode(f.app.store,f.credential.deviceId,'terminal');
 assert.equal((await(await f.request('/v1/snapshot')).json()).allowTerminalInput,true);
 assert.equal((await f.request(route,'POST',{keys:['enter']})).status,200);
 assert.equal(f.calls.filter(c=>c.method==='pane.send_keys').length,1);
});
test('laptop disable blocks pairing and all existing credentials, including open sockets',async t=>{
 const f=await fixture(t);const ws=new WebSocket(f.url.replace('http','ws')+'/v1/events',{headers:{Authorization:`Bearer ${f.credential.token}`}});
 await once(ws,'message');const closed=once(ws,'close');
 setRemoteEnabled(f.app.store,false);
 assert.equal((await f.request('/v1/snapshot')).status,403);
 const code=f.app.store.pairCode();assert.equal((await f.request('/v1/pair','POST',{code,deviceName:'Other'},'')).status,403);
 await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(Error('socket was not revoked')),3000))]);
 setRemoteEnabled(f.app.store,true);
 assert.equal((await f.request('/v1/snapshot')).status,200);
});
test('mode changes refresh an open event connection without a Herdr change',async t=>{
 const f=await fixture(t);const ws=new WebSocket(f.url.replace('http','ws')+'/v1/events',{headers:{Authorization:`Bearer ${f.credential.token}`}});
 const [first]=await once(ws,'message');assert.equal(JSON.parse(first).data.permissionMode,'normal');
 const changed=once(ws,'message');setDeviceMode(f.app.store,f.credential.deviceId,'observer');
 const [message]=await Promise.race([changed,new Promise((_,reject)=>setTimeout(()=>reject(Error('mode change was not published')),3000))]);
 assert.equal(JSON.parse(message).data.permissionMode,'observer');assert.equal(JSON.parse(message).data.canControl,false);
 ws.close();
});
test('local device revocation closes an idle event connection',async t=>{
 const f=await fixture(t);const ws=new WebSocket(f.url.replace('http','ws')+'/v1/events',{headers:{Authorization:`Bearer ${f.credential.token}`}});
 await once(ws,'message');const closed=once(ws,'close');f.app.store.revoke(f.credential.deviceId);
 await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(Error('revoked socket stayed open')),3000))]);
 assert.equal((await f.request('/v1/snapshot')).status,401);
});
test('project downloads cap growing files and handle empty files',async t=>{
 const f=await fixture(t),file=path.join(f.dir,'growing.txt');
 fs.writeFileSync(file,'original');fs.writeFileSync(path.join(f.dir,'empty.txt'),'');
 const listing=await (await f.request('/v1/panes/w1Y%3Ap1/files')).json();
 const route=entry=>'/v1/panes/w1Y%3Ap1/artifacts/'+entry.id;
 assert.equal(await (await f.request(route(listing.entries.find(e=>e.name==='empty.txt')))).text(),'');
 const original=fs.createReadStream;let streamed=0;
 t.mock.method(fs,'createReadStream',function(source,options){
   if(source===file)fs.appendFileSync(file,' appended while opening the stream');
   const stream=original.call(this,source,options);
   if(source===file)stream.on('data',chunk=>{streamed+=chunk.length;});
   return stream;
 });
 assert.equal(await (await f.request(route(listing.entries.find(e=>e.name==='growing.txt')))).text(),'original');
 assert.equal(streamed,Buffer.byteLength('original'));
});
test('saved pairing survives bridge recreation and still honors revocation',async t=>{
 const f=await fixture(t);
 const restarted=createBridge({socketPath:'/unused',stateDir:f.dir,projects:[]},{herdr:f.herdr});
 restarted.server.listen(0,'127.0.0.1');await once(restarted.server,'listening');
 t.after(()=>restarted.close());
 const url=`http://127.0.0.1:${restarted.server.address().port}`;
 const headers={Authorization:`Bearer ${f.credential.token}`};
 assert.equal((await fetch(url+'/v1/snapshot',{headers})).status,200);
 const ws=new WebSocket(url.replace('http','ws')+'/v1/events',{headers});
 const [message]=await once(ws,'message');assert.equal(JSON.parse(message).type,'snapshot');
 const closed=once(ws,'close');ws.close();await closed;
 restarted.store.revoke(f.credential.deviceId);
 assert.equal((await fetch(url+'/v1/snapshot',{headers})).status,401);
});
test('account grants authenticate HTTP and WebSocket without creating a paired credential',async t=>{
 const {publicKey,privateKey}=await generateKeyPair('EdDSA');
 const portalAuth={issuer:'https://remote.example.com',audience:'laptop',jwks:{keys:[{...await exportJWK(publicKey),kid:'test'}]}};
 const f=await fixture(t,{portalAuth,allowTerminalInput:true});
 const now=Math.floor(Date.now()/1000);
 const token=await new SignJWT({sid:'account_session_123456',sub:'owner@example.com',iat:now,exp:now+300,iss:portalAuth.issuer,aud:'laptop'})
  .setProtectedHeader({alg:'EdDSA',kid:'test',typ:'herdr-grant+jwt'}).sign(privateKey);
 assert.equal((await f.request('/v1/snapshot','GET',undefined,token)).status,200);
 assert.equal((await f.request('/v1/panes/w1Y%3Ap1/keys','POST',{keys:['enter']},token)).status,403);
 const ws=new WebSocket(f.url.replace('http','ws')+'/v1/events',{headers:{Authorization:`Bearer ${token}`}});
 const [message]=await once(ws,'message');assert.equal(JSON.parse(message).type,'snapshot');
 const closed=once(ws,'close');ws.close();await closed;
 assert.equal(f.app.store.read('devices.json',[]).length,1);
 assert.ok(f.calls.every(call=>call.method==='session.snapshot'));
 // A laptop owner can deliberately restore control to a verified legacy
 // account without making every account grant (or a new email) writable.
 f.app.store.write('access.json',{enabled:true,devices:{},accounts:{'owner@example.com':'normal'}});
 assert.equal((await(await f.request('/v1/snapshot','GET',undefined,token)).json()).canControl,true);
 const attachment=await upload(f,'owner.txt',Buffer.from('synthetic file'),token);
 assert.equal(attachment.status,201);
 const {id}=await attachment.json();
 assert.equal((await f.request('/v1/panes/w1Y%3Ap1/prompt','POST',{text:'review this',attachmentIds:[id]},token)).status,200);
 assert.equal(f.calls.at(-1).method,'agent.prompt');
 assert.match(f.calls.at(-1).params.text,/review this/);
 assert.match(f.calls.at(-1).params.text,/owner\.txt/);
 const other=await new SignJWT({sid:'other_session_123456',sub:'other@example.com',iat:now,exp:now+300,iss:portalAuth.issuer,aud:'laptop'})
  .setProtectedHeader({alg:'EdDSA',kid:'test',typ:'herdr-grant+jwt'}).sign(privateKey);
 assert.equal((await f.request('/v1/panes/w1Y%3Ap1/prompt','POST',{text:'denied'},other)).status,403);
 f.p.agent=null;
 assert.equal((await f.request('/v1/panes/w1Y%3Ap1/keys','POST',{keys:['enter']},token)).status,403);
 f.app.store.write('access.json',{enabled:true,devices:{},accounts:{'owner@example.com':'observer'}});
 assert.equal((await f.request('/v1/panes/w1Y%3Ap1/prompt','POST',{text:'denied again'},token)).status,403);
});
test('snapshots preserve authoritative status and do not invent last activity',async t=>{
 const f=await fixture(t);let data=await (await f.request('/v1/snapshot')).json();assert.equal(data.panes[0].status,'working');assert.equal(data.panes[0].lastActivity,null);
 f.p.revision++;f.p.agent_status='blocked';data=await(await f.request('/v1/snapshot')).json();assert.equal(data.panes[0].status,'blocked');assert.ok(data.panes[0].lastActivity);
});
test('Herdr outage is separate from bridge connectivity',async t=>{
 const f=await fixture(t);f.herdr.call=async()=>{throw Error('offline');};const health=await(await f.request('/v1/health')).json();assert.equal(health.bridgeOnline,true);assert.equal(health.herdrOnline,false);const snapshot=await(await f.request('/v1/snapshot')).json();assert.equal(snapshot.lastUpdatedAt,null);assert.equal(snapshot.stale,false);assert.equal(snapshot.panes.length,0);
});
test('Herdr outage retains the last good session list with freshness metadata',async t=>{
 const f=await fixture(t);const first=await(await f.request('/v1/snapshot')).json();assert.equal(first.panes.length,1);assert.ok(first.lastUpdatedAt);assert.equal(first.stale,false);
 await new Promise(resolve=>setTimeout(resolve,2));const refreshed=await(await f.request('/v1/snapshot')).json();assert.ok(refreshed.lastUpdatedAt>first.lastUpdatedAt);
 f.herdr.call=async()=>{throw Error('offline');};const stale=await(await f.request('/v1/snapshot')).json();assert.equal(stale.herdrOnline,false);assert.equal(stale.stale,true);assert.equal(stale.lastUpdatedAt,refreshed.lastUpdatedAt);assert.equal(stale.panes.length,1);
 f.herdr.call=async(method)=>method==='session.snapshot'?{snapshot:{protocol:22,workspaces:[],panes:[],agents:[]}}:{type:'ok'};
 const empty=await(await f.request('/v1/snapshot')).json();assert.equal(empty.stale,false);assert.equal(empty.panes.length,0);
 f.herdr.call=async()=>{throw Error('offline');};const afterEmpty=await(await f.request('/v1/snapshot')).json();assert.equal(afterEmpty.stale,true);assert.equal(afterEmpty.panes.length,0);
});
test('an existing phone connection observes Herdr recovery and controls the replacement pane', {timeout:10000}, async t=>{
 const f=await fixture(t);
 const original=f.herdr.call;
 let offline=false;
 f.herdr.call=async(method,params)=>{
  if(offline) throw new Error('Herdr stopped');
  if(params?.pane_id && params.pane_id!==f.p.pane_id) {
   const {BridgeError}=await import('../src/herdr.js');
   throw new BridgeError('pane_not_found','Pane closed',409);
  }
  return original(method,params);
 };
 const ws=new WebSocket(f.url.replace('http','ws')+'/v1/events',{headers:{Authorization:`Bearer ${f.credential.token}`}});
 t.after(()=>ws.terminate());
 const nextSnapshot=async predicate=>{
  while(true){
   const [message]=await once(ws,'message',{signal:AbortSignal.timeout(4000)});
   const frame=JSON.parse(message);
   if(frame.type==='snapshot'&&predicate(frame.data))return frame.data;
  }
 };
 const initial=await nextSnapshot(data=>data.herdrOnline);
 assert.equal(initial.panes[0].id,'w1Y:p1');
 offline=true;
 const stale=await nextSnapshot(data=>!data.herdrOnline);
 assert.equal(stale.stale,true);
 assert.equal(stale.panes[0].id,'w1Y:p1');
 f.p.pane_id='w1Y:p2';f.p.tab_id='w1Y:t2';offline=false;
 const recovered=await nextSnapshot(data=>data.herdrOnline);
 assert.equal(recovered.stale,false);
 assert.deepEqual(recovered.panes.map(p=>p.id),['w1Y:p2']);
 assert.ok(f.calls.every(call=>call.method==='session.snapshot'),'Recovery must never replay input');
 assert.equal((await f.request('/v1/panes/w1Y%3Ap1/output')).status,409);
 assert.equal((await f.request('/v1/panes/w1Y%3Ap2/output')).status,200);
 assert.equal((await f.request('/v1/panes/w1Y%3Ap2/keys','POST',{keys:['esc']})).status,200);
 assert.deepEqual(f.calls.at(-1),{method:'pane.send_keys',params:{pane_id:'w1Y:p2',keys:['esc']}});
 const closed=once(ws,'close');ws.close();await closed;
});
test('relaunching an agent in the same desktop pane refreshes its kind and allows a new prompt',async t=>{
 const f=await fixture(t);
 const snapshot=async()=>(await(await f.request('/v1/snapshot')).json()).panes[0];
 assert.equal((await snapshot()).kind,'codex');
 delete f.p.agent;f.p.agent_status='unknown';f.p.revision++;
 assert.equal((await snapshot()).kind,'terminal');
 assert.equal((await f.request('/v1/panes/w1Y%3Ap1/prompt','POST',{text:'hello'})).status,409);
 f.p.agent='codex';f.p.agent_status='idle';f.p.revision++;
 const relaunched=await snapshot();
 assert.equal(relaunched.id,'w1Y:p1');assert.equal(relaunched.kind,'codex');
 assert.equal((await f.request('/v1/panes/w1Y%3Ap1/prompt','POST',{text:'hello again'})).status,200);
 assert.deepEqual(f.calls.at(-1),{method:'agent.prompt',params:{target:'w1Y:p1',text:'hello again'}});
});
test('read maps exact installed schema spelling and bounds output',async t=>{const f=await fixture(t);const snapshot=await(await f.request('/v1/snapshot')).json();const id=snapshot.panes[0].id;assert.equal(id,'w1Y:p1');const r=await f.request(`/v1/panes/${encodeURIComponent(id)}/output`);assert.equal((await r.json()).text,'hello\nworld');assert.deepEqual(f.calls.findLast(c=>c.method==='pane.read'),{method:'pane.read',params:{pane_id:id,source:'recent_unwrapped',format:'ansi',strip_ansi:false,lines:300}});});
test('keys allowlist rejects whole request before writing',async t=>{const f=await fixture(t);assert.equal((await f.request('/v1/panes/w1Y%3Ap1/keys','POST',{keys:['enter','ctrl+d']})).status,400);assert.equal(f.calls.length,0);assert.equal((await f.request('/v1/panes/w1Y%3Ap1/keys','POST',{keys:['esc','ctrl+c']})).status,400);assert.equal((await f.request('/v1/panes/w1Y%3Ap1/keys','POST',{keys:['esc']})).status,200);assert.deepEqual(f.calls.at(-1),{method:'pane.send_keys',params:{pane_id:'w1Y:p1',keys:['esc']}});});
test('agent prompt uses agent surface, terminal execution is disabled by default',async t=>{const f=await fixture(t);assert.equal((await f.request('/v1/panes/w1Y%3Ap1/prompt','POST',{text:'hello'})).status,200);assert.deepEqual(f.calls.at(-1),{method:'agent.prompt',params:{target:'w1Y:p1',text:'hello'}});delete f.p.agent;assert.equal((await f.request('/v1/panes/w1Y%3Ap1/prompt','POST',{text:'whoami'})).status,409);assert.equal(f.calls.at(-1).method,'pane.get');});
test('terminal text insertion never appends Enter',async t=>{const f=await fixture(t,{allowTerminalInput:true});setDeviceMode(f.app.store,f.credential.deviceId,'terminal');delete f.p.agent;assert.equal((await f.request('/v1/panes/w1Y%3Ap1/input','POST',{text:'pwd'})).status,200);assert.deepEqual(f.calls.at(-1),{method:'pane.send_input',params:{pane_id:'w1Y:p1',text:'pwd'}});});
test('malformed, control and overlong pane IDs are rejected before Herdr RPC',async t=>{const f=await fixture(t);const routes=['/v1/panes/%ZZ/output',`/v1/panes/${encodeURIComponent('w1Y:p1\u0000')}/output`,`/v1/panes/${'x'.repeat(257)}/output`];for(const route of routes){const r=await f.request(route);assert.equal(r.status,400);assert.equal((await r.json()).error.code,'invalid_pane');}assert.equal(f.calls.length,0);});
test('launch rejects client paths and unsupported agents',async t=>{const f=await fixture(t);for(const body of [{projectId:'/tmp',kind:'codex',name:'new'},{projectId:'project',kind:'bash',name:'new'},{projectId:'project',kind:'codex',name:'x;echo'}])assert.ok((await f.request('/v1/agents','POST',body)).status>=400);assert.equal(f.calls.length,0);});
test('launch creates background layout and uses fixed argv-free agent start',async t=>{const f=await fixture(t);const r=await f.request('/v1/agents','POST',{projectId:'project',kind:'claude',name:'new'});assert.equal(r.status,201);assert.equal((await r.json()).paneId,'w1Y:p2');assert.equal(f.calls[1].params.focus,false);assert.deepEqual(f.calls.at(-1),{method:'agent.start',params:{pane_id:'w1Y:p2',kind:'claude',name:'new',timeout_ms:30000}});});
test('plain terminal creation retains a named shell without starting an agent or enabling input',async t=>{
 const f=await fixture(t);
 const response=await f.request('/v1/agents','POST',{projectId:'project',kind:'terminal',name:'my-shell'});
 assert.equal(response.status,201);const result=await response.json();assert.equal(result.paneId,'w1Y:p2');assert.ok(result.operationId);
 assert.deepEqual(f.calls,[
  {method:'workspace.create',params:{cwd:f.dir,label:'Project',focus:false}},
  {method:'pane.rename',params:{pane_id:'w1Y:p2',label:'my-shell'}},
 ]);
 const snapshot=await(await f.request('/v1/snapshot')).json();
 assert.equal(snapshot.terminalCreationEnabled,true);assert.equal(snapshot.allowTerminalInput,false);
 delete f.p.agent;
 assert.equal((await f.request('/v1/panes/w1Y%3Ap1/prompt','POST',{text:'pwd'})).status,409);
 assert.ok(!f.calls.some(c=>['agent.start','pane.send_input'].includes(c.method)));
});
test('terminal creation replay returns the same pane and cannot be reused for agent creation',async t=>{
 const f=await fixture(t,{allowTerminalInput:true});
 setDeviceMode(f.app.store,f.credential.deviceId,'terminal');
 const body={projectId:'project',kind:'terminal',name:'shell',operationId:'terminal-create-1'};
 const first=await(await f.request('/v1/agents','POST',body)).json();
 const second=await(await f.request('/v1/agents','POST',body)).json();
 assert.equal(second.paneId,first.paneId);assert.equal(second.replayed,true);
 assert.equal(f.calls.filter(c=>c.method==='workspace.create').length,1);
 assert.equal((await f.request('/v1/agents','POST',{...body,kind:'codex'})).status,409);
 const receipt=await(await f.request('/v1/operations/'+body.operationId)).json();
 assert.equal(receipt.kind,'agent.create');assert.equal(receipt.status,'succeeded');assert.equal(receipt.response.paneId,first.paneId);
 delete f.p.agent;
 assert.equal((await f.request('/v1/panes/w1Y%3Ap1/input','POST',{text:'pwd'})).status,200);
 assert.equal(f.calls.at(-1).method,'pane.send_input');
 assert.equal((await f.request('/v1/panes/w1Y%3Ap1/restart','POST',{})).status,409);
 assert.ok(!f.calls.some(c=>c.method==='agent.start'));
});
test('terminal creation rejects unauthorized paths and malformed names before layout mutation',async t=>{
 const f=await fixture(t);
 for(const body of [
  {projectId:'/tmp',kind:'terminal',name:'shell'},
  {projectId:'project',kind:'terminal',name:'shell;whoami'},
  {projectId:'project',kind:'terminal',name:'x'.repeat(33)},
 ]) assert.ok((await f.request('/v1/agents','POST',body)).status>=400);
 assert.equal((await f.request('/v1/agents','POST',{projectId:'project',kind:'terminal',name:'shell'},'bad')).status,401);
 assert.equal(f.calls.length,0);
});
test('terminal rename failure retains its pane and records uncertainty without a second creation',async t=>{
 const f=await fixture(t);const original=f.herdr.call;
 f.herdr.call=async(method,params)=>{
  if(method==='pane.rename'){const {BridgeError}=await import('../src/herdr.js');throw new BridgeError('herdr_timeout','Rename timed out.',504);}
  return original(method,params);
 };
 const body={projectId:'project',kind:'terminal',name:'shell',operationId:'terminal-rename-1'};
 const response=await f.request('/v1/agents','POST',body);assert.equal(response.status,504);
 const result=await response.json();assert.equal(result.error.paneId,'w1Y:p2');assert.equal(result.error.operationStatus,'uncertain');
 assert.equal((await f.request('/v1/agents','POST',body)).status,409);
 assert.equal(f.calls.filter(c=>c.method==='workspace.create').length,1);
 assert.ok(!f.calls.some(c=>['pane.close','agent.start'].includes(c.method)));
});
test('launch retries the pre-write shell readiness race within a bounded window',async t=>{
 const f=await fixture(t);let starts=0;const original=f.herdr.call;
 f.herdr.call=async(method,params,timeout)=>{
   if(method==='agent.start' && ++starts===1){const {BridgeError}=await import('../src/herdr.js');throw new BridgeError('agent_pane_busy','The new pane is not an available shell.',409);}
   return original(method,params,timeout);
 };
 const r=await f.request('/v1/agents','POST',{projectId:'project',kind:'claude',name:'new'});
 assert.equal(r.status,201);assert.equal(starts,2);
});
test('launch waits for Herdr launch_pending to become interactive',async t=>{
 const f=await fixture(t);let starts=0,gets=0;const original=f.herdr.call;
 f.herdr.call=async(method,params,timeout)=>{
   if(method==='agent.start'){starts++;return {type:'agent_started',agent:{launch_pending:true},argv:[]};}
   if(method==='agent.get'){gets++;return {agent:gets<2?{launch_pending:true,agent_status:'unknown'}:{launch_pending:false,interactive_ready:true,agent_status:'working'}};}
   return original(method,params,timeout);
 };
 const r=await f.request('/v1/agents','POST',{projectId:'project',kind:'claude',name:'new'});
 assert.equal(r.status,201);assert.equal(starts,1);assert.equal(gets,2);
});
test('unknown RPC routes and browser origins cannot mutate state',async t=>{const f=await fixture(t);assert.equal((await f.request('/v1/rpc','POST',{method:'server.stop'})).status,404);const r=await fetch(f.url+'/v1/snapshot',{headers:{Origin:'https://evil.test',Authorization:`Bearer ${f.credential.token}`}});assert.equal(r.status,403);assert.equal(f.calls.length,0);});
test('WebSocket requires auth and reconnect sends fresh snapshot without control RPC',async t=>{
 const f=await fixture(t);
 const bad=new WebSocket(f.url.replace('http','ws')+'/v1/events');bad.on('error',()=>{});const [response]=await once(bad,'unexpected-response').then(([req,res])=>[res]);assert.equal(response.statusCode,401);response.resume();bad.terminate();
 for(let i=0;i<2;i++){const ws=new WebSocket(f.url.replace('http','ws')+'/v1/events',{headers:{Authorization:`Bearer ${f.credential.token}`}});const [msg]=await once(ws,'message');assert.equal(JSON.parse(msg).type,'snapshot');const closed=once(ws,'close');ws.close();await closed;}
 assert.ok(f.calls.every(c=>c.method==='session.snapshot'));
});
test('NDJSON transport handles fragmented responses and matches request id',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-socket-'));const socketPath=path.join(dir,'api.sock');
 const sockets=new Set();const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.once('data',chunk=>{const req=JSON.parse(chunk.toString());socket.write(JSON.stringify({id:'other',result:{bad:true}})+'\n');const result=JSON.stringify({id:req.id,result:{type:'pong'}})+'\n';socket.write(result.slice(0,8));setTimeout(()=>socket.write(result.slice(8)),10);});});server.listen(socketPath);await once(server,'listening');
 t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});assert.deepEqual(await new Herdr(socketPath).call('ping'),{type:'pong'});
});
test('restart creates replacement before closing and preserves agent kind',async t=>{
 const f=await fixture(t);const r=await f.request('/v1/panes/w1Y%3Ap1/restart','POST',{});assert.equal(r.status,200);assert.equal((await r.json()).paneId,'w1Y:p2');assert.deepEqual(f.calls.map(c=>c.method),['pane.get','agent.get','tab.create','pane.close','agent.start']);assert.equal(f.calls.at(-1).params.kind,'codex');
});
test('restart refuses agents outside approved project directories before mutation',async t=>{
 const f=await fixture(t);f.p.cwd='/unapproved';assert.equal((await f.request('/v1/panes/w1Y%3Ap1/restart','POST',{})).status,403);assert.deepEqual(f.calls.map(c=>c.method),['pane.get','agent.get']);
});
test('startup blocked errors preserve created pane and identify it for inspection',async t=>{
 const f=await fixture(t);const original=f.herdr.call;f.herdr.call=async(method,params)=>{if(method==='agent.start'){const {BridgeError}=await import('../src/herdr.js');throw new BridgeError('agent_not_ready','Startup needs input',409);}return original(method,params);};
 const r=await f.request('/v1/agents','POST',{projectId:'project',kind:'codex',name:'new'});assert.equal(r.status,409);const data=await r.json();assert.equal(data.error.paneId,'w1Y:p2');assert.ok(!f.calls.some(c=>c.method==='pane.close'));
});

async function upload(f,name='report.pdf',bytes=Buffer.from('%PDF-test'),token=f.credential.token,paneId='w1Y:p1') {
 return fetch(`${f.url}/v1/panes/${encodeURIComponent(paneId)}/attachments`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/octet-stream','X-Attachment-Name':encodeURIComponent(name)},body:bytes});
}
test('attachments persist as private files and attachment-only prompts reference absolute paths',async t=>{
 const f=await fixture(t);
 assert.equal((await (await f.request('/v1/snapshot')).json()).attachmentsEnabled,true);
 const response=await upload(f);assert.equal(response.status,201);const attachment=await response.json();assert.equal(attachment.name,'report.pdf');assert.equal(attachment.size,9);
 const entries=f.app.store.read('attachments.json');const file=entries[0].file;
 assert.equal(fs.readFileSync(file,'utf8'),'%PDF-test');assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.statSync(path.dirname(file)).mode&0o777,0o700);
 assert.equal((await f.request('/v1/panes/w1Y%3Ap1/prompt','POST',{attachmentIds:[attachment.id]})).status,200);
 assert.equal(f.calls.at(-1).method,'agent.prompt');assert.ok(f.calls.at(-1).params.text.includes(JSON.stringify(file)));
 assert.ok(f.calls.at(-1).params.text.includes('image viewing tool'));
 // A fresh attachment handler reads durable metadata rather than an in-memory ID map.
 const {Attachments}=await import('../src/attachments.js');const restored=new Attachments({projects:[{path:f.dir}]},new Store(f.dir));
 assert.ok(restored.prompt('Read it',[attachment.id],f.p,f.p.pane_id,f.credential.deviceId).includes(file));
});
test('uploads reject unauthorized callers, empty files and excessive bodies',async t=>{
 const f=await fixture(t);assert.equal((await upload(f,'a.pdf',Buffer.from('a'),'bad')).status,401);assert.equal(f.calls.length,0);
 assert.equal((await upload(f,'empty.pdf',Buffer.alloc(0))).status,400);
 assert.equal((await upload(f,'big.pdf',Buffer.alloc(20*1024*1024+1))).status,413);
 assert.equal(f.app.store.read('attachments.json',[]).length,0);
});
test('attachment paths cannot escape approved projects or follow storage symlinks',async t=>{
 const f=await fixture(t);const a=await (await upload(f,'../../evil.pdf')).json();assert.ok(!a.name.includes('/'));
 const file=f.app.store.read('attachments.json')[0].file;assert.ok(file.startsWith(path.join(f.dir,'.herdr-remote-attachments')+path.sep));
 fs.rmSync(path.join(f.dir,'.herdr-remote-attachments'),{recursive:true});fs.symlinkSync(os.tmpdir(),path.join(f.dir,'.herdr-remote-attachments'));
 assert.equal((await upload(f)).status,403);
 f.p.cwd=os.tmpdir();assert.equal((await upload(f)).status,403);
});
test('attachments are scoped to device, pane and cwd and never sent to a shell',async t=>{
 const f=await fixture(t,{allowTerminalInput:true});const attachment=await(await upload(f)).json();
 const code=f.app.store.pairCode();const other=f.app.store.pair(code,'Other');
 const body={text:'Read',attachmentIds:[attachment.id]};
 assert.equal((await f.request('/v1/panes/w1Y%3Ap1/prompt','POST',body,other.token)).status,403);
 assert.equal((await f.request('/v1/panes/w1Y%3Ap2/prompt','POST',body)).status,409);
 fs.mkdirSync(path.join(f.dir,'child'));f.p.cwd=path.join(f.dir,'child');assert.equal((await f.request('/v1/panes/w1Y%3Ap1/prompt','POST',body)).status,403);
 assert.equal((await upload(f)).status,201);f.p.cwd=f.dir;delete f.p.agent;
 assert.equal((await upload(f)).status,403);assert.equal((await f.request('/v1/panes/w1Y%3Ap1/prompt','POST',body)).status,409);
 assert.ok(!f.calls.some(call=>call.method==='agent.prompt'||call.method==='pane.send_input'));
});
test('attachment IDs, file availability and cumulative quota are validated',async t=>{
 const f=await fixture(t);const attachment=await(await upload(f)).json();
 for(const attachmentIds of ['x',[attachment.id,attachment.id],Array.from({length:6},(_,i)=>String(i))]) assert.equal((await f.request('/v1/panes/w1Y%3Ap1/prompt','POST',{text:'Read',attachmentIds})).status,400);
 const entries=f.app.store.read('attachments.json');entries[0].size=200*1024*1024;f.app.store.write('attachments.json',entries);
 assert.equal((await upload(f)).status,413);
 fs.unlinkSync(entries[0].file);assert.equal((await f.request('/v1/panes/w1Y%3Ap1/prompt','POST',{attachmentIds:[attachment.id]})).status,403);
 assert.equal((await upload(f)).status,201);
});
test('chunked oversized uploads return a structured error without retaining partial files',async t=>{
 const f=await fixture(t);
 async function* chunks() { for(let i=0;i<21;i++) yield Buffer.alloc(1024*1024); }
 const response=await fetch(`${f.url}/v1/panes/w1Y%3Ap1/attachments`,{method:'POST',headers:{Authorization:`Bearer ${f.credential.token}`,'Content-Type':'application/octet-stream','X-Attachment-Name':'large.pdf'},body:chunks(),duplex:'half'});
 assert.equal(response.status,413);assert.equal((await response.json()).error.code,'attachment_too_large');
 assert.equal(f.app.store.read('attachments.json',[]).length,0);assert.ok(!fs.existsSync(path.join(f.dir,'.herdr-remote-attachments')));
 assert.equal((await upload(f)).status,201);
});
test('multibyte filenames exceeding the filesystem name limit fail before writing',async t=>{
 const f=await fixture(t);const response=await upload(f,'界'.repeat(100)+'.pdf');assert.equal(response.status,400);assert.equal((await response.json()).error.code,'invalid_attachment');
 assert.equal(f.app.store.read('attachments.json',[]).length,0);
});
test('an agent or directory change while uploading rejects the attachment before writing',async t=>{
 const f=await fixture(t);const original=f.herdr.call;let gets=0;
 f.herdr.call=async(method,params)=>{const result=await original(method,params);if(method==='pane.get'&&++gets===2) return {pane:{...f.p,cwd:os.tmpdir()}};return result;};
 assert.equal((await upload(f)).status,403);assert.ok(!fs.existsSync(path.join(f.dir,'.herdr-remote-attachments')));
});

test('aborted uploads release the upload lock and leave no partial files',async t=>{
 const f=await fixture(t);let paneRead;const started=new Promise(resolve=>{paneRead=resolve;});const original=f.herdr.call;
 f.herdr.call=async(method,params)=>{const result=await original(method,params);if(method==='pane.get')paneRead();return result;};
 const req=http.request(`${f.url}/v1/panes/w1Y%3Ap1/attachments`,{method:'POST',headers:{Authorization:`Bearer ${f.credential.token}`,'Content-Type':'application/octet-stream','X-Attachment-Name':'partial.pdf'}});
 req.on('error',()=>{});req.write(Buffer.alloc(1024));await started;req.destroy();
 // Wait for the server-side stream to observe the socket close before retrying.
 const deadline=Date.now()+2000;let response;
 do { await new Promise(resolve=>setTimeout(resolve,10));response=await upload(f); } while(response.status===409&&Date.now()<deadline);
 assert.equal(response.status,201);const entries=f.app.store.read('attachments.json',[]);assert.equal(entries.length,1);
 assert.deepEqual(fs.readdirSync(path.join(f.dir,'.herdr-remote-attachments')),[entries[0].id]);
});
