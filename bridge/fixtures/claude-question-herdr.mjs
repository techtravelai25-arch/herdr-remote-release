// Run explicitly: node bridge/fixtures/claude-question-herdr.mjs
// Requires HERDR_ENV=1 and installed herdr/claude. CLAUDE_BIN may select a
// cached Claude binary. HERDR_QUESTION_TRACE_PATH saves sanitized test evidence.
// This owns a named Herdr server, workspace, local fake API and bridge.
// Add --multi for checkbox/review coverage, or --trust-exit to reject trust.
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createBridge} from '../src/server.js';
import {detectClaudeQuestion} from '../src/claude-question.js';

// Reject outside Herdr before any control command, including cleanup.
assert.equal(process.env.HERDR_ENV,'1','Run this fixture from a Herdr-managed pane.');
assert.ok(process.argv.slice(2).every(arg=>['--multi','--trust-exit'].includes(arg)),
  'Only --multi and --trust-exit are supported.');
assert.ok(!(process.argv.includes('--multi')&&process.argv.includes('--trust-exit')),
  'Choose one fixture mode.');
const multiSelect=process.argv.includes('--multi');
const trustExit=process.argv.includes('--trust-exit');
const foundClaude=spawnSync('which',['claude'],{encoding:'utf8',timeout:5000});
const claudeBin=process.env.CLAUDE_BIN
  ?path.resolve(process.env.CLAUDE_BIN):foundClaude.stdout.trim();
