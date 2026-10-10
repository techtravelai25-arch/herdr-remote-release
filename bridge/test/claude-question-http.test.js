import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createBridge} from '../src/server.js';
import {detectClaudeQuestion} from '../src/claude-question.js';

const route='/v1/panes/w1%3Ap1';
const authored=['Read local text files Use files on this machine.',
  'Read scanned pages locally Use the installed OCR program.',
  'Add online OCR now Page images leave this machine.',
  'Leave uploads unread Files continue showing their names.'];
const writes=calls=>calls.filter(call=>call.method.startsWith('pane.send_'));
// Sanitized from the current 2.1.295 AskUserQuestion screen: tabs, prompt
// gutter, numbered descriptions, custom editor, chat row and exact key hint.
const menu=(selected=0,prompt='How should uploads be read?',draft='')=>`←  ☐ Uploads  ☐ Organize by  ☐ Cross-item  ✔ Submit  →

│ ${prompt}
│
${selected===0?'❯':' '} 1. Read local text files
     Use files on this machine.
${selected===1?'❯':' '} 2. Read scanned pages locally
     Use the installed OCR program.
${selected===2?'❯':' '} 3. Add online OCR now
     Page images leave this machine.
${selected===3?'❯':' '} 4. Leave uploads unread
     Files continue showing their names.
${selected===4?'❯':' '} 5. ${draft||(selected===4?'\u001b[7mT\u001b[27mype something.':'\u001b[38;5;246mType something.\u001b[39m')}
─────────────────────
${selected===5?'❯':' '} 6. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel`;
const multiMenu=(selected=0,checked=[],draft='')=>`←  ${checked.length?'☑':'☐'} Features  ✔ Submit  →

│ Which local features should this test enable?
│
${selected===0?'❯':' '} 1. [${checked.includes(0)?'✔':' '}] Search notes
     Read local notes.
${selected===1?'❯':' '} 2. [${checked.includes(1)?'✔':' '}] Search pages
     Read saved pages.
${selected===2?'❯':' '} 3. [${checked.includes(2)?'✔':' '}] Search files
     Read local files.
${selected===3?'❯':' '} 4. [${checked.includes(3)?'✔':' '}] Search scans
     Read local scans.
${selected===4?'❯':' '} 5. [${checked.includes(4)?'✔':' '}] ${draft||(selected===4?'\u001b[7mT\u001b[27mype something':'\u001b[38;5;246mType something\u001b[39m')}
${selected===5?'❯':' '}    Submit
Enter to select · Tab/Arrow keys to navigate · Esc to cancel`;
const review=()=>`←  ☒ Features  ✔ Submit  →

Review your answers
 ● Which local features should this test enable?
   → Search notes, Search pages
Ready to submit your answers?
❯ 1. Submit answers
  2. Cancel`;
// Captured from an isolated Claude Code 2.1.295 PTY backed by a local fake
// Anthropic API. One question uses a compact header and a different footer.
const nativeSingle=`────────────────────────────────────────────────────────────────────────
 ☐ Fixture

How should the local fixture proceed?

❯ 1. Keep local
     Use local fixture data.
  2. Use sample
     Use synthetic sample data.
  3. \u001b[38;5;246mType something.\u001b[39m
────────────────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel`;
const nativeMulti=`────────────────────────────────────────────────────────────────────────
←  ☐ Fixture  ✔ Submit  →

How should the local fixture proceed?

❯ 1. [ ] Keep local
         Use local fixture data.
  2. [ ] Use sample
         Use synthetic sample data.
  3. [ ] \u001b[38;5;246mType something\u001b[39m
     Submit
────────────────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel`;

// Sanitized from the Claude Code 2.1.296 first-run workspace trust screen.
// The visible pane.read ANSI frame uses carriage returns without line feeds.
const trustMenu=(folder,selected=0)=>[
  '\u001b[38;5;220m────────────────────────────────────────────────────────────────────────\u001b[0m',
  ' Accessing workspace:', '', ` ${folder}`, '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
  " project, or work from your team). If not, take a moment to review what's in this folder first.",
  '', " Claude Code'll be able to read, edit, and execute files here.",
  '', ' Security guide', '',
  ` ${selected===0?'❯':' '} No, exit`,
  ` ${selected===1?'❯':' '} Yes, I trust this folder`,
  '', ' Enter to confirm · Esc to cancel',
].join('\r');

