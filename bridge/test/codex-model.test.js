import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {detectCodexModelMenu,bindCodexModelMenu,hasEmptyCodexModelComposer,openCodexModelMenu,actCodexModelMenu} from '../src/codex-model.js';

const fixture=(selected=0)=>`Select Model and Effort\n\n  ${selected===0?'›':''} 1. example-model (current)  Model description\n  ${selected===1?'›':''} 2. another-model  Other description\n\n  Press enter to confirm or esc to go back\n`;
const pane={pane_id:'w1:p1',agent:'codex',agent_status:'idle',cwd:'/project',terminal_id:'t1',agent_session:'s1'};
test('native model menu uses visible options and stable selection-independent identity',()=>{
  const first=detectCodexModelMenu(fixture());const moved=detectCodexModelMenu(fixture(1));
  assert.equal(first.selectedIndex,0);assert.equal(moved.selectedIndex,1);assert.equal(first.id,moved.id);
  assert.equal(first.stage,'model');assert.deepEqual(first.options,['example-model (current)  Model description','another-model  Other description']);
  assert.notEqual(bindCodexModelMenu(first,pane).id,bindCodexModelMenu(first,{...pane,agent_session:'new'}).id);
});
test('recognizes official reasoning picker and rejects stale or malformed screens',()=>{
  assert.equal(detectCodexModelMenu(fixture().replace('Select Model and Effort','Select Reasoning Level for example-model')).stage,'reasoning');
  for(const text of [fixture()+'› desktop draft',fixture().replace('2.','4.'),fixture().replace('›',''),fixture().replace('Select Model and Effort','Approve command'),fixture().replace('Press enter to confirm or esc to go back','')])assert.equal(detectCodexModelMenu(text),null);
});
test('current Codex picker footers expose both stages and session-only confirmation',()=>{
  const model=readFileSync(new URL('./fixtures/codex-model-picker-0.158.txt',import.meta.url),'utf8');
  const reasoning=readFileSync(new URL('./fixtures/codex-reasoning-picker-0.158.txt',import.meta.url),'utf8');
  const advanced=readFileSync(new URL('./fixtures/codex-advanced-reasoning-picker-0.158.txt',import.meta.url),'utf8');
  assert.equal(detectCodexModelMenu(model)?.selectedIndex,1);
  assert.equal(detectCodexModelMenu(model)?.options.length,7);
  assert.equal(detectCodexModelMenu(model)?.footerKey,'enter');
  assert.equal(detectCodexModelMenu(reasoning)?.stage,'reasoning');
  assert.equal(detectCodexModelMenu(reasoning)?.selectedIndex,2);
  assert.equal(detectCodexModelMenu(reasoning)?.footerKey,'s');
  assert.equal(detectCodexModelMenu(advanced)?.stage,'reasoning');
  assert.deepEqual(detectCodexModelMenu(advanced)?.options.map(option=>option.split('  ')[0]),['Max','Ultra']);
  assert.equal(detectCodexModelMenu(reasoning.replace('s session','s something else')),null);
  assert.equal(detectCodexModelMenu(model+'› desktop draft'),null);
});
test('empty composer supports real animated fixture but not a draft or modal',()=>{
  const text=readFileSync(new URL('../../android/app/src/test/resources/codex-idle-braille.txt',import.meta.url),'utf8');
  assert.equal(hasEmptyCodexModelComposer(text),true);
  assert.equal(hasEmptyCodexModelComposer(text.replace('Ask Codex to do anything','my draft')),false);
  assert.equal(hasEmptyCodexModelComposer(text+'\nApprove?'),false);
});
test('empty composer accepts the current Codex footer and shortcut hint',()=>{
  const text='› Ask Codex to do anything\n\n  GPT-6-Sol high · Context 100% left · weekly 99% left\n  ← for agents · ? for shortcuts\n';
  assert.equal(hasEmptyCodexModelComposer(text),true);
  assert.equal(hasEmptyCodexModelComposer(text.replace('GPT-6-Sol high','custom-model-v7 none')),true);
  assert.equal(hasEmptyCodexModelComposer(text+'Approve command?\n'),false);
  assert.equal(hasEmptyCodexModelComposer(text.replace('Ask Codex to do anything','A desktop draft')),false);
});
function fake(screen,overrides={}) {
  const calls=[];let currentScreen=screen;
  return {calls,setScreen:text=>currentScreen=text,call:async(method,args)=>{
    calls.push({method,args});
    if(method==='pane.get')return {pane:{...pane,...overrides}};
    if(method==='pane.read')return {read:{text:currentScreen}};
    if(method==='pane.send_keys'&&args.keys.includes('down'))currentScreen=fixture(1);
    return {};
  }};
}
test('opens only idle empty composer with one fixed slash command and no agent prompt',async()=>{
  const api=fake('› Ask Codex to do anything');
  await openCodexModelMenu(api,pane.pane_id,pane);
  assert.deepEqual(api.calls.at(-1),{method:'pane.send_input',args:{pane_id:pane.pane_id,text:'/model',keys:['enter']}});
  for(const status of ['working','blocked','unknown'])await assert.rejects(openCodexModelMenu(api,pane.pane_id,{...pane,agent_status:status}));
  const draft=fake('› my text');await assert.rejects(openCodexModelMenu(draft,pane.pane_id,pane));assert.equal(draft.calls.some(c=>c.method.startsWith('pane.send')),false);
});
test('selects dynamic menu only after observed cursor movement; cancel is Escape',async()=>{
  const api=fake(fixture(),{agent_status:'unknown'}),menuId=bindCodexModelMenu(detectCodexModelMenu(fixture()),pane).id;
  await actCodexModelMenu(api,pane.pane_id,pane,{menuId,option:1});
  assert.deepEqual(api.calls.filter(c=>c.method==='pane.send_keys').map(c=>c.args.keys),[['down'],['enter']]);
  await actCodexModelMenu(api,pane.pane_id,pane,{menuId,cancel:true});assert.deepEqual(api.calls.at(-1).args.keys,['esc']);
});
test('current Codex reasoning choice uses the native session-only key',async()=>{
  const screen=readFileSync(new URL('./fixtures/codex-reasoning-picker-0.158.txt',import.meta.url),'utf8');
  const api=fake(screen),menuId=bindCodexModelMenu(detectCodexModelMenu(screen),pane).id;
  await actCodexModelMenu(api,pane.pane_id,pane,{menuId,option:2});
  assert.deepEqual(api.calls.filter(c=>c.method==='pane.send_keys').map(c=>c.args.keys),[['s']]);
});
test('More reasoning opens its submenu; advanced choices apply to this session',async()=>{
  const reasoning=readFileSync(new URL('./fixtures/codex-reasoning-picker-0.158.txt',import.meta.url),'utf8')
    .replace('› 3. High','  3. High').replace('  5. More reasoning…','› 5. More reasoning…');
  const advanced=readFileSync(new URL('./fixtures/codex-advanced-reasoning-picker-0.158.txt',import.meta.url),'utf8');
  const first=fake(reasoning),firstId=bindCodexModelMenu(detectCodexModelMenu(reasoning),pane).id;
  await actCodexModelMenu(first,pane.pane_id,pane,{menuId:firstId,option:4});
  assert.deepEqual(first.calls.filter(c=>c.method==='pane.send_keys').map(c=>c.args.keys),[['enter']]);
  const second=fake(advanced),secondId=bindCodexModelMenu(detectCodexModelMenu(advanced),pane).id;
  await actCodexModelMenu(second,pane.pane_id,pane,{menuId:secondId,option:0});
  assert.deepEqual(second.calls.filter(c=>c.method==='pane.send_keys').map(c=>c.args.keys),[['s']]);
});
test('stale menu or changed pane never sends selection',async()=>{
  const menuId=bindCodexModelMenu(detectCodexModelMenu(fixture()),pane).id;
  for(const api of [fake(fixture().replace('another-model','changed-model')),fake(fixture(),{agent_session:'new'}),fake(fixture(),{agent_status:'working'})]) {
    await assert.rejects(actCodexModelMenu(api,pane.pane_id,pane,{menuId,option:1}));
    assert.equal(api.calls.some(c=>c.method==='pane.send_keys'),false);
  }
});

test('installed Codex 0.155.1 isolated native model picker is recognized',()=>{
  const text=readFileSync(new URL('./fixtures/codex-model-picker.txt',import.meta.url),'utf8');
  const menu=detectCodexModelMenu(text);
  assert.equal(menu.title,'Select Model and Effort');assert.equal(menu.options.length,5);assert.equal(menu.selectedIndex,0);
});
