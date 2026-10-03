import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createBridge} from '../src/server.js';

const route='/v1/panes/w1%3Ap1';
const writes=calls=>calls.filter(call=>['pane.send_keys','pane.send_input','agent.start','agent.restart'].includes(call.method));
const composer='› Ask Codex to do anything\n  GPT-6-Sol high · Context 100% left · weekly 99% left\n  ← for agents · ? for shortcuts\n';
const renderMenu=(stage='model',selected=0)=>[
  stage==='model'?'Select Model':'Select Reasoning Level for gpt-6-mini',
  ...(stage==='model'?['gpt-6 (current)','gpt-6-mini']:['Low','Medium','High']).map((label,index)=>`${selected===index?'›':' '} ${index+1}. ${label}`),
  'Press enter to confirm or esc to go back',''
].join('\n');

async function fixture(t,{agent='codex',status='idle',text='',onWrite}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-codex-model-http-'));
  const pane={pane_id:'w1:p1',workspace_id:'w1',tab_id:'t1',cwd:dir,agent_status:status,agent,terminal_id:'term',agent_session:{value:'session'}};
  const state={text}; const calls=[];
  const herdr={call:async(method,params)=>{
    calls.push({method,params});
    if(method==='session.snapshot')return {snapshot:{protocol:22,workspaces:[{workspace_id:'w1',label:'Project'}],panes:[pane],agents:[pane]}};
    if(method==='pane.get')return {pane};
    if(method==='pane.read')return {read:{text:params.source==='detection'?state.text:'recent conversation',revision:1,truncated:false}};
    if(['pane.send_keys','pane.send_input'].includes(method))await onWrite?.(method,params,state);
    return {type:'ok'};
  }};
  const app=createBridge({socketPath:'/unused',stateDir:path.join(dir,'state'),projects:[{id:'p',label:'Project',path:dir}],allowTerminalInput:false},{herdr});
  app.server.listen(0,'127.0.0.1'); await once(app.server,'listening');
  const credential=app.store.pair(app.store.pairCode(),'model-http-test');
  const request=(endpoint,method='GET',body,operationId)=>fetch(`http://127.0.0.1:${app.server.address().port}${endpoint}`,{
    method,headers:{Authorization:`Bearer ${credential.token}`,'Content-Type':'application/json',...(operationId?{'X-Operation-Id':operationId}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  // A mutating picker action is scoped to the exact pane the device attached to.
  const attach=async()=> (await (await request(`${route}/output`)).json());
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {request,attach,pane,state,calls};
}

test('HTTP advertises structured Codex model selection independently of arbitrary terminal input',async t=>{
  const f=await fixture(t); const snapshot=await (await f.request('/v1/snapshot')).json();
  assert.equal(snapshot.codexModelSelectionEnabled,true); assert.equal(snapshot.allowTerminalInput,false);
  assert.equal(snapshot.agentModelSelectionEnabled,true); assert.deepEqual(snapshot.modelSelectionAgents,['codex','claude','opencode']);
});

test('HTTP validates model action bodies before terminal writes',async t=>{
  const f=await fixture(t); const output=await f.attach();
  for(const [action,body] of [
    ['model',{model:'injected'}],['model-select',{}],['model-select',{menuId:'invalid',option:0}],
    ['model-select',{menuId:'a'.repeat(64),option:-1}],['model-select',{menuId:'a'.repeat(64),option:1.5}],
    ['model-select',{menuId:'a'.repeat(64),option:'1'}],['model-select',{menuId:'a'.repeat(64),option:100}],
    ['model-select',{menuId:'a'.repeat(64),option:0,text:'unexpected'}],['model-cancel',{}],
    ['model-cancel',{menuId:'a'.repeat(64),option:0}],['model-key',{menuId:'a'.repeat(64),key:'ctrl+c'}]
  ])assert.equal((await f.request(`${route}/${action}`,'POST',{attachmentId:output.attachmentId,...body})).status,400,action+JSON.stringify(body));
  assert.equal(writes(f.calls).length,0);
  assert.equal((await f.request(`${route}/model`,'POST',{})).status,409);
  assert.equal(writes(f.calls).length,0);
});

test('HTTP never exposes or controls Codex models for other pane types',async t=>{
  for(const agent of ['terminal','claude','opencode']) {
    const f=await fixture(t,{agent,text:renderMenu()});
    const output=await f.attach();
    assert.equal(output.codexModelMenu,undefined);
    const body={attachmentId:output.attachmentId};
    assert.equal((await f.request(`${route}/model`,'POST',body)).status,409);
    assert.equal((await f.request(`${route}/model-select`,'POST',{...body,menuId:'a'.repeat(64),option:0})).status,409);
    assert.equal((await f.request(`${route}/model-cancel`,'POST',{...body,menuId:'a'.repeat(64)})).status,409);
    assert.equal(writes(f.calls).length,0);
  }
});

test('HTTP model opening refuses working, desktop drafts, and active modals without writing',async t=>{
  for(const options of [
    {status:'working',text:composer}, {text:'› Keep this desktop draft\n  gpt-6 high · Context 97% left\n'},
    {status:'blocked',text:'Would you like to run this command?\n› 1. Yes\n  2. No\n'},
    {text:renderMenu()}
  ]) {
    const f=await fixture(t,options);
    const output=await f.attach();
    const response=await f.request(`${route}/model`,'POST',{attachmentId:output.attachmentId});
    assert.equal(response.status,409);assert.equal((await response.json()).error.code,'model_unavailable');
    assert.equal(writes(f.calls).length,0);
  }
});

test('HTTP explains a new Codex pane waiting for folder trust without writing',async t=>{
  const f=await fixture(t,{text:'Folder access\n/home/test\nTrust this folder? Codex can read, edit, and run files here.'});
  const output=await f.attach();
  const response=await f.request(`${route}/model`,'POST',{attachmentId:output.attachmentId});
  assert.equal(response.status,409);
  const error=(await response.json()).error;
  assert.equal(error.code,'model_unavailable');
  assert.match(error.message,/Trust this folder\?/);
  assert.equal(writes(f.calls).length,0);
});

test('HTTP model selection follows native model and reasoning menus without restarting the conversation',async t=>{
  let stage='model',selected=0;
  const f=await fixture(t,{text:composer,onWrite:(method,params,state)=>{
    if(method==='pane.send_input') {assert.equal(params.text,'/model');state.text=renderMenu();return;}
    for(const key of params.keys) {
      if(key==='down')selected++;
      if(key==='up')selected--;
      if(key==='enter') {if(stage==='reasoning'){state.text=composer;return;}stage='reasoning';selected=0;}
      if(key==='escape'){state.text=composer;return;}
    }
    state.text=renderMenu(stage,selected);
  }});
  const initial=await f.attach();
  const opened=await f.request(`${route}/model`,'POST',{attachmentId:initial.attachmentId},'codex-open-legacy');
  assert.equal(opened.status,200);
  const output=await f.attach(); const menu=output.codexModelMenu;
  assert.equal(menu.stage,'model');assert.equal(menu.selectedIndex,0); assert.deepEqual(menu.options,['gpt-6 (current)','gpt-6-mini']);
  assert.equal(output.agentModelMenu.id,menu.id);
  assert.equal((await f.request(`${route}/model-select`,'POST',{attachmentId:output.attachmentId,menuId:menu.id,option:1})).status,200);
  const reasoning=(await f.attach()).codexModelMenu;
  assert.equal(reasoning.stage,'reasoning');assert.notEqual(reasoning.id,menu.id);
  assert.equal((await f.request(`${route}/model-select`,'POST',{attachmentId:(await f.attach()).attachmentId,menuId:reasoning.id,option:2})).status,200);
  assert.equal((await f.attach()).codexModelMenu,undefined);
  assert.deepEqual(writes(f.calls).map(call=>call.params.keys),[['enter'],['down'],['enter'],['down','down'],['enter']]);
  assert.equal(f.calls.some(call=>call.method==='agent.restart'||call.method==='agent.start'),false);
});

test('HTTP exposes Codex 0.158 menus and applies reasoning to this session',async t=>{
  const model=fs.readFileSync(new URL('./fixtures/codex-model-picker-0.158.txt',import.meta.url),'utf8');
  const reasoning=fs.readFileSync(new URL('./fixtures/codex-reasoning-picker-0.158.txt',import.meta.url),'utf8');
  const f=await fixture(t,{text:composer,onWrite:(method,params,state)=>{
    if(method==='pane.send_input'){assert.equal(params.text,'/model');state.text=model;return;}
    if(params.keys[0]==='enter'){state.text=reasoning;return;}
    if(params.keys[0]==='s'){state.text=composer;return;}
  }});
  const initial=await f.attach();
  assert.equal((await f.request(`${route}/model`,'POST',{attachmentId:initial.attachmentId},'codex-open-0158')).status,200);
  const first=(await f.attach()).agentModelMenu;
  assert.equal(first.stage,'model');
  assert.equal((await f.request(`${route}/model-select`,'POST',{attachmentId:(await f.attach()).attachmentId,menuId:first.id,option:1})).status,200);
  const second=(await f.attach()).agentModelMenu;
  assert.equal(second.stage,'reasoning');
  assert.equal((await f.request(`${route}/model-select`,'POST',{attachmentId:(await f.attach()).attachmentId,menuId:second.id,option:2})).status,200);
  assert.equal((await f.attach()).agentModelMenu,undefined);
  assert.deepEqual(writes(f.calls).map(call=>call.params.keys),[['enter'],['enter'],['s']]);
});

test('HTTP fails closed on an unknown Codex menu version without metadata or writes',async t=>{
  const unknown=fs.readFileSync(new URL('./fixtures/codex-model-picker-0.158.txt',import.meta.url),'utf8')
    .replace('enter select · esc back','enter select · esc quit');
  const f=await fixture(t,{text:composer,onWrite:(method,params,state)=>{if(method==='pane.send_input')state.text=unknown;}});
  const initial=await f.attach();
  assert.equal((await f.request(`${route}/model`,'POST',{attachmentId:initial.attachmentId})).status,200);
  const output=await f.attach();
  assert.equal(output.agentModelMenu,undefined);assert.equal(output.codexModelMenu,undefined);
  for(const action of ['model-select','model-cancel']) {
    const response=await f.request(`${route}/${action}`,'POST',{attachmentId:output.attachmentId,menuId:'a'.repeat(64),...(action==='model-select'?{option:0}:{})});
    assert.equal(response.status,409);assert.equal((await response.json()).error.code,'model_stale');
  }
  assert.equal(writes(f.calls).length,1);
});

test('HTTP rejects a stale attachment and a stale menu without writes',async t=>{
  const open=(method,params,state)=>{if(method==='pane.send_input')state.text=renderMenu();};
  const f=await fixture(t,{text:composer,onWrite:open});
  const initial=await f.attach();
  assert.equal((await f.request(`${route}/model`,'POST',{attachmentId:initial.attachmentId})).status,200);
  const output=await f.attach(); const menu=output.codexModelMenu;
  f.pane.agent_session={value:'replacement'};
  for(const [action,body] of [['model-select',{menuId:menu.id,option:0}],['model-cancel',{menuId:menu.id}],['model',{}]]) {
    const response=await f.request(`${route}/${action}`,'POST',{attachmentId:output.attachmentId,...body});
    assert.equal(response.status,409);assert.equal((await response.json()).error.code,'pane_attachment_stale');
  }
  assert.equal(writes(f.calls).length,1);
  const fresh=await fixture(t,{text:composer,onWrite:open});
  const before=await fresh.attach();
  assert.equal((await fresh.request(`${route}/model`,'POST',{attachmentId:before.attachmentId})).status,200);
  const attached=await fresh.attach();
  fresh.state.text=renderMenu('reasoning');
  for(const [action,body] of [['model-select',{menuId:attached.codexModelMenu.id,option:0}],['model-cancel',{menuId:attached.codexModelMenu.id}]]) {
    const response=await fresh.request(`${route}/${action}`,'POST',{attachmentId:attached.attachmentId,...body});
    assert.equal(response.status,409);assert.equal((await response.json()).error.code,'model_stale');
  }
  assert.equal(writes(fresh.calls).length,1);
});

test('HTTP model action receipts replay open, selection, and cancellation without duplicate writes',async t=>{
  for(const [action,fields] of [['model',{}],['model-select',{option:0}],['model-cancel',{}]]) {
    const f=await fixture(t,{text:composer,onWrite:(method,params,state)=>{if(method==='pane.send_input')state.text=renderMenu();}});
    const initial=await f.attach();
    if(action!=='model') assert.equal((await f.request(`${route}/model`,'POST',{attachmentId:initial.attachmentId})).status,200);
    const attached=await f.attach(),menu=attached.codexModelMenu;
    const body={attachmentId:attached.attachmentId,...fields,...(menu?{menuId:menu.id}:{})}; const operationId=`model-http-${action}`;
    const beforeWrites=writes(f.calls).length;
    assert.equal((await f.request(`${route}/${action}`,'POST',body,operationId)).status,200);
    const second=await f.request(`${route}/${action}`,'POST',body,operationId);
    assert.equal(second.status,200);assert.equal((await second.json()).replayed,true);assert.equal(writes(f.calls).length,beforeWrites+1);
    const receipt=await (await f.request(`/v1/operations/${operationId}`)).json();assert.equal(receipt.status,'succeeded');
  }
});

test('HTTP model actions lock the pane while an operation is in flight',async t=>{
  let release,started;
  const pending=new Promise(resolve=>{release=resolve;});
  const writing=new Promise(resolve=>{started=resolve;});
  const f=await fixture(t,{text:composer,onWrite:async()=>{started();await pending;}});
  const output=await f.attach();
  const first=f.request(`${route}/model`,'POST',{attachmentId:output.attachmentId},'model-lock-first');
  await writing;
  try {
    const second=await f.request(`${route}/model`,'POST',{attachmentId:output.attachmentId},'model-lock-second');
    assert.equal(second.status,409); assert.equal((await second.json()).error.code,'busy');
  } finally {release();}
  assert.equal((await first).status,200); assert.equal(writes(f.calls).length,1);
});

test('HTTP model selection never confirms an unobserved cursor movement',async t=>{
  const f=await fixture(t,{text:composer,onWrite:(method,params,state)=>{if(method==='pane.send_input')state.text=renderMenu();}});
  const initial=await f.attach();
  assert.equal((await f.request(`${route}/model`,'POST',{attachmentId:initial.attachmentId})).status,200);
  const output=await f.attach(); const menu=output.codexModelMenu;
  assert.equal((await f.request(`${route}/model-select`,'POST',{attachmentId:output.attachmentId,menuId:menu.id,option:1})).status,409);
  assert.deepEqual(writes(f.calls).map(call=>call.params.keys),[['enter'],['down']]);
});

test('HTTP uncertain model writes remain uncertain and are never retried implicitly',async t=>{
  const f=await fixture(t,{text:composer,onWrite:()=>{throw Object.assign(new Error('socket lost'),{code:'herdr_timeout'});}});
  const output=await f.attach();
  const first=await f.request(`${route}/model`,'POST',{attachmentId:output.attachmentId},'model-uncertain');
  assert.equal(first.status,500); assert.equal((await first.json()).error.operationStatus,'uncertain');
  const second=await f.request(`${route}/model`,'POST',{attachmentId:output.attachmentId},'model-uncertain');
  assert.equal(second.status,409);assert.equal((await second.json()).error.operationStatus,'uncertain');
  assert.equal(writes(f.calls).length,1);
  const receipt=await (await f.request('/v1/operations/model-uncertain')).json();
  assert.equal(receipt.status,'uncertain');
});
