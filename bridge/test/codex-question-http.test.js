import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createBridge} from '../src/server.js';
import {BridgeError} from '../src/herdr.js';
import {detectCodexQuestion} from '../src/codex-question.js';

const route='/v1/panes/w1%3Ap1';
const writes=calls=>calls.filter(call=>['pane.send_keys','pane.send_text','pane.send_input'].includes(call.method));
const choices=['Keep current preview','Use compact preview','Other'];
const collapsed=(timer='')=>`• Queued follow-up inputs\n  ? 1 question${timer}\n    shift+← to answer\n\n› Desktop draft stays intact\n  GPT-6.1-Sol high · Context 96% left`;
const expanded=(selected=0,prompt='Which local preview should this test use?',draft='')=>
  `• Queued follow-up inputs\n\n  ${prompt}\n\n`+
  choices.map((label,index)=>`  ${index===selected?'›':' '} ${index+1}. ${index===2&&draft?draft:label}`).join('\n')+
  '\n\n  enter submit   ctrl+] skip   shift+→ main prompt';
const freeText=(prompt='What short label should this local test use?',draft='')=>
  `• Queued follow-up inputs\n\n  ${prompt}\n\n`+
  (draft?`  ${draft}`:'  \u001b[2mType your answer\u001b[22m')+
  '\n\n  enter submit   ctrl+] skip   shift+→ main prompt';

