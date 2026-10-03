import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createBridge} from '../src/server.js';

const menu = selected => `Select model\n\n${selected===0?'❯':' '} 1. Default (recommended)\n${selected===1?'❯':' '} 2. Available model\n\nEnter to set as default · s to use this session only · Esc to cancel\n`;
const captured=name=>fs.readFileSync(new URL(`fixtures/${name}`,import.meta.url),'utf8');
async function fixture(t,agent='claude') {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-agent-model-http-'));
 let screen=agent==='opencode'?captured('opencode-model-empty.ansi'):'❯\n? for shortcuts',selected=0;const calls=[];
 const pane={pane_id:'w1:p1',workspace_id:'w1',tab_id:'t1',cwd:dir,agent,agent_status:'idle',terminal_id:'terminal',agent_session:'session'};
 const herdr={call:async(method,params)=>{
  calls.push({method,params});
  if(method==='session.snapshot')return {snapshot:{protocol:22,workspaces:[],panes:[pane],agents:[]}};
  if(method==='pane.get')return {pane:{...pane}};
  if(method==='pane.read')return {read:{text:screen,revision:1}};
  if(method==='pane.send_input'){screen=agent==='opencode'?captured('opencode-model-command.ansi'):menu(selected);return {};}
  if(method==='pane.send_keys'){
   if(agent==='opencode'){screen=captured(params.keys.includes('down')?'opencode-model-native-down.ansi':'opencode-model-native.ansi');return {};}
   if(params.keys.includes('down')){selected=1;screen=menu(selected);}
   if(params.keys.includes('s')||params.keys.includes('esc'))screen='❯\n? for shortcuts';
   return {};
  }
  return {};
 }};
 const app=createBridge({socketPath:'/unused',stateDir:path.join(dir,'state'),projects:[]},{herdr});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 const credential=app.store.pair(app.store.pairCode(),'test');
 const request=(action,body,operation)=>fetch(`http://127.0.0.1:${app.server.address().port}/v1/${action}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${credential.token}`,'Content-Type':'application/json',...(operation?{'X-Operation-Id':operation}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});return {request,calls,pane};
}
test('HTTP Claude model change uses live choices and session-only confirmation',async t=>{
 const f=await fixture(t);const snapshot=await (await f.request('snapshot')).json();
 assert.equal(snapshot.agentModelSelectionEnabled,true);assert.deepEqual(snapshot.modelSelectionAgents,['codex','claude','opencode']);
 const initial=await (await f.request('panes/w1%3Ap1/output')).json();
 assert.equal((await f.request('panes/w1%3Ap1/model',{attachmentId:initial.attachmentId})).status,200);
 const output=await (await f.request('panes/w1%3Ap1/output')).json();
 assert.equal(output.agentModelMenu.provider,'claude');assert.equal(output.codexModelMenu,undefined);
 const body={attachmentId:output.attachmentId,menuId:output.agentModelMenu.id,option:1};
 assert.equal((await f.request('panes/w1%3Ap1/model-select',body,'claude-choice-123')).status,200);
 assert.equal((await f.request('panes/w1%3Ap1/model-select',body,'claude-choice-123')).status,200);
 assert.deepEqual(f.calls.filter(c=>c.method==='pane.send_keys').map(c=>c.params.keys),[['down'],['s']]);
});
test('HTTP provider switch rejects old model choice and raw navigation on Claude',async t=>{
 const f=await fixture(t);const initial=await (await f.request('panes/w1%3Ap1/output')).json();
 assert.equal((await f.request('panes/w1%3Ap1/model',{attachmentId:initial.attachmentId})).status,200);
 const {agentModelMenu,attachmentId}=await (await f.request('panes/w1%3Ap1/output')).json();
 assert.equal((await f.request('panes/w1%3Ap1/model-key',{attachmentId,menuId:agentModelMenu.id,key:'enter'})).status,400);
 f.pane.agent='opencode';
 assert.equal((await f.request('panes/w1%3Ap1/model-select',{attachmentId,menuId:agentModelMenu.id,option:1})).status,409);
 assert.equal(f.calls.some(c=>c.method==='pane.send_keys'),false);
});

test('HTTP OpenCode opens attached picker and dispatches one observed model choice',async t=>{
 const f=await fixture(t,'opencode');
 const initial=await (await f.request('panes/w1%3Ap1/output')).json();
 assert.equal((await f.request('panes/w1%3Ap1/model',{attachmentId:initial.attachmentId})).status,200);
 const {agentModelMenu:menu,attachmentId}=await (await f.request('panes/w1%3Ap1/output')).json();
 assert.equal(menu.provider,'opencode');assert.equal(menu.mode,'options');assert.equal(menu.options.length,10);
 const body={attachmentId,menuId:menu.id,option:1};
 assert.equal((await f.request('panes/w1%3Ap1/model-select',body,'opencode-choice-123')).status,200);
 assert.equal((await f.request('panes/w1%3Ap1/model-select',body,'opencode-choice-123')).status,200);
 assert.deepEqual(f.calls.filter(c=>c.method==='pane.send_keys').map(c=>c.params.keys),[['enter'],['down'],['enter']]);
 assert.equal((await f.request('panes/w1%3Ap1/model-key',{attachmentId,menuId:menu.id,key:'enter'})).status,400);
});
