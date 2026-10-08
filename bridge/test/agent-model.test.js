import test from 'node:test';
import assert from 'node:assert/strict';
import {detectClaudeModelMenu,detectClaudeModelConfirm,bindAgentModelMenu,hasEmptyClaudeModelComposer,openAgentModelMenu,actAgentModelMenu} from '../src/agent-model.js';
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
  assert.deepEqual(api.calls.find(c=>c.method==='pane.send_input'),{method:'pane.send_input',args:{pane_id:pane.pane_id,text:'/model',keys:['enter']}});
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

test('Claude 2.1.292 scrolling picker windows share one list and one identity',async()=>{
  const {readFileSync}=await import('node:fs');
  const {mergeClaudeModelWindow}=await import('../src/agent-model.js');
  const read=name=>detectClaudeModelMenu(readFileSync(new URL(`./fixtures/claude-model-picker-window-${name}.txt`,import.meta.url),'utf8'));
  const p={...pane,pane_id:'merge-pane'};
  const [top,middle,bottom]=['top','middle','bottom'].map(read);
  assert.deepEqual([top,middle,bottom].map(m=>[m.options.length,m.selectedIndex,m.window.start]),[[12,3,0],[12,2,1],[12,11,2]]);
  assert.equal(top.id,middle.id);assert.equal(top.id,bottom.id);
  assert.equal(mergeClaudeModelWindow(top,p).options[11],'Model 12');
  mergeClaudeModelWindow(middle,p);
  const full=mergeClaudeModelWindow(bottom,p);
  assert.equal(full.window,undefined);
  assert.match(full.options[0],/^Default/);assert.match(full.options[10],/^Opus 4\.6/);assert.match(full.options[11],/^Sonnet 4\.6/);
  assert.ok(full.options.every(label=>!/^Model \d+$/.test(label)));
  assert.equal(mergeClaudeModelWindow(top,p).id,full.id);
  // A clipped window without a hidden-row count is not a verified shape.
  assert.equal(detectClaudeModelMenu(readFileSync(new URL('./fixtures/claude-model-picker-window-middle.txt',import.meta.url),'utf8').replace(/\s*… \+1 model\n/,'\n')),null);
});

test('empty Claude composer is recognized under custom status lines and placeholders',async()=>{
  const {readFileSync}=await import('node:fs');
  assert.equal(hasEmptyClaudeModelComposer(readFileSync(new URL('./fixtures/claude-custom-status-empty-composer.txt',import.meta.url),'utf8')),true);
  assert.equal(hasEmptyClaudeModelComposer('────\n❯ Try "how does foo.js work?"\n────\n  [Sonnet 5.5] 0% ctx | 5h 8%\n  ⏵⏵ auto mode on'),true);
  assert.equal(hasEmptyClaudeModelComposer('────\n❯ half typed\n────\n  status'),false);
  assert.equal(hasEmptyClaudeModelComposer('────\n❯\nsecond draft line\n────'),false);
});

test('Claude dim prompt suggestions do not count as a desktop draft',()=>{
  const screen=suggestion=>`────\n❯\u00a0${suggestion}\n────\n  [Opus 4.6] 18% ctx\n  ⏵⏵ auto mode on`;
  assert.equal(hasEmptyClaudeModelComposer(screen('\x1b[0m\x1b[2mcommit this\x1b[0m')),true);
  assert.equal(hasEmptyClaudeModelComposer(screen('commit this')),false);
  assert.equal(hasEmptyClaudeModelComposer(screen('\x1b[0mreal draft\x1b[0m')),false);
});