async function fixture(t,{agent='codex',status='working',initial='collapsed',onWrite}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-question-http-'));
  const pane={pane_id:'w1:p1',workspace_id:'w1',tab_id:'t1',cwd:dir,agent_status:status,
    agent,terminal_id:'term',agent_session:{value:'synthetic-session'}};
  const state={kind:initial,selected:0,prompt:'Which local preview should this test use?',draft:'',
    override:null,truncated:false,failVisible:false,visibleReads:0};
  const calls=[];
  const screen=()=>state.override??(state.kind==='collapsed'?collapsed(' · 10s'):
    state.kind==='expanded'?expanded(state.selected,state.prompt,state.draft):
    state.kind==='freeText'?freeText(state.prompt,state.draft):
    '• Messages to be submitted after next tool call\n  ↳ Which local preview should this test use? Use compact preview\n\n› Desktop draft stays intact\n  GPT-6.1-Sol high · Context 96% left');
  const herdr={call:async(method,params={})=>{
    calls.push({method,params});
    if(method==='session.snapshot')return {snapshot:{protocol:22,workspaces:[{workspace_id:'w1'}],panes:[pane],agents:[pane]}};
    if(method==='pane.get')return {pane};
    if(method==='pane.read') {
      if(params.source==='visible') {
        state.visibleReads++;
        if(state.failVisible)throw new BridgeError('herdr_timeout','Visible read failed.',504);
      }
      return {read:{text:params.source==='visible'?screen():expanded(),revision:1,truncated:state.truncated}};
    }
    if(method==='pane.send_keys') {
      if(params.keys[0]==='shift+left')state.kind='expanded';
      if(params.keys[0]==='down')state.selected++;
      if(params.keys[0]==='up')state.selected--;
      if(params.keys[0]==='enter' && (state.kind==='freeText'?Boolean(state.draft):(state.selected<2 || state.draft)))state.kind='queued';
    }
    if(method==='pane.send_text')state.draft=params.text;
    await onWrite?.(method,params,state,pane);
    return {type:'ok'};
  }};
  const config={socketPath:'/unused',stateDir:path.join(dir,'state'),projects:[],allowTerminalInput:false};
  const start=async()=>{const app=createBridge(config,{herdr});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');return app;};
  let app=await start();
  const credential=app.store.pair(app.store.pairCode(),'question-test');
  const second=app.store.pair(app.store.pairCode(),'other-phone');
  const requestAs=(token,endpoint,method='GET',body)=>fetch(`http://127.0.0.1:${app.server.address().port}${endpoint}`,{
    method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const request=(endpoint,method='GET',body)=>requestAs(credential.token,endpoint,method,body);
  const secondRequest=(endpoint,method='GET',body)=>requestAs(second.token,endpoint,method,body);
  const attach=async()=>{const response=await request(`${route}/output`);assert.equal(response.status,200);return response.json();};
  const restart=async()=>{await app.close();app=await start();};
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {pane,state,calls,request,secondRequest,attach,restart,stateDir:config.stateDir};
}

test('passive output recognizes only the current collapsed cue; explicit review reveals real choices',async t=>{
  const f=await fixture(t);
  const first=await f.attach();
  assert.equal(first.questionReviewAvailable,true);
  assert.equal(first.question,undefined);
  assert.equal(writes(f.calls).length,0);
  const missing=await f.request(`${route}/question-review`,'POST',{operationId:'question-reveal-missing-001'});
  assert.equal(missing.status,409);assert.equal(writes(f.calls).length,0);
  const opened=await f.request(`${route}/question-review`,'POST',{operationId:'question-reveal-001',attachmentId:first.attachmentId});
  assert.equal(opened.status,200);
  assert.deepEqual(writes(f.calls).map(call=>call.params.keys),[['shift+left']]);
  const question=(await f.attach()).question;
  assert.equal(question.prompt,'Which local preview should this test use?');
  assert.deepEqual(question.options,choices);
  assert.equal(question.selectedIndex,0);
  assert.equal(question.stage,'choices');
  assert.match(question.id,/^[a-f0-9]{64}$/);
  assert.equal((await f.attach()).question.id,question.id);
});

test('native free-text-only editor is actionable after reveal and verifies its draft before Enter',async t=>{
  const f=await fixture(t,{initial:'collapsed',onWrite:(method,params,state)=>{
    if(method==='pane.send_keys' && params.keys[0]==='shift+left') state.kind='freeText';
  }});
  const first=await f.attach();
  assert.equal(first.questionReviewAvailable,true);
  assert.equal((await f.request(`${route}/question-review`,'POST',
    {operationId:'free-text-reveal-001',attachmentId:first.attachmentId})).status,200);
  const opened=await f.attach();
  assert.equal(opened.questionAwaitingTransition,false);
  assert.ok(f.calls.some(call=>call.method==='pane.read'&&call.params.source==='visible'&&
    call.params.format==='ansi'&&call.params.strip_ansi===false));
  assert.deepEqual(opened.question && {
    prompt:opened.question.prompt,options:opened.question.options,selectedIndex:opened.question.selectedIndex,
    stage:opened.question.stage,freeText:opened.question.freeText
  },{prompt:'Which local preview should this test use?',options:[],selectedIndex:null,stage:'text',freeText:true});
  const answer={operationId:'free-text-answer-001',attachmentId:opened.attachmentId,
    questionId:opened.question.id,text:'Local  preview only'};
  const response=await f.request(`${route}/answer`,'POST',answer);
  assert.equal(response.status,200);
  assert.deepEqual(writes(f.calls).map(call=>[call.method,call.params.keys??call.params.text]),[
    ['pane.send_keys',['shift+left']],['pane.send_text','Local  preview only'],['pane.send_keys',['enter']]
  ]);
  assert.equal(f.state.kind,'queued');
  const replay=await f.request(`${route}/answer`,'POST',answer);
  assert.equal(replay.status,200);
  assert.equal((await replay.json()).replayed,true);
  assert.equal(writes(f.calls).length,3);
});

test('free-text parser accepts a wrapped placeholder and rejects incomplete or unknown editors',()=>{
  const wrapped=freeText('Which synthetic label should be used?').replace('Type your answer','Type your\n  answer');
  assert.deepEqual(detectCodexQuestion(wrapped),{
    prompt:'Which synthetic label should be used?',options:[],selectedIndex:null,
    stage:'text',otherDraft:null
  });
  assert.equal(detectCodexQuestion(freeText('Which synthetic label should be used?','Existing draft')).otherDraft,'Existing draft');
  assert.equal(detectCodexQuestion(freeText('Does “Type your answer” appear in this question?')).prompt,
    'Does “Type your answer” appear in this question?');
  assert.equal(detectCodexQuestion(freeText('Which synthetic label should be used?','Two  spaces')).otherDraft,'Two  spaces');
  assert.equal(detectCodexQuestion(freeText('Which synthetic label should be used?').replace(/\u001b\[[0-9;]*m/g,'')).otherDraft,
    'Type your answer');
  assert.equal(detectCodexQuestion(freeText().replace('\u001b[2m','\u001b[38;2;120;180;200m')).otherDraft,
    'Type your answer');
  for(const malformed of [
    freeText().replace('Type your answer','Type your…'),
    freeText().replace('\n\n  \u001b[2mType your answer','\n  \u001b[2mType your answer'),
    freeText().replace('shift+→ main prompt','unknown footer'),
    freeText()+'\n› A different active composer',
    freeText().replace('• Queued follow-up inputs','Queued follow-up inputs'),
    freeText().replace('Type your answer','1. Unknown option')
  ]) assert.equal(detectCodexQuestion(malformed),null);
});

test('a pre-existing free-text draft, truncated frame, or changed prompt cannot authorize input',async t=>{
  const f=await fixture(t,{initial:'freeText'});
  const first=await f.attach();
  assert.equal(first.question.stage,'text');
  f.state.draft='Existing desktop draft';
  assert.equal((await f.attach()).question,undefined);
  assert.equal((await f.request(`${route}/answer`,'POST',{
    operationId:'free-text-existing-001',attachmentId:first.attachmentId,
    questionId:first.question.id,text:'New answer'
  })).status,409);
  f.state.draft='';f.state.truncated=true;
  assert.equal((await f.attach()).question,undefined);
  f.state.truncated=false;f.state.prompt='Changed local question?';
  assert.equal((await f.request(`${route}/answer`,'POST',{
    operationId:'free-text-changed-001',attachmentId:first.attachmentId,
    questionId:first.question.id,text:'New answer'
  })).status,409);
  assert.equal(writes(f.calls).length,0);
});

test('a desktop draft equal to the placeholder never exposes a writable free-text field',async t=>{
  const f=await fixture(t,{initial:'freeText'});
  const empty=await f.attach();
  assert.equal(empty.question.stage,'text');
  f.state.draft='Type your answer';
  const output=await f.attach();
  assert.equal(output.question,undefined);
  assert.equal((await f.request(`${route}/answer`,'POST',{
    operationId:'free-text-literal-draft-001',attachmentId:empty.attachmentId,
    questionId:empty.question.id,text:'Append would be unsafe'
  })).status,409);
  assert.equal(writes(f.calls).length,0);
});

test('answer equal to the placeholder is verified as entered text before Enter',async t=>{
  const f=await fixture(t,{initial:'freeText'});
  const shown=await f.attach();
  const response=await f.request(`${route}/answer`,'POST',{
    operationId:'free-text-literal-answer-001',attachmentId:shown.attachmentId,
    questionId:shown.question.id,text:'Type your answer'
  });
  assert.equal(response.status,200);
  assert.deepEqual(writes(f.calls).map(call=>[call.method,call.params.keys??call.params.text]),[
    ['pane.send_text','Type your answer'],['pane.send_keys',['enter']]
  ]);
});

test('free-text draft mismatch leaves Enter unsent and retires the attempted answer',async t=>{
  const f=await fixture(t,{initial:'freeText',onWrite:(method,params,state)=>{
    if(method==='pane.send_text')state.draft='Conflicting desktop edit';
  }});
  const shown=await f.attach();
  const body={operationId:'free-text-mismatch-001',attachmentId:shown.attachmentId,
    questionId:shown.question.id,text:'Local answer'};
  const first=await f.request(`${route}/answer`,'POST',body);
  assert.equal(first.status,409);
  assert.equal((await first.json()).error.operationStatus,'uncertain');
  assert.deepEqual(writes(f.calls).map(call=>call.method),['pane.send_text']);
  assert.equal((await f.request(`${route}/answer`,'POST',body)).status,409);
  assert.equal(writes(f.calls).length,1);
});

test('unknown, truncated and failed reads cannot reauthorize an attempted reveal',async t=>{
  const f=await fixture(t);
  const first=await f.attach();
  assert.equal((await f.request(`${route}/question-review`,'POST',
    {operationId:'question-unknown-reveal-001',attachmentId:first.attachmentId})).status,200);
  assert.deepEqual(writes(f.calls).map(call=>call.params.keys),[['shift+left']]);
  const retry=async operationId=>f.request(`${route}/question-review`,'POST',
    {operationId,attachmentId:first.attachmentId});
  f.state.override='Unrecognized native editor';
  let output=await f.attach();
  assert.equal(output.questionAwaitingTransition,true);
  assert.equal(output.questionReviewAvailable,false);
  assert.equal(output.question,undefined);
  assert.equal((await retry('question-unknown-reveal-002')).status,409);
  f.state.override=collapsed();f.state.truncated=true;
  output=await f.attach();
  assert.equal(output.questionAwaitingTransition,true);
  assert.equal(output.questionReviewAvailable,false);
  assert.equal((await retry('question-unknown-reveal-003')).status,409);
  f.state.truncated=false;f.state.failVisible=true;
  output=await f.attach();
  assert.equal(output.questionAwaitingTransition,true);
  assert.equal(output.questionReviewAvailable,false);
  assert.equal((await retry('question-unknown-reveal-004')).status,409);
  assert.equal(writes(f.calls).length,1);
  f.state.failVisible=false;f.state.override=null;
  output=await f.attach();
  assert.equal(output.questionAwaitingTransition,false);
  assert.equal(output.question.stage,'choices');
});

test('output suppresses question controls while a pane mutation holds the lock',async t=>{
  let releaseWrite,enteredWrite;
  const held=new Promise(resolve=>{releaseWrite=resolve;});
  const entered=new Promise(resolve=>{enteredWrite=resolve;});
  const f=await fixture(t,{onWrite:async(method,params)=>{
    if(method==='pane.send_keys'&&params.keys[0]==='shift+left') {
      enteredWrite();
      await held;
    }
  }});
  const first=await f.attach();
  const pending=f.request(`${route}/question-review`,'POST',
    {operationId:'question-locked-reveal-001',attachmentId:first.attachmentId});
  try {
    await entered;
    const response=await f.secondRequest(`${route}/output`);
    assert.equal(response.status,200);
    const output=await response.json();
    assert.equal(output.questionAwaitingTransition,true);
    assert.equal(output.questionReviewAvailable,false);
    assert.equal(output.question,undefined);
    assert.deepEqual(writes(f.calls).map(call=>call.params.keys),[['shift+left']]);
  } finally {releaseWrite();}
  assert.equal((await pending).status,200);
});

test('fixed choice verifies each cursor step and submits once through the native editor',async t=>{
  const f=await fixture(t,{initial:'expanded'});
  const output=await f.attach();
  const body={operationId:'question-fixed-001',attachmentId:output.attachmentId,questionId:output.question.id,option:1};
  const response=await f.request(`${route}/answer`,'POST',body);
  assert.equal(response.status,200);
  assert.deepEqual(writes(f.calls).map(call=>call.params.keys),[['down'],['enter']]);
  assert.equal(f.state.kind,'queued');
  assert.equal((await f.attach()).question,undefined);
  const replay=await f.request(`${route}/answer`,'POST',body);
  assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,true);
  assert.equal(writes(f.calls).length,2);
});

test('Other is an empty inline editor; text is verified before Enter and old choice ID retires',async t=>{
  const f=await fixture(t,{initial:'expanded'});
  const first=await f.attach();
  const choose={operationId:'question-other-001',attachmentId:first.attachmentId,questionId:first.question.id,option:2};
  assert.equal((await f.request(`${route}/answer`,'POST',choose)).status,200);
  assert.deepEqual(writes(f.calls).map(call=>call.params.keys),[['down'],['down']]);
  const textStage=await f.attach();
  assert.equal(textStage.question.stage,'text');
  assert.equal(textStage.question.freeText,true);
  assert.deepEqual(textStage.question.options,[]);
  assert.equal(textStage.question.selectedIndex,null);
  assert.notEqual(textStage.question.id,first.question.id);
  assert.equal((await f.request(`${route}/answer`,'POST',
    {operationId:'question-old-choice-001',attachmentId:first.attachmentId,questionId:first.question.id,option:1})).status,409);
  const submitted=await f.request(`${route}/answer`,'POST',
    {operationId:'question-text-001',attachmentId:first.attachmentId,questionId:textStage.question.id,text:'Local custom preview answer'});
  assert.equal(submitted.status,200);
  assert.deepEqual(writes(f.calls).map(call=>[call.method,call.params.keys??call.params.text]),
    [['pane.send_keys',['down']],['pane.send_keys',['down']],['pane.send_text','Local custom preview answer'],['pane.send_keys',['enter']]]);
  assert.equal(f.state.kind,'queued');
});

test('question identity, cursor, incomplete menu and terminal type reject without input',async t=>{
  const f=await fixture(t,{initial:'expanded'});
  const output=await f.attach();
  f.state.selected=1;
  assert.equal((await f.request(`${route}/answer`,'POST',
    {operationId:'question-cursor-stale-001',attachmentId:output.attachmentId,questionId:output.question.id,option:0})).status,409);
  assert.equal(writes(f.calls).length,0);
  f.state.selected=0;f.pane.terminal_id='replacement';
  assert.equal((await f.request(`${route}/answer`,'POST',
    {operationId:'question-pane-stale-001',attachmentId:output.attachmentId,questionId:output.question.id,option:0})).status,409);
  assert.equal(writes(f.calls).length,0);
  const next=await f.attach();
  assert.notEqual(next.question.id,output.question.id);
  f.state.override=expanded().replace('shift+→ main prompt','different footer');
  assert.equal((await f.attach()).question,undefined);
  f.state.override=expanded().replace('Which local preview','Which local preview…');
  assert.equal((await f.attach()).question,undefined);
  f.state.override=null;f.state.truncated=true;
  assert.equal((await f.attach()).question,undefined);
  f.pane.agent='terminal';f.state.truncated=false;
  assert.equal((await f.attach()).question,undefined);
  assert.equal(writes(f.calls).length,0);
});

test('changed screen after cursor movement is uncertain and never submits or replays',async t=>{
  const f=await fixture(t,{initial:'expanded',onWrite:(method,params,state)=>{
    if(method==='pane.send_keys'&&params.keys[0]==='down')state.prompt='A different question?';
  }});
  const output=await f.attach();
  const body={operationId:'question-partial-001',attachmentId:output.attachmentId,questionId:output.question.id,option:1};
  const first=await f.request(`${route}/answer`,'POST',body);
  assert.equal(first.status,409);
  assert.equal((await first.json()).error.operationStatus,'uncertain');
  assert.deepEqual(writes(f.calls).map(call=>call.params.keys),[['down']]);
  const repeat=await f.request(`${route}/answer`,'POST',body);
  assert.equal(repeat.status,409);assert.equal((await repeat.json()).error.code,'operation_uncertain');
  assert.equal(writes(f.calls).length,1);
});

test('lost acknowledgement after native Enter remains uncertain; stale frame cannot reauthorize',async t=>{
  const f=await fixture(t,{initial:'expanded',onWrite:(method,params)=>{
    if(method==='pane.send_keys'&&params.keys[0]==='enter')throw new BridgeError('herdr_timeout','Response lost.',504);
  }});
  const output=await f.attach();
  const body={operationId:'question-lost-enter-001',attachmentId:output.attachmentId,questionId:output.question.id,option:0};
  const first=await f.request(`${route}/answer`,'POST',body);
  assert.equal(first.status,504);assert.equal((await first.json()).error.operationStatus,'uncertain');
  assert.equal(f.state.kind,'queued');
  assert.equal((await f.request(`${route}/answer`,'POST',body)).status,409);
  assert.equal(writes(f.calls).length,1);
});

test('a second device cannot act on a lingering frame after the first device sends a key',async t=>{
  const f=await fixture(t,{initial:'expanded',onWrite:(method,params,state)=>{
    if(method==='pane.send_keys'&&params.keys[0]==='enter') {state.kind='expanded';state.selected=1;}
  }});
  const first=await f.attach();
  const second=await (await f.secondRequest(`${route}/output`)).json();
  assert.notEqual(first.question.id,second.question.id);
  assert.equal((await f.request(`${route}/answer`,'POST',
    {operationId:'question-phone-a-001',attachmentId:first.attachmentId,questionId:first.question.id,option:0})).status,200);
  assert.equal((await f.secondRequest(`${route}/answer`,'POST',
    {operationId:'question-phone-b-001',attachmentId:second.attachmentId,questionId:second.question.id,option:1})).status,409);
  const lingering=await f.attach();
  assert.equal(lingering.question,undefined);
  assert.equal(lingering.questionAwaitingTransition,true);
  assert.equal(writes(f.calls).length,1);
  f.state.kind='queued';
  assert.equal((await f.attach()).questionAwaitingTransition,false);
});

test('retired question survives bridge restart until a native transition is observed',async t=>{
  const f=await fixture(t,{initial:'expanded',onWrite:(method,params,state)=>{
    if(method==='pane.send_keys'&&params.keys[0]==='enter') {state.kind='expanded';state.selected=1;}
  }});
  const shown=await f.attach();
  assert.equal((await f.request(`${route}/answer`,'POST',
    {operationId:'question-before-restart-001',attachmentId:shown.attachmentId,questionId:shown.question.id,option:0})).status,200);
  const tombstone=fs.readFileSync(path.join(f.stateDir,'question-retired.json'),'utf8');
  assert.doesNotMatch(tombstone,/Which local preview|w1:p1|synthetic-session|Keep current preview/);
  await f.restart();
  const oldFrame=await f.attach();
  assert.equal(oldFrame.question,undefined);
  assert.equal(oldFrame.questionAwaitingTransition,true);
  assert.equal((await f.secondRequest(`${route}/answer`,'POST',
    {operationId:'question-after-restart-001',attachmentId:oldFrame.attachmentId,questionId:shown.question.id,option:1})).status,409);
  assert.equal(writes(f.calls).length,1);
  f.state.kind='queued';
  assert.equal((await f.attach()).questionAwaitingTransition,false);
});
