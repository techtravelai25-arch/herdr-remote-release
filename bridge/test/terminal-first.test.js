import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createBridge} from '../src/server.js';
import {BridgeError} from '../src/herdr.js';
import {setDeviceMode} from '../src/access.js';

const route=id=>`/v1/panes/${encodeURIComponent(id)}`;
async function fixture(t,{agent='codex',text='plain terminal output',allowTerminalInput=true}={}) {
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-first-'));
  const panes=new Map(['w1:p1','w1:p2'].map((id,index)=>[id,{pane_id:id,terminal_id:`term-${index}`,workspace_id:'w1',tab_id:`w1:t${index+1}`,cwd:stateDir,agent:index?null:agent,agent_session:index?null:{value:'agent-1'},agent_status:'unknown',revision:1}]));
  const calls=[];let screen=text,failWrite=false;
  const herdr={call:async(method,params={})=>{
    calls.push({method,params});
    if(method==='session.snapshot')return {snapshot:{protocol:22,workspaces:[{workspace_id:'w1'}],panes:[...panes.values()],agents:[]}};
    if(method==='pane.get') {const pane=panes.get(params.pane_id);if(!pane)throw new BridgeError('pane_not_found','Pane closed.',409);return {pane};}
    if(method==='pane.read')return {read:{text:screen,revision:1,truncated:false}};
    if(method==='agent.prompt'||method==='pane.send_input'||method==='pane.send_keys') {
      if(failWrite)throw new BridgeError('herdr_timeout','Dispatch uncertain.',504);
      return {type:'ok'};
    }
    throw new Error(`Unexpected Herdr method ${method}`);
  }};
  const config={socketPath:'/unused',stateDir,projects:[],allowTerminalInput};
  async function start() {
    const app=createBridge(config,{herdr});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
    return {app,url:`http://127.0.0.1:${app.server.address().port}`};
  }
  let active=await start();
  const code=active.app.store.pairCode(), credential=active.app.store.pair(code,'Phone');
  setDeviceMode(active.app.store,credential.deviceId,'terminal');
  const request=(path,method='GET',body,token=credential.token)=>fetch(active.url+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  t.after(async()=>{await active.app.close();fs.rmSync(stateDir,{recursive:true,force:true});});
  return {panes,calls,request,route,credential,setScreen:value=>{screen=value;},setFailWrite:value=>{failWrite=value;},restart:async()=>{await active.app.close();active=await start();}};
}

async function attached(f,id='w1:p1') {const response=await f.request(route(id)+'/output');assert.equal(response.status,200);return response.json();}

test('arbitrary vendor layouts remain passive text snapshots with the same controls',async t=>{
  const f=await fixture(t);
  for(const screen of ['╭ old footer ─╮\n› model one\n╰ enter approves ╯','\u001b[31mNEW heading\u001b[0m\n\n[3] differently ordered\n<script>alert(1)</script>','\u001b]52;c;SGVsbG8=\u0007Clipboard escape\n\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007']) {
    f.setScreen(screen);
    const output=await attached(f);
    assert.equal(output.source,'recent_unwrapped');assert.ok(output.attachmentId);
    assert.equal(output.currentModel,null);assert.equal(output.question,undefined);assert.equal(output.agentModelMenu,undefined);
    assert.match(output.text,screen.includes('script')?/<script>alert\(1\)<\/script>/:screen.includes('Clipboard')?/Clipboard escape/:/old footer/);
    assert.equal(output.text.includes('\u001b'),false);
  }
  // Ordinary output polling never invokes a vendor menu reader.
  assert.equal(f.calls.some(call=>call.method==='pane.read'&&call.params.source==='detection'),false);
  assert.equal(f.calls.some(call=>call.method==='pane.send_input'||call.method==='pane.send_keys'),false);
});

test('unavailable structured history and unknown status do not gate the terminal',async t=>{
  const f=await fixture(t);
  const snapshot=await(await f.request('/v1/snapshot')).json();
  assert.equal(snapshot.panes[0].status,'unknown');
  const history=await(await f.request(route('w1:p1')+'/history')).json();
  assert.equal(history.available,false);
  const output=await attached(f);
  assert.equal(output.currentModel,null);
  assert.equal((await f.request(route('w1:p1')+'/keys','POST',{attachmentId:output.attachmentId,keys:['esc'],operationId:'history-independent-001'})).status,200);
});

test('explicit text and one chosen key target only the attached pane',async t=>{
  const f=await fixture(t);const first=await attached(f),second=await attached(f,'w1:p2');
  const body={attachmentId:first.attachmentId,text:'héllo `$(touch nope)`\nline 2',operationId:'manual-text-001'};
  assert.equal((await f.request(route('w1:p1')+'/input','POST',body)).status,200);
  assert.deepEqual(f.calls.filter(call=>call.method==='pane.send_input').map(call=>call.params),[{pane_id:'w1:p1',text:body.text}]);
  assert.equal((await f.request(route('w1:p2')+'/input','POST',{...body,operationId:'manual-text-002'})).status,409);
  assert.equal((await f.request(route('w1:p1')+'/keys','POST',{attachmentId:first.attachmentId,keys:['enter'],operationId:'manual-key-001'})).status,200);
  assert.deepEqual(f.calls.filter(call=>call.method==='pane.send_keys').map(call=>call.params),[{pane_id:'w1:p1',keys:['enter']}]);
  assert.ok(second.attachmentId!==first.attachmentId);
  f.panes.get('w1:p1').terminal_id='replacement';
  assert.equal((await f.request(route('w1:p1')+'/keys','POST',{attachmentId:first.attachmentId,keys:['esc'],operationId:'manual-key-002'})).status,409);
  assert.equal(f.calls.filter(call=>call.method==='pane.send_keys').length,1);
  f.panes.delete('w1:p1');
  assert.equal((await f.request(route('w1:p1')+'/keys','POST',{attachmentId:first.attachmentId,keys:['esc'],operationId:'manual-key-003'})).status,409);
  assert.equal(f.calls.some(call=>['agent.start','agent.restart','workspace.create','tab.create'].includes(call.method)),false);
});

test('manual input requires a fresh attachment and plain terminals require the local grant',async t=>{
  const f=await fixture(t,{allowTerminalInput:false});const output=await attached(f,'w1:p2');
  assert.equal((await f.request(route('w1:p2')+'/input','POST',{attachmentId:output.attachmentId,text:'x',operationId:'manual-denied-001'})).status,403);
  assert.equal((await f.request(route('w1:p1')+'/input','POST',{text:'x',operationId:'manual-denied-002'})).status,409);
  assert.equal((await f.request(route('w1:p1')+'/keys','POST',{keys:['enter'],operationId:'manual-denied-003'})).status,409);
  assert.equal(f.calls.some(call=>['pane.send_input','pane.send_keys'].includes(call.method)),false);
});

test('lost write acknowledgment stays uncertain across a bridge restart and cannot replay',async t=>{
  const f=await fixture(t);const output=await attached(f);f.setFailWrite(true);
  const body={attachmentId:output.attachmentId,text:'once',operationId:'manual-uncertain-001'};
  const first=await f.request(route('w1:p1')+'/input','POST',body);assert.equal(first.status,504);
  const receipt=await (await f.request('/v1/operations/manual-uncertain-001')).json();assert.equal(receipt.status,'uncertain');
  f.setFailWrite(false);await f.restart();
  const repeat=await f.request(route('w1:p1')+'/input','POST',body);assert.equal(repeat.status,409);
  assert.equal(f.calls.filter(call=>call.method==='pane.send_input').length,1);
  const fresh=await attached(f);assert.notEqual(fresh.attachmentId,output.attachmentId);
});

test('prompt uses agent.prompt only and unavailable native questions stay inert',async t=>{
  const f=await fixture(t); const output=await attached(f);
  assert.equal((await f.request(route('w1:p1')+'/prompt','POST',{attachmentId:output.attachmentId,text:'task',operationId:'semantic-prompt-001'})).status,200);
  assert.deepEqual(f.calls.filter(call=>call.method==='agent.prompt').map(call=>call.params),[{target:'w1:p1',text:'task'}]);
  assert.equal((await f.request(route('w1:p1')+'/answer','POST',
    {attachmentId:output.attachmentId,questionId:'a'.repeat(64),option:0,operationId:'no-question-001'})).status,409);
  assert.equal(f.calls.some(call=>call.method==='pane.send_keys'||call.method==='pane.send_input'),false);
});
test('model actions require a fresh pane attachment before any native menu work',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request(route('w1:p1')+'/model','POST',{})).status,409);
  const output=await attached(f);
  for(const [action,body] of [['model-select',{attachmentId:output.attachmentId,menuId:'a'.repeat(64),option:0}],['model-cancel',{attachmentId:output.attachmentId,menuId:'a'.repeat(64)}],['model-key',{attachmentId:output.attachmentId,menuId:'a'.repeat(64),key:'down'}]]) {
    const response=await f.request(route('w1:p1')+'/'+action,'POST',body);
    assert.equal(response.status,409);assert.equal((await response.json()).error.code,'model_stale');
  }
  // A codex pane with no recognized native picker stays unavailable, not broken.
  const opening=await f.request(route('w1:p1')+'/model','POST',{attachmentId:output.attachmentId,operationId:'semantic-model-001'});
  assert.equal(opening.status,409);assert.equal((await opening.json()).error.code,'model_unavailable');
  assert.equal(f.calls.some(call=>call.method==='pane.send_input'||call.method==='pane.send_keys'),false);
});