async function fixture(t,{onWrite,mode='single'}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-question-http-'));
  const pane={pane_id:'w1:p1',workspace_id:'w1',tab_id:'t1',cwd:dir,agent:'claude',
    agent_status:mode==='trust'?'unknown':'blocked',terminal_id:'term',
    agent_session:mode==='trust'?null:{value:'test-session'}};
  const state={selected:0,prompt:'How should uploads be read?',kind:mode==='trust'?'trust':'menu',mode,
    draft:'',checked:[],truncated:false,override:null,homeCaret:false};
  const calls=[];
  const screen=()=>state.override??(state.kind==='shell'?`fixture@localhost:${dir}$ `:state.kind==='trust'?trustMenu(dir,state.selected):state.kind==='review'?review():state.kind==='menu'
    ?(state.mode==='multi'?multiMenu(state.selected,state.checked,state.draft)
      :state.homeCaret&&state.draft==='Type something.'
        ?menu(state.selected,state.prompt,state.draft).replace('5. Type something.',
          '5. \u001b[7mT\u001b[27mype something.')
        :menu(state.selected,state.prompt,state.draft)):'❯\n──────────────────────\n? for shortcuts');
  const herdr={call:async(method,params={})=>{
    calls.push({method,params});
    if(method==='session.snapshot')return {snapshot:{protocol:22,workspaces:[{workspace_id:'w1'}],panes:[pane],agents:[pane]}};
    if(method==='pane.get')return {pane};
    if(method==='pane.read')return {read:{text:screen(),revision:1,truncated:state.truncated}};
    if(method==='pane.send_keys') {
      if(params.keys[0]==='down')state.selected++;
      if(params.keys[0]==='up')state.selected--;
      if(params.keys[0]==='backspace'){
        state.draft=state.homeCaret?state.draft.slice(1):state.draft.slice(0,-1);
        if(state.mode==='multi'&&state.selected===4&&!state.draft)
          state.checked=state.checked.filter(index=>index!==4);
      }
      if(params.keys[0]==='esc')state.kind='done';
      if(params.keys[0]==='enter') {
        if(state.kind==='trust') {
          if(state.selected===0){state.kind='shell';pane.agent=undefined;}
          else state.kind='done';
        }
        else if(state.kind==='review')state.kind='done';
        else if(state.mode==='multi') {
          if(state.selected===5)state.kind='review';
          else if(state.selected<4)state.checked=state.checked.includes(state.selected)
            ?state.checked.filter(index=>index!==state.selected):[...state.checked,state.selected];
          else if(state.draft)state.checked=state.checked.includes(4)
            ?state.checked.filter(index=>index!==4):[...state.checked,4];
        } else if(state.selected!==4||state.draft)state.kind='done';
      }
    }
    if(method==='pane.send_text'){
      state.draft=state.homeCaret?params.text+state.draft:state.draft+params.text;
      if(state.mode==='multi'&&state.selected===4&&state.draft&&!state.checked.includes(4))
        state.checked.push(4);
    }
    if(method.startsWith('pane.send_'))await onWrite?.(method,params,state,pane);
    return {type:'ok'};
  }};
  const config={socketPath:'/unused',stateDir:path.join(dir,'state'),projects:[],allowTerminalInput:false};
  const start=async()=>{const app=createBridge(config,{herdr});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');return app;};
  let app=await start();
  const first=app.store.pair(app.store.pairCode(),'first');
  const second=app.store.pair(app.store.pairCode(),'second');
  const request=(token,endpoint,method='GET',body)=>fetch(`http://127.0.0.1:${app.server.address().port}${endpoint}`,{
    method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const attach=async(token=first.token)=>{const response=await request(token,`${route}/output`);assert.equal(response.status,200);return response.json();};
  const restart=async()=>{await app.close();app=await start();};
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {pane,state,calls,first,second,request,attach,restart};
}

test('Claude AskUserQuestion is a structured card without passive input',async t=>{
  const f=await fixture(t);
  const output=await f.attach();
  assert.equal(output.question?.prompt,'How should uploads be read?');
  assert.deepEqual(output.question?.options,[...authored,'Type something.','Chat about this']);
  assert.equal(output.question?.cancelAvailable,true);
  assert.equal(output.question?.selectedIndex,0);
  assert.equal(output.question?.stage,'choices');
  assert.equal(output.questionReviewAvailable,false);
  assert.equal(writes(f.calls).length,0);
  const body={operationId:'claude-answer-001',attachmentId:output.attachmentId,questionId:output.question.id,option:2};
  const answer=await f.request(f.first.token,`${route}/answer`,'POST',body);
  assert.equal(answer.status,200);
  assert.deepEqual(writes(f.calls).map(call=>call.params.keys),[['down'],['down'],['enter']]);
  assert.equal((await f.attach()).question,undefined);
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {...body,operationId:'claude-answer-replay-002'})).status,409);
});