assert.ok(claudeBin&&fs.existsSync(claudeBin),'An installed Claude Code binary is required.');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-herdr-question-'));
const name=`cq-fixture-${randomUUID().slice(0,12)}`;
const timeout=Date.now()+90000;
let herdrServer,bridge,api,ownHerdr,ownPaneId;
let serverOutput='';
const transportTrace=[];
const answers=[];
const apiRequests=[];
const apiCalls=[];
const trustEvidence={};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const shellQuote=value=>`'${String(value).replaceAll("'","'\"'\"'")}'`;
const tracePath=process.env.HERDR_QUESTION_TRACE_PATH;
const saveTrace=(status,error)=>{
  if(!tracePath)return;
  const target=path.resolve(tracePath);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,JSON.stringify({status,error,mode:trustExit?'trust-exit':multiSelect?'multi':'single',
    trust:trustEvidence,trace:transportTrace,apiCalls,apiRequests,toolResultObserved:answers.some(answer=>typeof answer==='string'&&
      answer.startsWith('The user answered: "How should the local fixture proceed?"="Use local previews".'))},null,2));
  console.log('TRACE_FILE:',target);
};
const cli=(...args)=>{
  const result=spawnSync('herdr',['--session',name,...args],{encoding:'utf8',timeout:8000});
  if(result.status!==0)throw Error(`herdr ${args.slice(0,2).join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim()?JSON.parse(result.stdout).result:null;
};
const question={questions:[{question:'How should the local fixture proceed?',header:'Fixture',
  options:[{label:'Keep local',description:'Use local fixture data.'},
    {label:'Use sample',description:'Use synthetic sample data.'}],multiSelect}]};
const sse=(first)=>[
  ['message_start',{type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',
    model:'claude-sonnet-4-5',content:[],stop_reason:null,stop_sequence:null,
    usage:{input_tokens:10,output_tokens:1}}}],
  ['content_block_start',{type:'content_block_start',index:0,content_block:first
    ?{type:'tool_use',id:'toolu_fixture',name:'AskUserQuestion',input:{}}
    :{type:'text',text:''}}],
  ['content_block_delta',{type:'content_block_delta',index:0,delta:first
    ?{type:'input_json_delta',partial_json:JSON.stringify(question)}
    :{type:'text_delta',text:'Done.'}}],
  ['content_block_stop',{type:'content_block_stop',index:0}],
  ['message_delta',{type:'message_delta',delta:{stop_reason:first?'tool_use':'end_turn',
    stop_sequence:null},usage:{output_tokens:1}}],
  ['message_stop',{type:'message_stop'}]
].map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const readBody=async req=>{let body='';for await(const chunk of req)body+=chunk;return JSON.parse(body);};
let emitted=false;
api=createServer(async(req,res)=>{
  try {
    apiCalls.push(req.url);
    const body=await readBody(req);
    if(req.url?.startsWith('/v1/messages/count_tokens')){
      res.writeHead(200,{'Content-Type':'application/json'});res.end('{"input_tokens":100}');return;
    }
    if(req.url?.startsWith('/v1/messages')){
      apiRequests.push({path:req.url,tools:body.tools?.map(tool=>tool.name)??[]});
      for(const message of body.messages??[])for(const item of Array.isArray(message.content)?message.content:[])
        if(item?.type==='tool_result')answers.push(item.content);
      const first=!emitted&&body.tools?.some(tool=>tool.name==='AskUserQuestion');
      if(first)emitted=true;
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
      res.end(sse(first));return;
    }
    res.writeHead(404);res.end();
  } catch {res.writeHead(400);res.end();}
});

try {
  const version=spawnSync(claudeBin,['--version'],{encoding:'utf8',timeout:5000});
  assert.equal(version.status,0,'Claude Code version check failed.');
  console.log('CLAUDE_VERSION:',version.stdout.trim());
  fs.writeFileSync(path.join(root,'config.toml'),
    'onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n');
  api.listen(0,'127.0.0.1');await once(api,'listening');
  herdrServer=spawn('herdr',['--session',name,'server'],{env:{...process.env,
    HERDR_CONFIG_PATH:path.join(root,'config.toml')},stdio:['ignore','pipe','pipe']});
  for(const stream of [herdrServer.stdout,herdrServer.stderr])stream.on('data',data=>{
    serverOutput=(serverOutput+data.toString()).slice(-3000);
  });
  let status='';
  while(Date.now()<timeout){
    const result=spawnSync('herdr',['--session',name,'status','server'],{encoding:'utf8',timeout:5000});
    status=result.stdout;
    if(result.status===0&&status.includes('status: running'))break;
    if(herdrServer.exitCode!==null)throw Error('Owned Herdr server exited before startup.');
    await sleep(100);
  }
  assert.match(status,/status: running/);
  const socketPath=/socket: (.+)/.exec(status)?.[1];assert.ok(socketPath);
  const claudeConfig=path.join(root,'claude-config');
  fs.mkdirSync(claudeConfig,{recursive:true});
  fs.writeFileSync(path.join(claudeConfig,'.claude.json'),
    JSON.stringify({hasCompletedOnboarding:true}));
  fs.writeFileSync(path.join(root,'.claude.json'),
    JSON.stringify({hasCompletedOnboarding:true}));
  const fixtureClaude=path.join(root,'claude');
  fs.symlinkSync(claudeBin,fixtureClaude);
  const launcher=path.join(root,'launch-claude.sh');
  fs.writeFileSync(launcher,`#!/bin/sh
exec /usr/bin/env -i \
  PATH=${shellQuote(process.env.PATH??'/usr/local/bin:/usr/bin:/bin')} \
  TERM=xterm-256color \
  CLAUDE_CONFIG_DIR=${shellQuote(claudeConfig)} \
  ANTHROPIC_API_KEY=fixture-only-key \
  ANTHROPIC_BASE_URL=http://127.0.0.1:${api.address().port} \
  NO_PROXY=127.0.0.1,localhost \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  DISABLE_TELEMETRY=1 \
  ${shellQuote(fixtureClaude)} --model claude-sonnet-4-5
`,{mode:0o700});
  const created=cli('workspace','create','--cwd',root,'--label','question-fixture','--no-focus');
  const paneId=created.root_pane.pane_id;
  ownPaneId=paneId;
  const {Herdr}=await import('../src/herdr.js');
  const herdr=new Herdr(socketPath);
  ownHerdr=herdr;
  const read=async()=>{
    const result=await herdr.call('pane.read',{pane_id:paneId,source:'visible',
      format:'text',lines:120});return result.read.text;
  };
  const tracedHerdr={call:async(method,params,ms)=>{
    const result=await herdr.call(method,params,ms);
    if(method==='pane.read')transportTrace.push({method,source:params.source,
      text:result.read?.text,parsed:detectClaudeQuestion(result.read?.text)});
    else if(method.startsWith('pane.send_'))transportTrace.push({method,
      keys:params.keys,text:params.text});
    else if(method==='pane.get')transportTrace.push({method,
      agent:result.pane?.agent,status:result.pane?.agent_status,
      terminal:result.pane?.terminal_id});
    return result;
  }};
  bridge=createBridge({socketPath,stateDir:path.join(root,'bridge-state'),projects:[],
    allowTerminalInput:false},{homeDirectory:root,herdr:tracedHerdr});
  bridge.server.listen(0,'127.0.0.1');await once(bridge.server,'listening');
  const device=bridge.store.pair(bridge.store.pairCode(),'fixture-phone');
  const route=`http://127.0.0.1:${bridge.server.address().port}/v1/panes/${encodeURIComponent(paneId)}`;
  const request=async(suffix,method='GET',body,{allowPaneChange=false}={})=>{
    const response=await fetch(route+suffix,{method,headers:{Authorization:`Bearer ${device.token}`,
      'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();
    if(allowPaneChange&&suffix==='/output'&&response.status===409&&data.error?.code==='pane_changed')
      return null;
    assert.equal(response.status,200,`${suffix}: ${JSON.stringify(data)}`);return data;
  };
  const waitCard=async(stage,predicate=()=>true)=>{
    const deadline=Date.now()+12000;
    while(Date.now()<deadline){
      const result=await request('/output','GET',undefined,{allowPaneChange:true});
      if(result?.question?.stage===stage&&predicate(result.question))return result;
      await sleep(100);
    }
    throw Error(`The bridge did not expose the expected ${stage} question state.`);
  };
  const answer=(card,operationId,input)=>request('/answer','POST',{
    operationId,attachmentId:card.attachmentId,questionId:card.question.id,...input});
  cli('pane','run',paneId,launcher);
  const trustCard=await waitCard('choices',value=>value.kind==='claude_trust');
  const expectedTrust=`Accessing workspace:\n${root}\n\n`+
    "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.\n\n"+
    "Claude Code'll be able to read, edit, and execute files here.\n\nSecurity guide";
  assert.equal(trustCard.question.prompt,expectedTrust);
  assert.deepEqual(trustCard.question.options,['No, exit','Yes, I trust this folder']);
  assert.equal(trustCard.question.selectedIndex,0,'Native trust must default to Exit.');
  assert.equal(trustCard.question.cancelAvailable,false);
  assert.deepEqual(apiCalls,[],'The fake model API must not be called before explicit trust.');
  Object.assign(trustEvidence,{path:root,selectedIndex:trustCard.question.selectedIndex,
    options:trustCard.question.options,apiCallsBeforeDecision:apiCalls.length,
    chosenOption:trustExit?0:1});
  const trustResult=await answer(trustCard,'herdr-fixture-trust-choice',
    {option:trustExit?0:1});
  assert.equal(trustResult.dispatched,true);
  console.log('TRUST_CHOICE:',trustExit?'No, exit':'Yes, I trust this folder');
  if(trustExit){
    let shell=false;
    while(Date.now()<timeout){
      const pane=(await herdr.call('pane.get',{pane_id:paneId})).pane;
      const visible=await read();
      const last=visible.replace(/\r/g,'\n').trimEnd().split('\n').at(-1)??'';
      if(!pane.agent&&/\$\s*$/.test(last)){shell=true;break;}
      await sleep(100);
    }
    assert.ok(shell,'Exit did not return the owned pane to its shell.');
    trustEvidence.returnedToShell=true;
    assert.deepEqual(apiCalls,[],'Declining trust must not call the fake model API.');
    cli('pane','run',paneId,launcher);
    let trustAgain=false;
    while(Date.now()<timeout){
      const {read:frame}=await herdr.call('pane.read',{pane_id:paneId,source:'visible',
        format:'ansi',strip_ansi:false,lines:120});
      const current=detectClaudeQuestion(frame.text);
      if(current?.kind==='claude_trust'&&current.workspacePath===root){trustAgain=true;break;}
      await sleep(100);
    }
    assert.ok(trustAgain,'The folder trust prompt did not reappear after Exit.');
    trustEvidence.promptReappeared=true;
    assert.deepEqual(apiCalls,[],'The second untrusted launch must not call the fake model API.');
    console.log('PASS: authenticated bridge Exit -> native shell; second launch still requires folder trust; zero fake API calls');
    saveTrace('pass');
  } else {
    let prompted=false,theme=false,key=false,security=false;
    let output='';
    while(Date.now()<timeout){
      output=await read();
      if(output.includes('Unable to connect to Anthropic services'))
        throw Error('Claude ignored the local fake API during startup.');
      if(!theme&&/Choose.*text.*style/is.test(output)){cli('pane','send-keys',paneId,'enter');theme=true;}
      else if(!key&&output.includes('Detected a custom API key')){
        cli('pane','send-keys',paneId,'up');cli('pane','send-keys',paneId,'enter');key=true;
      } else if(key&&!security&&output.includes('Security notes:')){
        cli('pane','send-keys',paneId,'enter');security=true;
      } else if(key&&!prompted&&/❯\s*$/m.test(output)&&output.includes('? for shortcuts')){
        trustEvidence.composerObserved=true;
        cli('pane','send-text',paneId,'Run the local question fixture.');
        cli('pane','send-keys',paneId,'enter');prompted=true;
      }
      if(prompted&&output.includes('How should the local fixture proceed?'))break;
      if(prompted&&apiRequests.length>=2&&!apiRequests.some(request=>
        request.tools.includes('AskUserQuestion')))
        throw Error('Native Claude did not advertise AskUserQuestion to the local fake API.');
      await sleep(100);
    }
    assert.ok(prompted,'Claude did not reach the owned fixture prompt.');
    assert.match(output,/How should the local fixture proceed\?/);
    let card;
    const cardDeadline=Date.now()+12000;
    while(Date.now()<cardDeadline){
      const result=await request('/output','GET',undefined,{allowPaneChange:true});
      if(result?.question?.stage===(multiSelect?'multi':'choices')){card=result;break;}
      await sleep(500);
    }
    assert.ok(card?.question,'The authenticated bridge route did not detect the native question.');
    assert.equal(card.question.prompt,question.questions[0].question);
    assert.deepEqual(card.question.options.slice(0,2),[
      'Keep local Use local fixture data.','Use sample Use synthetic sample data.']);
    const first=await request('/answer','POST',{operationId:'herdr-fixture-open-custom',
      attachmentId:card.attachmentId,questionId:card.question.id,option:2});
    assert.equal(first.stage,'text');
    assert.equal(first.opened,true);
    let textCard;
    const textDeadline=Date.now()+12000;
    while(Date.now()<textDeadline){
      const result=await request('/output','GET',undefined,{allowPaneChange:true});
      if(result?.question?.stage==='text'){textCard=result;break;}
      await sleep(500);
    }
    assert.ok(textCard?.question,'The bridge did not expose the native custom editor.');
    const typed=await request('/answer','POST',{operationId:'herdr-fixture-custom-answer',
      attachmentId:textCard.attachmentId,questionId:textCard.question.id,
      text:'Use local previews'});
    if(multiSelect){
      assert.equal(typed.selected,true);
      const drafted=value=>value.options[2]==='Custom: Use local previews';
      const checked=value=>drafted(value)&&JSON.stringify(value.selectedOptions)==='[2]';
      card=await waitCard('multi',checked);
      const cleared=await answer(card,'herdr-fixture-clear-custom',{option:2});
      assert.equal(cleared.selected,false);
      card=await waitCard('multi',value=>drafted(value)&&value.selectedOptions.length===0);
      const rechecked=await answer(card,'herdr-fixture-recheck-custom',{option:2});
      assert.equal(rechecked.selected,true);
      card=await waitCard('multi',checked);
      const submitted=await answer(card,'herdr-fixture-open-review',{option:3});
      assert.equal(submitted.dispatched,true);
      card=await waitCard('review');
      const reviewed=await answer(card,'herdr-fixture-submit-review',{option:0});
      assert.equal(reviewed.dispatched,true);
    }else assert.equal(typed.dispatched,true);
    while(Date.now()<timeout&&!answers.length)await sleep(100);
    assert.ok(answers.some(answer=>typeof answer==='string'&&answer.startsWith(
      'The user answered: "How should the local fixture proceed?"="Use local previews".')),
      'Claude did not send the exact custom answer as a tool_result.');
    console.log('PASS: authenticated bridge output and answer -> real Herdr socket and pane -> native Claude -> fake API tool_result');
    console.log('TOOL_RESULT: "How should the local fixture proceed?"="Use local previews"');
    console.log('QUESTION_MODE:',multiSelect?'multi with checkbox clear/recheck and review':'single');
    saveTrace('pass');
  }
} catch(error) {
  console.error('FIXTURE_FAILURE:',error.message);
  if(ownHerdr&&ownPaneId)try {
    const {read}=await ownHerdr.call('pane.read',{pane_id:ownPaneId,source:'visible',
      format:'text',lines:60},3000);
    console.error('OWNED_PANE_LAST_SCREEN:',String(read.text).slice(-3000));
  } catch {}
  console.error('OWNED_TRANSPORT_TRACE:',JSON.stringify(transportTrace));
  saveTrace('fail',error.message);
  if(serverOutput)console.error('OWNED_SERVER_LAST_OUTPUT:',serverOutput.slice(-1000));
  console.error('FAKE_API_REQUESTS:',JSON.stringify(apiRequests));
  throw error;
} finally {
  if(bridge)await bridge.close();
  const stopped=spawnSync('herdr',['session','stop',name],{encoding:'utf8',timeout:5000});
  const deleted=spawnSync('herdr',['session','delete',name],{encoding:'utf8',timeout:5000});
  if(herdrServer&&herdrServer.exitCode===null&&herdrServer.signalCode===null){
    herdrServer.kill('SIGTERM');
    await Promise.race([once(herdrServer,'exit'),sleep(5000)]);
    if(herdrServer.exitCode===null&&herdrServer.signalCode===null){
      herdrServer.kill('SIGKILL');await Promise.race([once(herdrServer,'exit'),sleep(2000)]);
    }
  }
  if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}
  const listed=spawnSync('herdr',['session','list','--json'],{encoding:'utf8',timeout:5000});
  const present=listed.status!==0||JSON.parse(listed.stdout).sessions.some(item=>item.name===name);
  if(present||herdrServer&&herdrServer.exitCode===null&&herdrServer.signalCode===null)
    throw Error(`Owned Herdr session did not clean up: ${stopped.stderr.trim()} ${deleted.stderr.trim()}`);
  fs.rmSync(root,{recursive:true,force:true});
  console.log('CLEANUP: owned Herdr session absent; temporary workspace removed.');
}
