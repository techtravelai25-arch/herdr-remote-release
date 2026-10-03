// Explicit integration smoke test. HERDR_TEST_SOCKET must point to an isolated test session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createBridge} from '../src/server.js';
import {Herdr} from '../src/herdr.js';
const socketPath=process.env.HERDR_TEST_SOCKET;
if(!socketPath || !socketPath.includes('/sessions/remote-bridge-test/')) throw Error('Use the isolated remote-bridge-test session.');
const h=new Herdr(socketPath);const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remote-live-'));
const app=createBridge({socketPath,stateDir:dir,projects:[{id:'self',label:'Remote bridge test',path:process.cwd()}],allowTerminalInput:true});
let workspaceId;
try {
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://127.0.0.1:${app.server.address().port}`;
 const code=app.store.pairCode();const pair=await fetch(base+'/v1/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,deviceName:'Smoke test'})});assert.equal(pair.status,200);const {token}=await pair.json();
 const request=async(route,method='GET',body)=>{const r=await fetch(base+route,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;};
 assert.equal((await request('/v1/health')).herdrOnline,true);
 const created=await h.call('workspace.create',{cwd:process.cwd(),label:'Bridge smoke',focus:false});workspaceId=created.workspace.workspace_id;const id=created.root_pane.pane_id;const route='/v1/panes/'+encodeURIComponent(id);
 await request(route+'/prompt','POST',{text:"printf 'BRIDGE_SMOKE_OK\\n'"});
 let output;for(let n=0;n<10;n++){output=await request(route+'/output');if(/^BRIDGE_SMOKE_OK\r?$/m.test(output.text))break;await new Promise(r=>setTimeout(r,100));}assert.ok(/^BRIDGE_SMOKE_OK\r?$/m.test(output.text));
 for(const key of ['enter','esc','tab','up','down','left','right','ctrl+c'])await request(route+'/keys','POST',{keys:[key]});
 const s=await request('/v1/snapshot');assert.ok(s.panes.some(p=>p.id===id&&p.kind==='terminal'));
 await request(route,'DELETE');workspaceId=null;
 console.log('PASS: real socket HTTP pairing, health, snapshot, ordinary terminal input opt-in, output, all eight keys, close.');
} finally {if(workspaceId)await h.call('workspace.close',{workspace_id:workspaceId}).catch(()=>{});await app.close();fs.rmSync(dir,{recursive:true,force:true});}
