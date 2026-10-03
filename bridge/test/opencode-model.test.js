import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {detectOpenCodeModelMenu,hasEmptyOpenCodeComposer,readOpenCodeModelMenu,openOpenCodeModelMenu,keyOpenCodeModelMenu,actOpenCodeModelMenu} from '../src/opencode-model.js';

// Source-derived OpenCode 1.18.32 model/variant rendering: selection has a
// background and bold style only; "current" is the configured model, not cursor.
export const menu=(selected=0,title='Select model')=>[
  `\x1b[48;2;24;24;24m  \x1b[1m${title}\x1b[22m 2                   esc\x1b[0m`,
  '', '  Search', '', '  \x1b[1mOpenAI\x1b[22m',
  ...['GPT example                     current','GPT other'].map((name,index)=>`\x1b[48;2;${selected===index?'60;70;90':'24;24;24'}m${selected===index?'\x1b[1m':''}  ${name}\x1b[0m`),
  '  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',''
].join('\n');
const pane=()=>({pane_id:'w1:p1',agent:'opencode',agent_status:'idle',cwd:'/project',terminal_id:'t1',agent_session:{value:'s1'}});
const conversation=fs.readFileSync(new URL('../../android/app/src/test/resources/opencode-phone-preview.txt',import.meta.url),'utf8');
function fake(text=fs.readFileSync(new URL('./fixtures/opencode-model-native.ansi',import.meta.url),'utf8'),initial=pane()) {
  const state={text,pane:initial}; const writes=[];
  const herdr={call:async(method,params)=>{
    if(method==='pane.get')return {pane:state.pane};
    if(method==='pane.read'){assert.equal(params.source,'visible');assert.equal(params.format,'ansi');assert.equal(params.strip_ansi,false);return {read:{text:state.text}};}
    writes.push({method,params});if(method==='pane.send_keys'&&params.keys[0]==='down')state.text=fs.readFileSync(new URL('./fixtures/opencode-model-native-down.ansi',import.meta.url),'utf8');if(method==='pane.send_input')state.text=state.text.replace(/  ┃\n(?=  ┃  Build ·)/g,'  ┃  /models\n');
    return {type:'ok'};
  }};
  return {herdr,state,writes};
}