test('Claude answer rejects a changed cursor or question before input',async t=>{
  const f=await fixture(t);
  const output=await f.attach();
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-text-not-verified-001',attachmentId:output.attachmentId,
      questionId:output.question.id,text:'Unverified free text'})).status,400);
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-malformed-option-001',attachmentId:output.attachmentId,
      questionId:output.question.id,option:'garbage',cancel:true})).status,400);
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-malformed-cancel-001',attachmentId:output.attachmentId,
      questionId:output.question.id,cancel:false})).status,400);
  f.state.selected=1;
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-stale-cursor-001',attachmentId:output.attachmentId,
      questionId:output.question.id,option:2})).status,409);
  assert.equal(writes(f.calls).length,0);
  f.state.selected=0;f.state.prompt='A different question?';
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-stale-question-001',attachmentId:output.attachmentId,
      questionId:output.question.id,option:2})).status,409);
  assert.equal(writes(f.calls).length,0);
});

test('Claude question retirement survives a bridge restart and rejects a second phone',async t=>{
  const f=await fixture(t);
  const first=await f.attach(),second=await f.attach(f.second.token);
  assert.notEqual(first.question.id,second.question.id);
  const answer=await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-first-001',attachmentId:first.attachmentId,questionId:first.question.id,option:0});
  assert.equal(answer.status,200);
  f.state.kind='menu';
  assert.equal((await f.attach(f.second.token)).questionAwaitingTransition,true);
  await f.restart();
  assert.equal((await f.attach()).questionAwaitingTransition,true);
  assert.equal((await f.request(f.second.token,`${route}/answer`,'POST',
    {operationId:'claude-second-001',attachmentId:second.attachmentId,questionId:second.question.id,option:1})).status,409);
  f.state.kind='done';
  assert.equal((await f.attach()).questionAwaitingTransition,false);
});

test('incomplete, quoted, truncated, or native control rows do not authorize an answer',async t=>{
  const f=await fixture(t);
  const wrapped=menu(2).replace('· Esc to cancel','\n│   · Esc to cancel')
    .replace('❯ 3.','\u001b[1m❯ 3.\u001b[0m');
  assert.equal(detectClaudeQuestion(wrapped)?.selectedIndex,2);
  assert.equal(detectClaudeQuestion('Here is an old menu:\n'+menu()+'\n❯ New prompt'),null);
  assert.equal(detectClaudeQuestion(menu().replace('6. Chat about this','6. Something else')),null);
  assert.equal(detectClaudeQuestion(menu().replace('2. Read scanned pages locally','7. Read scanned pages locally')),null);
  assert.equal(detectClaudeQuestion('1. Old answer\n2. Old answer\n'+menu())?.selectedIndex,0);
  assert.equal(detectClaudeQuestion(menu().replace('│ How should uploads be read?',
    Array.from({length:13},(_,index)=>`│ Question line ${index+1}`).join('\n'))),null);
  assert.equal(detectClaudeQuestion(review()+'\n❯ New prompt'),null);
  assert.deepEqual(detectClaudeQuestion(nativeSingle)?.options,
    ['Keep local Use local fixture data.','Use sample Use synthetic sample data.',
      'Type something.','Chat about this']);
  assert.equal(detectClaudeQuestion(nativeSingle)?.prompt,'How should the local fixture proceed?');
  assert.deepEqual(detectClaudeQuestion(nativeMulti)?.options,
    ['Keep local Use local fixture data.','Use sample Use synthetic sample data.',
      'Type something','Submit','Chat about this']);
  assert.equal(detectClaudeQuestion(nativeMulti)?.multiSelect,true);
  assert.equal(detectClaudeQuestion(menu(4))?.stage,'text');
  assert.equal(detectClaudeQuestion(menu(4).replace('· Esc to cancel',
    '· ctrl+g to edit in Vim · Esc to cancel'))?.stage,'text');
  assert.equal(detectClaudeQuestion(menu(4,'How should uploads be read?','Type something.'))?.otherDraft,
    'Type something.');
  f.state.truncated=true;
  assert.equal((await f.attach()).question,undefined);
  f.state.truncated=false;f.state.override=menu().replace('❯ 1.','  1.');
  assert.equal((await f.attach()).question,undefined);
  assert.equal(writes(f.calls).length,0);
});

