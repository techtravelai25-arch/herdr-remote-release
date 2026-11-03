import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {HerdrCore,corePane} from '../src/herdr-core.js';
import {createHerdrMux} from '../src/herdr-mux.js';
import {createBridge} from '../src/server.js';
import {Timeline} from '../src/timeline.js';

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

const fake=(name,snapshot,calls)=>({call:async(method,params)=>{
  calls.push([name,method,params]);
  if(method==='session.snapshot'){const value=typeof snapshot==='function'?snapshot():snapshot;if(value instanceof Error)throw value;return {snapshot:value};}
  return {ok:name};
}});
const offline=()=>Object.assign(new Error('offline'),{code:'herdr_offline'});
const tuiSnapshot={protocol:22,focused_pane_id:'w1:p1',workspaces:[{workspace_id:'w1',label:'TUI'}],tabs:[],panes:[{pane_id:'w1:p1'}],agents:[]};
const coreSnapshot={protocol:22,focused_pane_id:null,workspaces:[{workspace_id:'hc:sp1',label:'App'}],tabs:[],panes:[{pane_id:'hc:t1'}],agents:[]};

test('mux merges both backends, routes by prefix and strips launch hints for the TUI',async()=>{
  const calls=[];const mux=createHerdrMux(fake('tui',tuiSnapshot,calls),fake('core',coreSnapshot,calls));
  const {snapshot}=await mux.call('session.snapshot');
  assert.deepEqual(snapshot.panes.map(p=>p.pane_id),['w1:p1','hc:t1']);assert.deepEqual(snapshot.stale_pane_ids,[]);
  assert.equal(snapshot.focused_pane_id,'w1:p1');
  assert.equal((await mux.call('pane.get',{pane_id:'hc:t1'})).ok,'core');
  assert.equal((await mux.call('agent.prompt',{target:'w1:p1'})).ok,'tui');
  await mux.call('tab.create',{workspace_id:'w1',agent_kind:'codex',agent_name:'x',cwd:'/'});
  assert.deepEqual(calls.at(-1),['tui','tab.create',{workspace_id:'w1',cwd:'/'}]);
  assert.equal((await mux.call('workspace.create',{cwd:'/'})).ok,'core');
  assert.equal((await mux.call('ping')).ok,'tui');
});

test('mux keeps a failed backend as stale only if it had panes, and throws when both fail',async()=>{
  const calls=[];let core=coreSnapshot;let tui=offline();
  const mux=createHerdrMux(fake('tui',()=>tui,calls),fake('core',()=>core,calls));
  let {snapshot}=await mux.call('session.snapshot');
  assert.deepEqual(snapshot.panes.map(p=>p.pane_id),['hc:t1']);assert.deepEqual(snapshot.stale_pane_ids,[]);
  core=Object.assign(new Error('timeout'),{code:'herdr_timeout'});tui=tuiSnapshot;
  ({snapshot}=await mux.call('session.snapshot'));
  assert.deepEqual(snapshot.panes.map(p=>p.pane_id),['w1:p1','hc:t1']);assert.deepEqual(snapshot.stale_pane_ids,['hc:t1']);
  assert.equal((await mux.call('workspace.create',{cwd:'/'})).ok,'tui');
  tui=offline();
  await assert.rejects(mux.call('session.snapshot'),{code:'herdr_offline'});
});

test('stale panes are republished unchanged and hidden from push and timeline',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-stale-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const observed=[];
  const push={enabled:true,observe:data=>{observed.push(structuredClone(data));return data;},close:()=>{}};
  const pane=(id,status)=>({pane_id:id,workspace_id:'w1',tab_id:'t1',cwd:'/tmp',revision:1,agent:'opencode',agent_status:status,terminal_title:id});
  let raw={protocol:22,workspaces:[{workspace_id:'w1',label:'P'}],panes:[pane('w1:p1','working'),pane('hc:t1','working')],agents:[],stale_pane_ids:[]};
  const app=createBridge({socketPath:'/unused',stateDir:dir,projects:[],activityTimeline:false},
    {herdr:{call:async()=>({snapshot:structuredClone(raw)})},push,statusEventsFactory:()=>({update(){},close(){}})});
  t.after(()=>app.close());
  const first=await app.snapshot();
  assert.equal(first.panesComplete,true);
  raw={...raw,panes:[pane('w1:p1','done'),pane('hc:t1','done')],stale_pane_ids:['hc:t1']};
  const second=await app.snapshot();
  assert.equal(second.panesComplete,false);assert.deepEqual(second.stalePaneIds,['hc:t1']);
  assert.deepEqual(second.panes.find(p=>p.id==='hc:t1'),first.panes.find(p=>p.id==='hc:t1'),'stale pane is the last published object');
  assert.equal(second.panes.find(p=>p.id==='w1:p1').status,'done');
  // The 1 s poll publishes: push must not see the stale pane, so its tracking cannot advance.
  const deadline=Date.now()+3000;
  while(!observed.some(s=>s.panesComplete===false)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
  const incomplete=observed.find(s=>s.panesComplete===false);
  assert.ok(incomplete,'an incomplete snapshot was published');
  assert.deepEqual(incomplete.panes.map(p=>p.id),['w1:p1']);
  const timeline=new Timeline({read:()=>[],write(){}});
  timeline.observe({...first,panes:first.panes});
  timeline.observe({...second,panes:second.panes.filter(p=>p.id!=='hc:t1')});
  assert.equal(timeline.baseline.get('hc:t1'),'working','an incomplete snapshot keeps omitted baselines');
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