test('OpenCode native menu preserves selection styling and never invents options',()=>{
  const first=detectOpenCodeModelMenu(menu()),second=detectOpenCodeModelMenu(menu(1));
  assert.equal(first.provider,'opencode');assert.equal(first.mode,'terminal');assert.equal(first.selectedIndex,-1);assert.deepEqual(first.options,[]);
  assert.equal(first.text,second.text);assert.notEqual(first.id,second.id);assert.match(first.ansi,/\x1b\[/);
  assert.equal(detectOpenCodeModelMenu(menu(0,'Select variant')).title,'Select variant');
});
test('OpenCode rejects unstyled, incomplete, filtered, historical and unsafe escape menus',()=>{
  for(const text of [menu().replace(/\x1b\[[0-9;]*m/g,''),menu().replace(/▀/g,''),menu().replace('Search','my filter'),menu()+'› active composer',menu()+'\x1b[2J'])assert.equal(detectOpenCodeModelMenu(text),null);
});
test('OpenCode recognizes captured blank conversation composer and rejects drafts and modal overlays',()=>{
  assert.equal(hasEmptyOpenCodeComposer(conversation),true);
  assert.equal(hasEmptyOpenCodeComposer(conversation.replace(/\n/g,'\r\n')),true);
  assert.equal(hasEmptyOpenCodeComposer(conversation.replace(/  ┃\n(?=  ┃  Build ·)/g,'  ┃  keep this draft\n')),false);
  assert.equal(hasEmptyOpenCodeComposer('  Select model 2 esc\n'+conversation),false);
  assert.equal(hasEmptyOpenCodeComposer(conversation.replace('ctrl+p commands','esc interrupt')),false);
});
test('OpenCode opens native /models without prompting or restarting agent',async()=>{
  const f=fake(conversation);await openOpenCodeModelMenu(f.herdr,'w1:p1',f.state.pane);
  assert.deepEqual(f.writes,[{method:'pane.send_input',params:{pane_id:'w1:p1',text:'/models'}},{method:'pane.send_keys',params:{pane_id:'w1:p1',keys:['enter']}}]);
  for(const state of ['working','blocked']){const other=fake(conversation,{...pane(),agent_status:state});await assert.rejects(openOpenCodeModelMenu(other.herdr,'w1:p1',other.state.pane));assert.equal(other.writes.length,0);}
});
test('OpenCode navigation is fixed-key, identity-bound and invalidates stale highlight',async()=>{
  const f=fake();const initial=await readOpenCodeModelMenu(f.herdr,'w1:p1',f.state.pane);
  assert.equal(initial.mode,'options');
  await keyOpenCodeModelMenu(f.herdr,'w1:p1',f.state.pane,{menuId:initial.id,key:'down'});
  await assert.rejects(keyOpenCodeModelMenu(f.herdr,'w1:p1',f.state.pane,{menuId:initial.id,key:'enter'}));
  const fresh=await readOpenCodeModelMenu(f.herdr,'w1:p1',f.state.pane);
  assert.equal(fresh.selectedIndex,1);
  await assert.rejects(keyOpenCodeModelMenu(f.herdr,'w1:p1',f.state.pane,{menuId:fresh.id,key:'ctrl+c'}));
  f.state.pane={...f.state.pane,terminal_id:'replacement'};
  await assert.rejects(keyOpenCodeModelMenu(f.herdr,'w1:p1',f.state.pane,{menuId:fresh.id,key:'esc'}));
  assert.deepEqual(f.writes.map(write=>write.params.keys),[['down']]);
});
test('OpenCode taps an observed name, verifies the new highlight, then confirms once',async()=>{
  const f=fake();const current=await readOpenCodeModelMenu(f.herdr,'w1:p1',f.state.pane);
  assert.equal(current.options[1],'Recent · Muse Spark 1.3 Free OpenCode Zen · Free');
  await actOpenCodeModelMenu(f.herdr,'w1:p1',f.state.pane,{menuId:current.id,option:1});
  assert.deepEqual(f.writes.map(write=>write.params.keys),[['down'],['enter']]);
  await assert.rejects(actOpenCodeModelMenu(f.herdr,'w1:p1',f.state.pane,{menuId:current.id,option:1}));
});
test('OpenCode does not confirm when the native highlight fails to move',async()=>{
  const screen=fs.readFileSync(new URL('./fixtures/opencode-model-native.ansi',import.meta.url),'utf8');
  const writes=[];const herdr={call:async(method,params)=>{
    if(method==='pane.get')return {pane:pane()};
    if(method==='pane.read')return {read:{text:screen}};
    writes.push({method,params});return {};
  }};
  const current=await readOpenCodeModelMenu(herdr,'w1:p1',pane());
  await assert.rejects(actOpenCodeModelMenu(herdr,'w1:p1',pane(),{menuId:current.id,option:1}));
  assert.deepEqual(writes.map(write=>write.params.keys),[['down']]);
});
test('OpenCode cancellation and stale identity never select an option',async()=>{
  const f=fake();const current=await readOpenCodeModelMenu(f.herdr,'w1:p1',f.state.pane);
  await assert.rejects(actOpenCodeModelMenu(f.herdr,'w1:p1',f.state.pane,{menuId:current.id,option:100}));
  await actOpenCodeModelMenu(f.herdr,'w1:p1',f.state.pane,{menuId:current.id,cancel:true});
  assert.deepEqual(f.writes.map(write=>write.params.keys),[['esc']]);
});

const captured=name=>fs.readFileSync(new URL('./fixtures/'+name,import.meta.url),'utf8');
test('OpenCode actual captured modal yields visible model names and highlighted row',()=>{
  const first=detectOpenCodeModelMenu(captured('opencode-model-native.ansi'));
  const next=detectOpenCodeModelMenu(captured('opencode-model-native-down.ansi'));
  assert.ok(first);assert.ok(next);assert.notEqual(first.id,next.id);
  assert.equal(first.mode,'options');assert.equal(first.selectedIndex,0);assert.equal(next.selectedIndex,1);
  assert.equal(first.options.length,10);assert.deepEqual(first.options,next.options);
  assert.equal(first.options.some(option=>option.includes('Ask anything')||option.includes('~/project')),false);
  assert.notEqual(detectOpenCodeModelMenu(captured('opencode-model-native.ansi').replaceAll('48;2;250;178;131','48;2;20;20;20'))?.mode,'options');
  assert.equal(hasEmptyOpenCodeComposer(captured('opencode-model-empty.ansi')),true);
  assert.equal(hasEmptyOpenCodeComposer(captured('opencode-model-command.ansi')),false);
});
test('OpenCode staged paste observes its exact native command before one Enter',async()=>{
  const writes=[];let text=captured('opencode-model-empty.ansi');
  const herdr={call:async(method,params)=>{
    if(method==='pane.get')return {pane:pane()};
    if(method==='pane.read')return {read:{text}};
    writes.push({method,params});if(method==='pane.send_input')text=captured('opencode-model-command.ansi');return {};
  }};
  await openOpenCodeModelMenu(herdr,'w1:p1',pane());
  assert.deepEqual(writes.map(write=>[write.method,write.params.keys]),[['pane.send_input',undefined],['pane.send_keys',['enter']]]);
});