test('Claude review is unavailable and a changed menu during navigation cannot receive Enter',async t=>{
  const f=await fixture(t,{onWrite:(method,params,state)=>{
    if(method==='pane.send_keys'&&params.keys[0]==='down')state.prompt='A new question?';
  }});
  const output=await f.attach();
  assert.equal((await f.request(f.first.token,`${route}/question-review`,'POST',
    {operationId:'claude-review-001',attachmentId:output.attachmentId})).status,409);
  assert.equal(writes(f.calls).length,0);
  const response=await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-mid-navigation-001',attachmentId:output.attachmentId,
      questionId:output.question.id,option:2});
  assert.equal(response.status,409);
  assert.deepEqual(writes(f.calls).map(call=>call.params.keys),[['down']]);
});

test('Claude inline custom answer opens, verifies its draft, then submits',async t=>{
  const f=await fixture(t);
  const first=await f.attach();
  const opened=await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-open-custom-001',attachmentId:first.attachmentId,
      questionId:first.question.id,option:4});
  assert.equal(opened.status,200);
  assert.equal(f.state.kind,'menu');
  assert.equal(f.state.selected,4);
  const textStage=await f.attach();
  assert.equal(textStage.question.stage,'text');
  assert.equal(textStage.question.freeText,true);
  assert.deepEqual(textStage.question.options,[]);
  assert.equal(textStage.question.cancelAvailable,true);
  const sent=await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-send-custom-001',attachmentId:textStage.attachmentId,
      questionId:textStage.question.id,text:'Use local preview only'});
  assert.equal(sent.status,200);
  assert.equal(f.state.kind,'done');
  assert.deepEqual(writes(f.calls).at(-2).params,{pane_id:'w1:p1',text:'Use local preview only'});
  assert.deepEqual(writes(f.calls).at(-1).params.keys,['enter']);
});

test('literal placeholder desktop draft never accepts appended phone text',async t=>{
  const f=await fixture(t);
  f.state.selected=4;
  f.state.draft='Type something.';
  assert.equal((await f.attach()).question,undefined);
  assert.equal(writes(f.calls).length,0);
});

test('literal placeholder with caret at Home is probed and restored without appending',async t=>{
  const f=await fixture(t);
  f.state.selected=4;
  f.state.draft='Type something.';
  f.state.homeCaret=true;
  const editor=await f.attach();
  assert.equal(editor.question?.stage,'text');
  const result=await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-literal-home-001',attachmentId:editor.attachmentId,
      questionId:editor.question.id,text:'Phone answer'});
  assert.equal(result.status,409);
  assert.equal(f.state.draft,'Type something.');
  assert.deepEqual(writes(f.calls).map(call=>call.method==='pane.send_text'
    ?call.params.text:call.params.keys[0]),['x','backspace']);
});

test('custom probe rejects a changed native focus before further input',async t=>{
  const f=await fixture(t,{onWrite:(method,params,state)=>{
    if(method==='pane.send_text'&&params.text==='x')state.selected=3;
  }});
  f.state.selected=4;
  const editor=await f.attach();
  assert.equal(editor.question?.stage,'text');
  const result=await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-probe-focus-001',attachmentId:editor.attachmentId,
      questionId:editor.question.id,text:'Phone answer'});
  assert.equal(result.status,409);
  assert.deepEqual(writes(f.calls).map(call=>call.method==='pane.send_text'
    ?call.params.text:call.params.keys[0]),['x']);
});

test('custom probe preserves concurrent desktop typing without deleting it',async t=>{
  const f=await fixture(t,{onWrite:(method,params,state)=>{
    if(method==='pane.send_text'&&params.text==='x')state.draft+='desktop';
  }});
  f.state.selected=4;
  const editor=await f.attach();
  const result=await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-probe-draft-001',attachmentId:editor.attachmentId,
      questionId:editor.question.id,text:'Phone answer'});
  assert.equal(result.status,409);
  assert.equal(f.state.draft,'xdesktop');
  assert.deepEqual(writes(f.calls).map(call=>call.method==='pane.send_text'
    ?call.params.text:call.params.keys[0]),['x']);
});

