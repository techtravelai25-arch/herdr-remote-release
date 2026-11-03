import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {HerdrCore,corePane,agentKind,displayKind} from '../src/herdr-core.js';
import {createCoreEvents} from '../src/core-events.js';
import {createBridge} from '../src/server.js';
import {createPushMonitor} from '../src/push.js';
import {Store} from '../src/store.js';

const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/hc-paint.json',import.meta.url)));
const paint=Buffer.from(fixture.paint,'base64');
const terminal=(address,extra={})=>({address,state:'live',pid:100,cols:fixture.cols,rows:fixture.rows,cwd:'/work',title:'Claude Code',turn:3,
  foreground:{pid:100,name:'bash',argv:['bash'],cwd:'/work'},status:null,
  labels:{'herdr.space':'sp1','herdr.tab':'tb1',where:'my / space / 1'},...extra});

/** A fake herdr-core: JSON-RPC lines, then framed mode after hello {framed:true}. */
async function fakeCore(t,{terminals=[terminal('t1')],frames=[paint],readText=fixture.text,afterGet=null}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hc-fake-'));const socketPath=path.join(dir,'core.sock');
  const calls=[],writes=[];let gets=0;
  const server=net.createServer(socket=>{
    let buffer=Buffer.alloc(0),framed=false;
    const frame=(channel,type,payload)=>{const head=Buffer.alloc(9);head.writeUInt32LE(channel,0);head.writeUInt8(type,4);head.writeUInt32LE(payload.length,5);socket.write(Buffer.concat([head,payload]));};
    const reply=(id,result,error)=>{const body=JSON.stringify(error?{jsonrpc:'2.0',id,error}:{jsonrpc:'2.0',id,result});framed?frame(0,0,Buffer.from(body)):socket.write(body+'\n');};
    const find=name=>terminals.find(x=>x.address===name||x.name===name);
    const handle=message=>{
      const {id,method,params={}}=message;calls.push({method,params});
      if(method==='hello'){reply(id,{core:{id:'core1'},framed:!!params.framed});if(params.framed)framed=true;return;}
      if(method==='terminal.list')return reply(id,{terminals,hidden_finished:0,machines:[]});
      if(method==='terminal.get') {
        const found=find(params.terminal);if(!found)return reply(id,null,{code:-32000,message:'no terminal',data:{kind:'not_found'}});
        gets++;const value=structuredClone(found);if(afterGet&&gets>1)afterGet(value);return reply(id,value);
      }
      if(method==='terminal.attach'){reply(id,{channel:1,terminal:find(params.terminal),resize_notifications:false});if(params.observe)for(const p of frames)frame(1,0,p);return;}
      if(method==='terminal.read')return reply(id,{text:readText,complete:true,how:'screen'});
      if(method==='terminal.run')return reply(id,{address:'t9'});
      return reply(id,{});
    };
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      for(;;) {
        if(!framed){const end=buffer.indexOf(10);if(end<0)return;const line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);handle(JSON.parse(line));continue;}
        if(buffer.length<9)return;const channel=buffer.readUInt32LE(0),type=buffer.readUInt8(4),length=buffer.readUInt32LE(5);
        if(buffer.length<9+length)return;const payload=buffer.subarray(9,9+length);buffer=buffer.subarray(9+length);
        if(channel===0)handle(JSON.parse(payload));else if(type===0)writes.push(payload.toString('utf8'));
      }
    });
  });
  server.listen(socketPath);await once(server,'listening');
  t.after(()=>{server.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {calls,writes,app:[],core:new HerdrCore(socketPath,{app:async args=>{throw Object.assign(new Error('no window'),{args});}})};
}

test('snapshot shows only app panes, with prefixed IDs, space names and agent kinds',async t=>{
  const f=await fakeCore(t,{terminals:[
    terminal('t1',{foreground:{pid:200,name:'claude',argv:['claude'],cwd:'/work/app'},status:{app:'claude-code',state:'done'}}),
    terminal('t2',{foreground:{pid:300,name:'node',argv:['node','codex'],cwd:'/work'},status:{app:'codex',state:'blocked'}}),
    terminal('t3',{labels:{}}),terminal('m/t4'),terminal('t5',{state:'finished'})]});
  const {snapshot}=await f.core.call('session.snapshot');
  assert.deepEqual(snapshot.panes.map(p=>[p.pane_id,p.agent,p.agent_status,p.workspace_id,p.tab_id]),
    [['hc:t1','claude','done','hc:sp1','hc:tb1'],['hc:t2','codex','blocked','hc:sp1','hc:tb1']]);
  assert.deepEqual(snapshot.workspaces,[{workspace_id:'hc:sp1',label:'my / space'}]);
  assert.equal(snapshot.panes[0].foreground_cwd,'/work/app');
  assert.equal(snapshot.protocol,22);
});

test('a status record left by an exited agent does not make the shell an agent',()=>{
  const pane=corePane(terminal('t1',{status:{app:'claude-code',state:'idle'}}),'core1');
  assert.equal(pane.agent,undefined);assert.equal(pane.agent_status,'unknown');
});

test('terminal identity changes when the agent process changes',()=>{
  const one=corePane(terminal('t1',{foreground:{pid:200,name:'claude',argv:['claude'],cwd:'/w'}}),'core1');
  const two=corePane(terminal('t1',{foreground:{pid:201,name:'claude',argv:['claude'],cwd:'/w'}}),'core1');
  assert.notEqual(one.terminal_id,two.terminal_id);
});

test('a verified read keeps dim, inverse, 256-color and truecolor styling',async t=>{
  const f=await fakeCore(t);
  const {read}=await f.core.call('pane.read',{pane_id:'hc:t1',source:'visible',format:'ansi',strip_ansi:false,lines:120});
  assert.equal(read.truncated,false);
  assert.match(read.text,/\x1b\[0;2mghost text/);assert.match(read.text,/\x1b\[0;7minverse/);
  assert.match(read.text,/\x1b\[0;38;5;246mgray246/);assert.match(read.text,/\x1b\[0;38;2;148;148;148mrgb148/);
  const plain=(await f.core.call('pane.read',{pane_id:'hc:t1',source:'detection',format:'text',strip_ansi:true,lines:120})).read;
  assert.equal(plain.text,fixture.text);
  // Observe-only: the read never types or resizes.
  assert.ok(f.calls.filter(c=>c.method==='terminal.attach').every(c=>c.params.observe===true&&c.params.cols===fixture.cols));
});

test('reads fail closed on a missing trailer, split or extra frames, trailing output, text mismatch or resize',async t=>{
  const text=paint.toString('utf8');const cut=text.lastIndexOf('\x1b[?9001l');
  const cases={
    'missing trailer':{frames:[Buffer.from(text.slice(0,cut))]},
    'split paint':{frames:[Buffer.from(text.slice(0,200)),Buffer.from(text.slice(200))]},
    'extra frame':{frames:[paint,Buffer.from('x')]},
    'output after trailer':{frames:[Buffer.concat([paint,Buffer.from('late')])]},
    'no paint':{frames:[]},
    'text mismatch':{readText:'something else'},
    'resized during read':{afterGet:value=>{value.cols-=1;}},
  };
  for(const [name,options] of Object.entries(cases)) {
    const f=await fakeCore(t,options);
    const {read}=await f.core.call('pane.read',{pane_id:'hc:t1',source:'visible',format:'ansi',strip_ansi:false,lines:120});
    assert.equal(read.truncated,true,name);
  }
});

test('typed text goes through a same-size attach as raw bytes; newline is Enter; keys use hc',async t=>{
  const f=await fakeCore(t);
  await f.core.call('pane.send_input',{pane_id:'hc:t1',text:'héllo ?\nnext',keys:['enter']});
  await f.core.call('pane.send_text',{pane_id:'hc:t1',text:'Ünï'});
  const attaches=f.calls.filter(c=>c.method==='terminal.attach');
  assert.deepEqual(attaches.map(c=>[c.params.observe,c.params.cols,c.params.rows]),[[false,fixture.cols,fixture.rows],[false,fixture.cols,fixture.rows]]);
  assert.deepEqual(f.writes,['héllo ?\rnext','Ünï']);
  assert.deepEqual(f.calls.find(c=>c.method==='terminal.keys').params,{terminal:'t1',keys:['enter']});
});

test('agents start atomically in a new app terminal; agent.start is refused',async t=>{
  const f=await fakeCore(t);
  const created=await f.core.call('tab.create',{workspace_id:'hc:sp1',cwd:'/work',label:'job',focus:false,agent_kind:'claude',agent_name:'job'});
  assert.deepEqual(created,{root_pane:{pane_id:'hc:t9'},agent_started:true});
  const run=f.calls.find(c=>c.method==='terminal.run').params;
  assert.deepEqual([run.argv,run.cwd,run.keep,run.labels],[['claude'],'/work',true,{'herdr.space':'sp1','herdr-remote.name':'job'}]);
  await assert.rejects(f.core.call('agent.start',{pane_id:'hc:t9',kind:'claude'}),{code:'agent_start_unsupported'});
  await assert.rejects(f.core.call('pane.get',{pane_id:'w1:p1'}),{code:'pane_not_found'});
});

test('launcher waits for readiness instead of agent.start when the backend already started the agent',async t=>{
  const {createLauncher}=await import('../src/agent-launch.js');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-launch-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const calls=[];let gets=0;
  const herdr={call:async(method,params)=>{
    calls.push([method,params]);
    if(method==='workspace.create')return {root_pane:{pane_id:'hc:t9'},agent_started:true};
    // A just-created terminal reports its agent once the program is up.
    if(method==='agent.get'){if(++gets<2)throw Object.assign(new Error('starting'),{code:'agent_not_found'});return {agent:{interactive_ready:true}};}
    throw new Error(`unexpected ${method}`);
  }};
  const launcher=createLauncher({herdr,directories:{record(){}}});
  assert.deepEqual(await launcher.start({path:dir,label:'P'},'claude','job'),{paneId:'hc:t9'});
  assert.deepEqual(calls[0],['workspace.create',{cwd:fs.realpathSync(dir),label:'P',focus:false,agent_kind:'claude',agent_name:'job'}]);
  assert.equal(calls.some(([method])=>method==='agent.start'),false);
});

const agentTerminal=(extra={})=>terminal('t1',{foreground:{pid:200,name:'claude',argv:['claude'],cwd:'/work'},
  status:{app:'claude-code',state:'working'},...extra});

test('status words are the agent\'s own; a finished turn is unseen until the Herdr app marks it seen',()=>{
  const unseen=corePane(agentTerminal({status:{app:'claude-code',state:'done'},turn:3,labels:{'herdr.space':'sp1','herdr.seen':'2'}}),'c');
  const seen=corePane(agentTerminal({status:{app:'claude-code',state:'idle'},turn:3,labels:{'herdr.space':'sp1','herdr.seen':'3'}}),'c');
  const blocked=corePane(agentTerminal({status:{app:'claude-code',state:'blocked',kind:'permission',msg:'Allow rm -rf build?'}}),'c');
  const busy=corePane(agentTerminal({status:{app:'claude-code',state:'working',msg:'Running tests',progress:40}}),'c');
  assert.deepEqual([unseen.agent_status,seen.agent_status,blocked.agent_status,busy.agent_status],['done','idle','blocked','working']);
  assert.deepEqual([blocked.blocked_kind,blocked.activity,busy.activity,busy.progress],['permission','Allow rm -rf build?','Running tests',40]);
  assert.equal(corePane(agentTerminal({status:{app:'claude-code',state:'error'}}),'c').agent_status,'error');
});

test('control authority comes from the foreground process; a reported app name only labels the pane',()=>{
  const reporter=terminal('t1',{foreground:{pid:300,name:'python3',argv:['python3','tool.py'],cwd:'/w'},status:{app:'pi',state:'working'}});
  assert.equal(agentKind(reporter),null);
  assert.equal(displayKind(reporter),'pi');
  const pane=corePane(reporter,'c');
  assert.equal(pane.agent,undefined);assert.equal(pane.display_kind,'pi');
  const nodeCodex=terminal('t1',{foreground:{pid:301,name:'node',argv:['node','/usr/lib/node_modules/@openai/codex/bin/codex.js'],cwd:'/w'}});
  assert.equal(agentKind(nodeCodex),'codex');
  // A stale record from an exited program does not label the shell.
  assert.equal(displayKind(terminal('t1',{status:{app:'pi',state:'idle'}})),null);
});

test('only a turn the bridge saw finish is eligible for an alert',()=>{
  const t=agentTerminal({status:{app:'claude-code',state:'done'},turn:4});
  assert.equal(corePane(t,'c',{turn:4,state:'done',baseline:true}).completionEligible,false);
  const seen=corePane(t,'c',{turn:4,state:'done',baseline:false});
  assert.deepEqual([seen.completionEligible,seen.nativeTurnId,seen.bindingVerification],[true,'4','verified']);
  // An older finished turn stays the completion while a later turn runs.
  const running=corePane(agentTerminal({turn:5}),'c',{turn:4,state:'done',baseline:false});
  assert.deepEqual([running.agent_status,running.nativeTurnId,running.completionEligible],['working','4',true]);
});

/** A fake herdr-core event stream: answers the subscription, then lets the test push events. */
async function fakeEvents(t,terminals) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hc-events-'));const socketPath=path.join(dir,'core.sock');
  const sockets=[];
  const server=net.createServer(socket=>{
    sockets.push(socket);
    let buffer='';
    socket.on('data',chunk=>{buffer+=chunk;const end=buffer.indexOf('\n');if(end<0)return;const message=JSON.parse(buffer.slice(0,end));buffer='';
      socket.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{seq:1,terminals}})+'\n');});
  });
  server.listen(socketPath);await once(server,'listening');
  t.after(()=>{for(const socket of sockets)socket.destroy();server.close();fs.rmSync(dir,{recursive:true,force:true});});
  const send=params=>sockets.at(-1).write(JSON.stringify({jsonrpc:'2.0',method:'event',params})+'\n');
  return {socketPath,send,sockets};
}
const until=async(predicate,ms=2000)=>{const end=Date.now()+ms;while(!predicate()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(predicate());};

test('core events: snapshot turns are a baseline, observed turn events are completions, removal forgets',async t=>{
  const f=await fakeEvents(t,[{address:'t1',turn:2,status:{state:'done'}},{address:'t2',turn:0,status:{state:'working'}}]);
  let changes=0;
  const events=createCoreEvents(f.socketPath,{onChange:()=>changes++});t.after(()=>events.close());
  await until(()=>events.healthy);
  assert.deepEqual(events.completionFor('t1'),{turn:2,state:'done',baseline:true});
  assert.equal(events.completionFor('t2'),null);
  f.send({type:'turn',terminal:'t2',seq:2,data:{state:'blocked',turn:1}});
  f.send({type:'turn',terminal:'t2',seq:3,data:{state:'done',turn:2}});
  await until(()=>events.completionFor('t2')?.turn===2);
  assert.deepEqual(events.completionFor('t2'),{turn:2,state:'done',baseline:false});
  // A subscriber that fell behind gets a fresh snapshot; its gap is a baseline, known turns stay.
  f.sockets.at(-1).write(JSON.stringify({jsonrpc:'2.0',method:'missed',params:{seq:9,terminals:[{address:'t2',turn:3,status:{state:'idle'}}]}})+'\n');
  await until(()=>events.completionFor('t2')?.turn===3);
  assert.equal(events.completionFor('t2').baseline,true);
  assert.equal(events.completionFor('t1'),null);
  f.send({type:'removed',terminal:'t2',seq:10,data:{}});
  await until(()=>events.completionFor('t2')===null);
  assert.ok(changes>=4);
});

test('core events reconnect after the core goes away and resubscribe',async t=>{
  const f=await fakeEvents(t,[]);
  const events=createCoreEvents(f.socketPath,{onChange:()=>{}});t.after(()=>events.close());
  await until(()=>events.healthy);
  f.sockets.at(-1).destroy();
  await until(()=>!events.healthy);
  await until(()=>events.healthy&&f.sockets.length===2,3000);
});

test('a finished turn alerts once, survives a bridge restart unacknowledged, and is acknowledged when seen on the desktop',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-alerts-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let completion={turn:1,state:'done',baseline:true},state={app:'claude-code',state:'done'},turn=1,seen='0';
  const raw=()=>({snapshot:{protocol:22,workspaces:[{workspace_id:'hc:sp1',label:'App'}],agents:[],
    panes:[corePane(agentTerminal({status:state,turn,labels:{'herdr.space':'sp1','herdr.seen':seen}}),'core',completion)]}});
  const open=()=>{
    const store=new Store(path.join(dir,'state'));
    const app=createBridge({socketPath:'/unused',stateDir:path.join(dir,'state'),projects:[],activityTimeline:false},
      {herdr:{call:async()=>raw()},store,push:createPushMonitor({},store)});
    return app;
  };
  const refreshed=app=>app.refresh();
  let app=open();
  // Baseline: the bridge did not see turn 1 finish.
  let pane=(await refreshed(app)).panes[0];
  assert.equal(pane.completionEventId??null,null);
  // Turn 2 runs, then the bridge sees it finish (an hc turn event), while turn 3 already started.
  state={app:'claude-code',state:'working'};turn=1;await refreshed(app);
  completion={turn:2,state:'done',baseline:false};turn=2;state={app:'claude-code',state:'working'};
  pane=(await refreshed(app)).panes[0];
  assert.ok(pane.completionEventId,'completion alert created');
  assert.equal(pane.completionAcknowledged,false);
  const eventId=pane.completionEventId;
  await app.close();
  // The bridge restarts: the outstanding alert keeps its id and stays unacknowledged.
  app=open();
  pane=(await refreshed(app)).panes[0];
  assert.equal(pane.completionEventId,eventId);assert.equal(pane.completionAcknowledged,false);
  // Viewing turn 2 in the Herdr app acknowledges it.
  state={app:'claude-code',state:'idle'};seen='2';
  pane=(await refreshed(app)).panes[0];
  assert.equal(pane.completionEventId,eventId);assert.equal(pane.completionAcknowledged,true);
  await app.close();
});