// A 12-model picker that scrolls like Claude Code 2.1.292: ten visible rows,
// absolute numbering, arrows on clipped edges and a hidden-below count.
function scrollingClaude(names,cursor) {
  let start=0,open=false;
  const calls=[];
  const clamp=()=>{if(cursor<start+1&&start>0)start=cursor-1;if(cursor>start+9)start=cursor-9;start=Math.max(0,Math.min(start,names.length-10));};
  clamp();
  const render=()=>{
    if(!open)return '────\n❯ \n────\n  [Opus 4.6] 0% ctx\n  ⏵⏵ auto mode on';
    const end=Math.min(names.length,start+10),rows=[];
    for(let i=start;i<end;i++) {
      const mark=i===cursor?'❯':i===start&&start>0?'↑':i===end-1&&end<names.length?'↓':' ';
      rows.push(`   ${mark} ${(String(i+1)+'.').padEnd(3)} ${names[i]}`);
    }
    const hidden=names.length-end;
    return ['   Select model','   Switch between Claude models.',...rows,...(hidden?[`      … +${hidden} model${hidden>1?'s':''}`]:[]),'   ● High effort ←/→ to adjust','   Enter to set as default · s to use this session only · Esc to cancel'].join('\n');
  };
  return {calls,get cursor(){return cursor;},herdr:{call:async(method,args)=>{
    calls.push({method,args});
    if(method==='pane.get')return {pane:{...pane,pane_id:args.pane_id}};
    if(method==='pane.read')return {read:{text:render()}};
    if(method==='pane.send_input'){open=true;return {};}
    if(method==='pane.send_keys'){for(const key of args.keys){if(key==='down')cursor=Math.min(names.length-1,cursor+1);if(key==='up')cursor=Math.max(0,cursor-1);clamp();}return {};}
    return {};
  }}};
}

test('opening the Claude picker learns every model even when the cursor starts deep in the list',async()=>{
  const names=Array.from({length:12},(_,i)=>`Model-${i+1}-name   description ${i+1}`);
  const sim=scrollingClaude(names,10);
  const p={...pane,pane_id:'scan-pane'};
  assert.deepEqual(await openAgentModelMenu(sim.herdr,p.pane_id,p),{opened:true});
  const {readAgentModelMenu}=await import('../src/agent-model.js');
  const menu=await readAgentModelMenu(sim.herdr,p.pane_id,p);
  assert.equal(menu.options.length,12);
  assert.ok(menu.options.every((label,i)=>label.startsWith(`Model-${i+1}-name`)),menu.options.join('|'));
  assert.equal(menu.selectedIndex,10);assert.equal(sim.cursor,10);
  // Choosing a hidden row scrolls natively and confirms with the session-only key.
  await actAgentModelMenu(sim.herdr,p.pane_id,p,{menuId:menu.id,option:0});
  assert.equal(sim.cursor,0);
  assert.deepEqual(sim.calls.filter(c=>c.method==='pane.send_keys').at(-1).args.keys,['s']);
});

test('Claude mid-conversation switch confirmation is a verified second stage answered with enter',async()=>{
  const {readFileSync}=await import('node:fs');
  const text=readFileSync(new URL('./fixtures/claude-switch-model-confirm.txt',import.meta.url),'utf8');
  const confirm=detectClaudeModelConfirm(text);
  assert.deepEqual([confirm.stage,confirm.title,confirm.options,confirm.selectedIndex,confirm.provider],['confirm','Switch model?',['Yes, switch to Haiku 4.5','No, go back'],0,'claude']);
  assert.match(confirm.note,/^Your next response will be slower and use more tokens\nThis conversation is cached/);
  // The model picker and the dialog never masquerade as each other.
  assert.equal(detectClaudeModelMenu(text),null);
  assert.equal(detectClaudeModelConfirm(readFileSync(new URL('./fixtures/claude-model-picker-window-top.txt',import.meta.url),'utf8')),null);
  assert.equal(detectClaudeModelConfirm(text+'\n❯ new prompt'),null);
  assert.equal(detectClaudeModelConfirm(text.replace('2. No, go back','2. Maybe')),null);
  // Choosing moves the highlight and answers with Enter, never the picker's session key.
  let screen=text;const calls=[];
  const api={calls,call:async(method,args)=>{
    calls.push({method,args});
    if(method==='pane.get')return {pane:{...pane}};
    if(method==='pane.read')return {read:{text:screen}};
    if(method==='pane.send_keys'&&args.keys.includes('down'))screen=text.replace('❯ 1. Yes','  1. Yes').replace('  2. No','❯ 2. No');
    return {};
  }};
  const menuId=bindAgentModelMenu(detectClaudeModelConfirm(text),pane).id;
  await actAgentModelMenu(api,pane.pane_id,pane,{menuId,option:1});
  assert.deepEqual(api.calls.filter(c=>c.method==='pane.send_keys').map(c=>c.args.keys),[['down'],['enter']]);
});