test('Claude chat and cancel actions use distinct verified paths',async t=>{
  const f=await fixture(t);
  const first=await f.attach();
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-chat-001',attachmentId:first.attachmentId,
      questionId:first.question.id,option:5})).status,200);
  assert.equal(f.state.kind,'done');
  assert.deepEqual(writes(f.calls).at(-1).params.keys,['enter']);
  await f.attach();
  f.state.kind='menu';f.state.selected=0;
  const fresh=await f.attach();
  assert.equal(fresh.question?.cancelAvailable,true);
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-cancel-001',attachmentId:fresh.attachmentId,
      questionId:fresh.question.id,cancel:true})).status,200);
  assert.deepEqual(writes(f.calls).at(-1).params.keys,['esc']);
});

test('Claude multi-select toggles native checkboxes and submits through review',async t=>{
  const f=await fixture(t,{mode:'multi'});
  const first=await f.attach();
  assert.equal(first.question.stage,'multi');
  assert.equal(first.question.multiSelect,true);
  assert.deepEqual(first.question.selectedOptions,[]);
  assert.deepEqual(first.question.options.slice(-2),['Type something','Submit']);
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-multi-toggle-001',attachmentId:first.attachmentId,
      questionId:first.question.id,option:1})).status,200);
  const toggled=await f.attach();
  assert.deepEqual(toggled.question.selectedOptions,[1]);
  assert.equal(toggled.question.selectedIndex,1);
  assert.notEqual(toggled.question.id,first.question.id);
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-multi-submit-001',attachmentId:toggled.attachmentId,
      questionId:toggled.question.id,option:5})).status,200);
  const reviewStage=await f.attach();
  assert.equal(reviewStage.question?.stage,'review');
  assert.match(reviewStage.question?.prompt,/Which local features should this test enable\?/);
  assert.deepEqual(reviewStage.question?.options,['Submit answers']);
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-review-submit-001',attachmentId:reviewStage.attachmentId,
      questionId:reviewStage.question.id,option:0})).status,200);
  assert.equal(f.state.kind,'done');
});

test('Claude multi-select rejects a changed checkbox while moving the cursor',async t=>{
  const f=await fixture(t,{mode:'multi',onWrite:(method,params,state)=>{
    if(method==='pane.send_keys'&&params.keys[0]==='down')state.checked=[2];
  }});
  const shown=await f.attach();
  const result=await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-multi-stale-001',attachmentId:shown.attachmentId,
      questionId:shown.question.id,option:2});
  assert.equal(result.status,409);
  assert.deepEqual(writes(f.calls).map(call=>call.params.keys),[['down']]);
});

test('Claude accepted custom multi-select value stays visible and can reach Submit',async t=>{
  const f=await fixture(t,{mode:'multi'});
  const first=await f.attach();
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-multi-custom-open-001',attachmentId:first.attachmentId,
      questionId:first.question.id,option:4})).status,200);
  const editor=await f.attach();
  assert.equal(editor.question.stage,'text');
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-multi-custom-write-001',attachmentId:editor.attachmentId,
      questionId:editor.question.id,text:'Use local previews'})).status,200);
  const accepted=await f.attach();
  assert.equal(accepted.question.stage,'multi');
  assert.equal(accepted.question.options[4],'Custom: Use local previews');
  assert.deepEqual(accepted.question.selectedOptions,[4]);
  assert.equal(accepted.question.selectedIndex,4);
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-multi-custom-uncheck-001',attachmentId:accepted.attachmentId,
      questionId:accepted.question.id,option:4})).status,200);
  const unchecked=await f.attach();
  assert.equal(unchecked.question.stage,'multi');
  assert.equal(unchecked.question.options[4],'Custom: Use local previews');
  assert.deepEqual(unchecked.question.selectedOptions,[]);
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-multi-custom-recheck-001',attachmentId:unchecked.attachmentId,
      questionId:unchecked.question.id,option:4})).status,200);
  const rechecked=await f.attach();
  assert.deepEqual(rechecked.question.selectedOptions,[4]);
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-multi-custom-submit-001',attachmentId:rechecked.attachmentId,
      questionId:rechecked.question.id,option:5})).status,200);
  assert.equal((await f.attach()).question.stage,'review');
});

