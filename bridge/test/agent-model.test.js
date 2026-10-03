import test from 'node:test';
import assert from 'node:assert/strict';
import {detectClaudeModelMenu,bindAgentModelMenu,hasEmptyClaudeModelComposer,openAgentModelMenu,actAgentModelMenu} from '../src/agent-model.js';
const pane={pane_id:'w:p',agent:'claude',agent_status:'idle',cwd:'/project',terminal_id:'t',agent_session:'session'};
const menu=(selected=0)=>`╭────────────────────────────────────╮\n│ Select model\n│ Switch between Claude models.\n│\n│ ${selected===0?'❯':' '} 1. Model Alpha ✓  First model\n│ ${selected===1?'❯':' '} 2. Model Beta  Second model\n│\n│ Medium effort ← → adjust\n│\n│ Enter to set as default · s to use this session only · Esc to cancel\n╰────────────────────────────────────╯\n`;
function fake(text,override={}) {let screen=text;const calls=[];return {calls,call:async(method,args)=>{calls.push({method,args});if(method==='pane.get')return {pane:{...pane,...override}};if(method==='pane.read')return {read:{text:screen}};if(method==='pane.send_keys'&&args.keys.includes('down'))screen=menu(1);return {};}};}
test('Claude numbered picker uses dynamic catalog and observed session-only footer',()=>{
  const first=detectClaudeModelMenu(menu());assert.equal(first.selectedIndex,0);assert.equal(first.options.length,2);assert.equal(first.sessionOnly,true);
  assert.equal(first.id,detectClaudeModelMenu(menu(1)).id);
  for(const text of [menu()+'❯ new prompt',menu().replace('s to use this session only · ',''),menu().replace('2.','4.'),menu().replace('Medium effort','Search models')])assert.equal(detectClaudeModelMenu(text),null);
});
test('Claude empty composer excludes drafts, unknown modal, and working agent',async()=>{
  assert.equal(hasEmptyClaudeModelComposer('────\n❯ \n────\n  ? for shortcuts'),true);
  assert.equal(hasEmptyClaudeModelComposer('❯ draft\n────'),false);
  assert.equal(hasEmptyClaudeModelComposer('❯\nApprove?'),false);
  const api=fake('❯\n────');await openAgentModelMenu(api,pane.pane_id,pane);
  assert.deepEqual(api.calls.at(-1),{method:'pane.send_input',args:{pane_id:pane.pane_id,text:'/model',keys:['enter']}});
  const busy=fake('❯');await assert.rejects(openAgentModelMenu(busy,pane.pane_id,{...pane,agent_status:'working'}));assert.equal(busy.calls.length,0);
});
test('Claude moves then uses session-only s, never persists default with enter',async()=>{
  const api=fake(menu()),menuId=bindAgentModelMenu(detectClaudeModelMenu(menu()),pane).id;
  await actAgentModelMenu(api,pane.pane_id,pane,{menuId,option:1});
  assert.deepEqual(api.calls.filter(c=>c.method==='pane.send_keys').map(c=>c.args.keys),[['down'],['s']]);
});
test('Claude stale session and stale menu cannot receive keys',async()=>{
  const menuId=bindAgentModelMenu(detectClaudeModelMenu(menu()),pane).id;
  for(const api of [fake(menu(),{agent_session:'replacement'}),fake(menu().replace('Model Alpha','Changed'))]){
    await assert.rejects(actAgentModelMenu(api,pane.pane_id,pane,{menuId,option:1}));assert.equal(api.calls.some(c=>c.method==='pane.send_keys'),false);
  }
});

test('installed Claude 2.1.263 isolated native picker and composer are recognized',async()=>{
  const {readFileSync}=await import('node:fs');
  const menu=detectClaudeModelMenu(readFileSync(new URL('./fixtures/claude-model-picker.txt',import.meta.url),'utf8'));
  assert.equal(menu.options.length,6);assert.equal(menu.selectedIndex,3);assert.equal(menu.sessionOnly,true);
  assert.equal(hasEmptyClaudeModelComposer(readFileSync(new URL('./fixtures/claude-model-empty-composer.txt',import.meta.url),'utf8')),true);
});

test('generic Codex wrapper includes explicit provider without changing menu identity',async()=>{
  const {readFileSync}=await import('node:fs');
  const {readAgentModelMenu}=await import('../src/agent-model.js');
  const {detectCodexModelMenu,bindCodexModelMenu}=await import('../src/codex-model.js');
  const text=readFileSync(new URL('./fixtures/codex-model-picker.txt',import.meta.url),'utf8');
  const codex={...pane,agent:'codex'};
  const result=await readAgentModelMenu(fake(text),codex.pane_id,codex);
  assert.equal(result.provider,'codex');
  assert.equal(result.id,bindCodexModelMenu(detectCodexModelMenu(text),codex).id);
});