test('old composer above a partial Claude menu does not clear retirement',async t=>{
  const f=await fixture(t);
  const first=await f.attach();
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-retire-001',attachmentId:first.attachmentId,
      questionId:first.question.id,option:0})).status,200);
  f.state.override='❯\n? for shortcuts\n←  ☐ Uploads  ✔ Submit  →\n│ New question?';
  assert.equal((await f.attach()).questionAwaitingTransition,true);
  f.state.override=menu();
  assert.equal((await f.attach()).questionAwaitingTransition,true);
});

test('Claude startup trust is a full native choice card and only an explicit Trust dispatches it',async t=>{
  const f=await fixture(t,{mode:'trust'});
  assert.equal(f.pane.agent_status,'unknown');
  assert.equal(f.pane.agent_session,null);
  const parsed=detectClaudeQuestion(trustMenu(f.pane.cwd));
  assert.equal(parsed?.kind,'claude_trust');
  assert.equal(parsed?.selectedIndex,0);
  assert.deepEqual(parsed?.options,['No, exit','Yes, I trust this folder']);
  const shown=await f.attach();
  assert.equal(shown.question?.kind,'claude_trust');
  assert.equal(shown.question?.stage,'choices');
  assert.equal(shown.question?.selectedIndex,0);
  assert.equal(shown.question?.cancelAvailable,false);
  assert.match(shown.question.prompt,/Accessing workspace:\n/);
  assert.ok(shown.question.prompt.includes(f.pane.cwd));
  assert.match(shown.question.prompt,/Quick safety check:.*review what's in this folder first\./s);
  assert.match(shown.question.prompt,/Claude Code'll be able to read, edit, and execute files here\./);
  assert.match(shown.question.prompt,/Security guide/);
  assert.equal(writes(f.calls).length,0);
  const body={operationId:'claude-trust-explicit-001',attachmentId:shown.attachmentId,
    questionId:shown.question.id,option:1};
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',body)).status,200);
  assert.deepEqual(writes(f.calls).map(call=>call.params.keys),[['down'],['enter']]);
  assert.equal(f.state.kind,'done');
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {...body,operationId:'claude-trust-replay-002'})).status,409);
});

test('Claude startup trust rejects hidden, changed and incomplete prompts without confirming',async t=>{
  const f=await fixture(t,{mode:'trust'});
  const shown=await f.attach();
  assert.equal(shown.question?.kind,'claude_trust');
  for(const [suffix,action] of [['text',{text:'yes'}],['cancel',{cancel:true}],['extra',{option:2}]])
    assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
      {operationId:`claude-trust-${suffix}-001`,attachmentId:shown.attachmentId,
        questionId:shown.question.id,...action})).status,400);
  assert.equal(writes(f.calls).length,0);
  f.state.selected=1;
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-trust-stale-cursor-001',attachmentId:shown.attachmentId,
      questionId:shown.question.id,option:0})).status,409);
  assert.equal(writes(f.calls).length,0);
  f.state.selected=0;
  f.state.override=trustMenu(f.pane.cwd).replace('read, edit, and execute','read and edit');
  assert.equal((await f.attach()).question,undefined);
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-trust-stale-warning-001',attachmentId:shown.attachmentId,
      questionId:shown.question.id,option:1})).status,409);
  f.state.override=trustMenu(f.pane.cwd)+'\r❯ New prompt';
  assert.equal((await f.attach()).question,undefined);
  f.state.override=trustMenu(`${f.pane.cwd}/another-folder`);
  assert.equal((await f.attach()).question,undefined);
  f.state.override=trustMenu(f.pane.cwd);f.state.truncated=true;
  assert.equal((await f.attach()).question,undefined);
  assert.equal(writes(f.calls).length,0);
});

test('Claude startup Exit confirms only the native Exit row',async t=>{
  const f=await fixture(t,{mode:'trust'});
  const shown=await f.attach();
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-trust-exit-001',attachmentId:shown.attachmentId,
      questionId:shown.question.id,option:0})).status,200);
  assert.deepEqual(writes(f.calls).map(call=>call.params.keys),[['enter']]);
});

test('Claude startup Exit followed by immediate same-pane relaunch offers a new trust card',async t=>{
  const f=await fixture(t,{mode:'trust'});
  const first=await f.attach(),second=await f.attach(f.second.token);
  assert.equal(first.question?.kind,'claude_trust');
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-trust-exit-relaunch-001',attachmentId:first.attachmentId,
      questionId:first.question.id,option:0})).status,200);
  assert.equal(f.state.kind,'shell');
  assert.ok(f.calls.some(call=>call.method==='pane.read'&&call.params.format==='text'));
  f.state.kind='trust';f.state.selected=0;f.pane.agent='claude';
  const relaunched=await f.attach();
  assert.equal(relaunched.questionAwaitingTransition,false);
  assert.equal(relaunched.question?.kind,'claude_trust');
  assert.notEqual(relaunched.question.id,first.question.id);
  assert.equal((await f.request(f.second.token,`${route}/answer`,'POST',
    {operationId:'claude-trust-old-phone-001',attachmentId:second.attachmentId,
      questionId:second.question.id,option:1})).status,409);
  assert.deepEqual(writes(f.calls).map(call=>call.params.keys),[['enter']]);
});

test('Claude startup Exit cannot reauthorize a trust frame without an observed shell',async t=>{
  const f=await fixture(t,{mode:'trust',onWrite:(method,params,state,pane)=>{
    if(method==='pane.send_keys'&&params.keys[0]==='enter'&&state.kind==='shell'){
      state.kind='trust';pane.agent=undefined;
    }
  }});
  const shown=await f.attach();
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-trust-no-exit-proof-001',attachmentId:shown.attachmentId,
      questionId:shown.question.id,option:0})).status,200);
  f.pane.agent='claude';
  const lingering=await f.attach();
  assert.equal(lingering.question,undefined);
  assert.equal(lingering.questionAwaitingTransition,true);
  assert.deepEqual(writes(f.calls).map(call=>call.params.keys),[['enter']]);
});

test('Claude startup Exit keeps the trust frame retired when the shell read is truncated',async t=>{
  const f=await fixture(t,{mode:'trust',onWrite:(method,params,state)=>{
    if(method==='pane.send_keys'&&params.keys[0]==='enter'&&state.kind==='shell')
      state.truncated=true;
  }});
  const shown=await f.attach();
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-trust-truncated-shell-001',attachmentId:shown.attachmentId,
      questionId:shown.question.id,option:0})).status,200);
  assert.equal(f.state.kind,'shell');
  f.state.truncated=false;f.state.kind='trust';f.pane.agent='claude';
  const replayed=await f.attach();
  assert.equal(replayed.question,undefined);
  assert.equal(replayed.questionAwaitingTransition,true);
  assert.deepEqual(writes(f.calls).map(call=>call.params.keys),[['enter']]);
});

test('Claude startup Exit can retire later after a complete shell appears',async t=>{
  const f=await fixture(t,{mode:'trust',onWrite:(method,params,state,pane)=>{
    if(method==='pane.send_keys'&&params.keys[0]==='enter'&&state.kind==='shell'){
      state.kind='trust';pane.agent='claude';
    }
  }});
  const first=await f.attach();
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-trust-late-shell-001',attachmentId:first.attachmentId,
      questionId:first.question.id,option:0})).status,200);
  assert.equal((await f.attach()).questionAwaitingTransition,true);
  f.state.kind='shell';f.pane.agent=undefined;
  const shell=await f.attach();
  assert.equal(shell.question,undefined);
  assert.equal(shell.questionAwaitingTransition,false);
  f.state.kind='trust';f.pane.agent='claude';
  const relaunched=await f.attach();
  assert.equal(relaunched.question?.kind,'claude_trust');
  assert.notEqual(relaunched.question.id,first.question.id);
  assert.deepEqual(writes(f.calls).map(call=>call.params.keys),[['enter']]);
});

test('Claude startup warning change during Trust navigation never receives Enter',async t=>{
  const f=await fixture(t,{mode:'trust',onWrite:(method,params,state,pane)=>{
    if(method==='pane.send_keys'&&params.keys[0]==='down')
      state.override=trustMenu(pane.cwd,state.selected).replace('Security guide','Changed guide');
  }});
  const shown=await f.attach();
  assert.equal((await f.request(f.first.token,`${route}/answer`,'POST',
    {operationId:'claude-trust-changed-during-nav-001',attachmentId:shown.attachmentId,
      questionId:shown.question.id,option:1})).status,409);
  assert.deepEqual(writes(f.calls).map(call=>call.params.keys),[['down']]);
});
