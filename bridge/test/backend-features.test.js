import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createBridge} from '../src/server.js';
import {Operations} from '../src/operations.js';
import {Store} from '../src/store.js';
import {BridgeError} from '../src/herdr.js';
import {reviewProject} from '../src/review.js';

async function fixture(t, {herdr:override,statusEventsFactory}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-backend-')); const calls=[];
  const pane={pane_id:'w1:p1',terminal_id:'terminal-1',workspace_id:'w1',tab_id:'t1',cwd:dir,revision:1,agent_status:'working',agent:'codex',name:'agent'};
  const herdr=override||{call:async(method,params)=>{calls.push({method,params});
    if(method==='session.snapshot')return {snapshot:{protocol:22,workspaces:[{workspace_id:'w1',label:'Project'}],panes:[pane],agents:[pane]}};
    if(method==='pane.get')return {pane}; if(method==='pane.read')return {read:{text:'ok',revision:1,truncated:false}}; return {type:'ok'};
  }};
  const app=createBridge({socketPath:'/unused',stateDir:path.join(dir,'state'),projects:[{id:'project',label:'Project',path:dir}],allowTerminalInput:true},{herdr,statusEventsFactory});
  app.server.listen(0,'127.0.0.1'); await once(app.server,'listening'); const url=`http://127.0.0.1:${app.server.address().port}`;
  const credential=app.store.pair(app.store.pairCode(),'phone');
  const request=(route,method='GET',body,token=credential.token,headers={})=>fetch(url+route,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {app,url,request,credential,herdr,calls,pane,dir};
}

test('mutating operation receipt deduplicates by device and reports status',async t=>{
  const f=await fixture(t); const headers={'X-Operation-Id':'send-1234'};
  assert.equal((await f.app.snapshot()).panes[0].lastActivity,null);
  const {attachmentId}=await(await f.request('/v1/panes/w1%3Ap1/output')).json();
  let r=await f.request('/v1/panes/w1%3Ap1/keys','POST',{keys:['enter'],attachmentId},f.credential.token,headers); assert.equal(r.status,200); const first=await r.json(); assert.equal(first.operationId,'send-1234');
  r=await f.request('/v1/panes/w1%3Ap1/keys','POST',{keys:['enter'],attachmentId},f.credential.token,headers); assert.equal(r.status,200); assert.equal((await r.json()).replayed,true);
  assert.equal(f.calls.filter(c=>c.method==='pane.send_keys').length,1);
  const activity=(await f.app.snapshot()).panes[0].lastActivity;
  assert.ok(Number.isFinite(Date.parse(activity)));
  assert.equal((await f.app.snapshot()).panes[0].lastActivity,activity);
  const status=await (await f.request('/v1/operations/send-1234')).json(); assert.equal(status.status,'succeeded');
  r=await f.request('/v1/panes/w1%3Ap1/keys','POST',{keys:['esc'],attachmentId},f.credential.token,headers); assert.equal(r.status,409); assert.equal((await r.json()).error.code,'operation_conflict');
});

test('running receipts recover as uncertain after a bridge restart',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-receipt-')); const store=new Store(dir); const op=new Operations(store); const record=op.begin('device','crash-1234','signature','pane.keys').record;
  assert.equal(record.status,'running'); const recovered=new Operations(new Store(dir)); assert.equal(recovered.status('device','crash-1234').status,'uncertain');
  assert.throws(()=>recovered.begin('device','crash-1234','signature','pane.keys'),e=>e.code==='operation_uncertain'); fs.rmSync(dir,{recursive:true,force:true});
});

test('attachment inventory and deletion stay scoped to owning device',async t=>{
  const f=await fixture(t); const upload=await fetch(`${f.url}/v1/panes/w1%3Ap1/attachments`,{method:'POST',headers:{Authorization:`Bearer ${f.credential.token}`,'Content-Type':'application/octet-stream','X-Attachment-Name':'hello.txt'},body:'hello'}); assert.equal(upload.status,201); const item=await upload.json();
  const listed=await (await f.request('/v1/attachments')).json(); assert.equal(listed.attachments.length,1); assert.equal(listed.usedBytes,5); assert.equal(listed.quotaBytes,200*1024*1024);
  const other=f.app.store.pair(f.app.store.pairCode(),'other'); assert.equal((await f.request('/v1/attachments','GET',undefined,other.token)).status,200); assert.equal((await (await f.request('/v1/attachments','GET',undefined,other.token)).json()).attachments.length,0);
  assert.equal((await f.request(`/v1/panes/w1%3Ap1/attachments/${item.id}`,'DELETE',undefined,other.token)).status,403);
  assert.equal((await f.request(`/v1/panes/w1%3Ap1/attachments/${item.id}`,'DELETE')).status,200); assert.equal(fs.existsSync(f.app.store.read('attachments.json',[])[0]?.file||''),false);
});

test('attachment listing and deletion refuse symlinked file paths without touching targets',async t=>{
  const f=await fixture(t); const upload=await fetch(`${f.url}/v1/panes/w1%3Ap1/attachments`,{method:'POST',headers:{Authorization:`Bearer ${f.credential.token}`,'Content-Type':'application/octet-stream','X-Attachment-Name':'safe.txt'},body:'safe'}); const item=await upload.json();
  const record=f.app.store.read('attachments.json')[0]; const outside=path.join(f.dir,'outside.txt'); fs.writeFileSync(outside,'do not remove'); fs.unlinkSync(record.file); fs.symlinkSync(outside,record.file); f.app.store.write('attachments.json',[record]);
  assert.equal((await (await f.request('/v1/attachments')).json()).attachments.length,0); assert.equal((await f.request(`/v1/panes/w1%3Ap1/attachments/${item.id}`,'DELETE')).status,200); assert.equal(fs.readFileSync(outside,'utf8'),'do not remove');
});

test('diagnostics and review are authenticated and review is read only',async t=>{
  const f=await fixture(t); execFileSync('git',['init','-q'],{cwd:f.dir}); const diagnostics=await (await f.request('/v1/diagnostics')).json(); assert.equal(diagnostics.bridgeOnline,true); assert.equal(diagnostics.sessionResumeSupported,false);
  const review=await (await f.request('/v1/panes/w1%3Ap1/review')).json(); assert.equal(review.available,true); assert.equal(review.tests.status,'unknown'); assert.ok(typeof review.status==='string');
  assert.equal((await f.request('/v1/diagnostics','GET',undefined,'bad')).status,401);
});

test('timeout after mutation is uncertain, returns receipt ID and is never executed twice',async t=>{
  let mutations=0;const f=await fixture(t,{herdr:{call:async()=>{mutations++;throw new BridgeError('herdr_timeout','It may have completed.',504);}}});
  const send=()=>f.request('/v1/panes/w1%3Ap1/keys','POST',{keys:['enter']},f.credential.token,{'X-Operation-Id':'timeout-1234'});
  const first=await send();assert.equal(first.status,504);const error=(await first.json()).error;assert.equal(error.operationId,'timeout-1234');assert.equal(error.operationStatus,'uncertain');
  assert.equal((await send()).status,409);assert.equal(mutations,1);assert.equal((await(await f.request('/v1/operations/timeout-1234')).json()).status,'uncertain');
  const other=f.app.store.pair(f.app.store.pairCode(),'other');assert.equal((await f.request('/v1/operations/timeout-1234','GET',undefined,other.token)).status,404);
});

test('receipt capacity rejects before mutation, TTL prunes old records, running receipts are retained',async t=>{
  const f=await fixture(t);let now=2000000000000,calls=0;const o=new Operations(new Store(path.join(f.dir,'receipts')),{now:()=>now,maxRecords:2,ttl:1000});
  await o.run('d','success-1','keys',{},async()=>{calls++;});o.begin('d','running-1','sig','keys');
  await assert.rejects(o.run('d','capacity-1','keys',{},async()=>{calls++;}),e=>e.code==='operation_capacity');assert.equal(calls,1);
  now+=1001;assert.throws(()=>o.status('d','success-1'),e=>e.status===404);assert.equal(o.status('d','running-1').status,'running');
  await o.run('d','success-2','keys',{},async()=>{calls++;});assert.equal(calls,2);
});

test('malformed Herdr responses and partial starts remain uncertain; internal errors are redacted',async t=>{
  const f=await fixture(t);const o=new Operations(new Store(path.join(f.dir,'receipts')));
  for(const code of ['invalid_response','response_too_large']) {
    await assert.rejects(o.run('d',code,'keys',{},async()=>{throw new BridgeError(code,'Bad response');}));assert.equal(o.status('d',code).status,'uncertain');
  }
  await assert.rejects(o.run('d','private-error','keys',{},async()=>{throw Error('private secret');}));assert.equal(JSON.stringify(o.status('d','private-error')).includes('private secret'),false);
  const e=new BridgeError('startup_blocked','Retained pane');e.paneId='replacement';await assert.rejects(o.run('d','partial-start','create',{},async()=>{throw e;}));assert.equal(o.status('d','partial-start').status,'uncertain');
});

test('attachment content validates ownership, current size and symlinks; deletion replay is idempotent',async t=>{
  const f=await fixture(t);const upload=await fetch(f.url+'/v1/panes/w1%3Ap1/attachments',{method:'POST',headers:{Authorization:'Bearer '+f.credential.token,'Content-Type':'application/octet-stream','X-Attachment-Name':'file.txt'},body:'old'});const item=await upload.json();
  const record=f.app.store.read('attachments.json')[0];fs.writeFileSync(record.file,'new longer bytes');
  const content=await f.request(`/v1/attachments/${item.id}/content`);assert.equal(content.headers.get('content-length'),'16');assert.equal(await content.text(),'new longer bytes');
  const other=f.app.store.pair(f.app.store.pairCode(),'other');assert.equal((await f.request(`/v1/attachments/${item.id}/content`,'GET',undefined,other.token)).status,404);
  const outside=path.join(f.dir,'private.txt');fs.writeFileSync(outside,'private');fs.unlinkSync(record.file);fs.symlinkSync(outside,record.file);assert.equal((await f.request(`/v1/attachments/${item.id}/content`)).status,404);
  const route=`/v1/panes/w1%3Ap1/attachments/${item.id}`,headers={'X-Operation-Id':'delete-1234'};
  assert.equal((await f.request(route,'DELETE',undefined,f.credential.token,headers)).status,200);assert.equal((await(await f.request(route,'DELETE',undefined,f.credential.token,headers)).json()).replayed,true);assert.equal(fs.readFileSync(outside,'utf8'),'private');
});

test('Git review disables configured textconv, external diff and fsmonitor executables',async t=>{
  const f=await fixture(t);const git=(...args)=>execFileSync('git',args,{cwd:f.dir});git('init','-q');
  fs.writeFileSync(path.join(f.dir,'file.txt'),'before\n');fs.writeFileSync(path.join(f.dir,'.gitattributes'),'*.txt diff=malicious\n');git('add','.gitattributes','file.txt');git('-c','user.name=Test','-c','user.email=test@example.com','commit','-qm','base');
  const hook=path.join(f.dir,'hook.sh'),marker=path.join(f.dir,'executed');fs.writeFileSync(hook,'#!/bin/sh\ntouch "'+marker+'"\n',{mode:0o700});git('config','diff.malicious.textconv',hook);git('config','diff.external',hook);git('config','core.fsmonitor',hook);fs.writeFileSync(path.join(f.dir,'file.txt'),'after\n');
  const review=await(await f.request('/v1/panes/w1%3Ap1/review')).json();assert.equal(review.available,true);assert.match(review.diff,/after/);assert.equal(fs.existsSync(marker),false);
  const nested=path.join(f.dir,'nested');fs.mkdirSync(nested);await assert.rejects(reviewProject({projects:[{id:'nested',path:nested}]},nested,{list:()=>({attachments:[]})},'d','p'),e=>e.code==='project_not_allowed');
});

test('plain project results expose PNG/PDF files with authenticated bounded artifact access',async t=>{
  const f=await fixture(t);fs.mkdirSync(path.join(f.dir,'outputs'));fs.writeFileSync(path.join(f.dir,'outputs','screen.png'),'png-data');fs.writeFileSync(path.join(f.dir,'outputs','report.pdf'),'pdf-data');fs.writeFileSync(path.join(f.dir,'outputs','.env'),'private');
  const review=await(await f.request('/v1/panes/w1%3Ap1/review')).json();assert.equal(review.available,false);assert.deepEqual(review.artifacts.map(a=>a.name).sort(),['outputs/report.pdf','outputs/screen.png']);
  const png=review.artifacts.find(a=>a.name.endsWith('.png'));assert.equal(png.source,'project');assert.equal(png.file,undefined);
  const file=await f.request(png.url);assert.equal(file.status,200);assert.equal(file.headers.get('content-type'),'image/png');assert.equal(await file.text(),'png-data');assert.equal((await f.request(png.url,'GET',undefined,'bad')).status,401);
  assert.equal((await f.request('/v1/panes/w1%3Ap1/artifacts/project-'+ '0'.repeat(64))).status,404);
  assert.equal((await f.request('/v1/panes/w1%3Ap1/artifacts/%2e%2e%2f.env')).status,404);
  f.pane.cwd=os.tmpdir();assert.equal((await f.request(png.url)).status,403);
});

test('project artifact scan excludes credentials, symlinks, hardlinks, hidden files and oversized files',async t=>{
  const f=await fixture(t);const folder=path.join(f.dir,'artifacts');fs.mkdirSync(folder);const outside=path.join(f.dir,'private.txt');fs.writeFileSync(outside,'private');fs.symlinkSync(outside,path.join(folder,'linked.txt'));fs.linkSync(outside,path.join(folder,'hard.txt'));for(const name of ['.secret.json','secrets.json','credentials.json','private.pem','access.token'])fs.writeFileSync(path.join(folder,name),'secret');const large=path.join(folder,'large.pdf');fs.writeFileSync(large,'');fs.truncateSync(large,20*1024*1024+1);fs.writeFileSync(path.join(folder,'safe.pdf'),'safe');
  let review=await(await f.request('/v1/panes/w1%3Ap1/review')).json();assert.deepEqual(review.artifacts.map(a=>a.name),['artifacts/safe.pdf']);
  const url=review.artifacts[0].url;fs.unlinkSync(path.join(folder,'safe.pdf'));fs.symlinkSync(outside,path.join(folder,'safe.pdf'));assert.equal((await f.request(url)).status,404);
  fs.renameSync(folder,path.join(f.dir,'old-artifacts'));fs.symlinkSync(path.join(f.dir,'old-artifacts'),folder);review=await(await f.request('/v1/panes/w1%3Ap1/review')).json();assert.equal(review.artifacts.length,0);
});

test('rename accepts human titles, updates snapshot label and deduplicates receipts',async t=>{
  const f=await fixture(t); const original=f.herdr.call;
  f.herdr.call=async(method,params)=>{const result=await original(method,params);if(method==='pane.rename')f.pane.label=params.label;return result;};
  const send=()=>f.request('/v1/panes/w1%3Ap1/rename','POST',{title:' Fix login flow '},f.credential.token,{'X-Operation-Id':'rename-1234'});
  assert.equal((await send()).status,200);
  assert.equal((await(await send()).json()).replayed,true);
  assert.deepEqual(f.calls.filter(c=>c.method==='pane.rename'),[{method:'pane.rename',params:{pane_id:'w1:p1',label:'Fix login flow'}}]);
  const snapshot=await(await f.request('/v1/snapshot')).json();
  assert.equal(snapshot.sessionRenameEnabled,true);assert.equal(snapshot.panes[0].title,'Fix login flow');assert.equal(f.pane.name,'agent');
  for(const title of ['', '   ', 'bad\nname', 'name\n', 'bad\u0085name', 'x'.repeat(121), 42]) {
    assert.equal((await f.request('/v1/panes/w1%3Ap1/rename','POST',{title})).status,400);
  }
  assert.equal(f.calls.filter(c=>c.method==='pane.rename').length,1);
  assert.equal((await f.request('/v1/panes/w1%3Ap1/rename','POST',{title:'Secret'},'invalid')).status,401);
});

test('desktop handoff focuses only the requested live pane and is replay safe',async t=>{
  const f=await fixture(t);const send=()=>f.request('/v1/panes/w1%3Ap1/focus','POST',{},f.credential.token,{'X-Operation-Id':'focus-1234'});
  assert.equal((await(await send()).json()).focused,true);assert.equal((await(await send()).json()).replayed,true);
  assert.deepEqual(f.calls,[{method:'pane.get',params:{pane_id:'w1:p1'}},{method:'pane.focus',params:{pane_id:'w1:p1'}}]);
  assert.equal((await f.request('/v1/panes/w1%3Ap1/focus','POST',{command:'something'})).status,400);
  assert.equal((await f.request('/v1/panes/w1%3Ap1/focus','POST',{},'invalid')).status,401);
  f.herdr.call=async()=>{throw new BridgeError('not_found','Pane has closed.',404);};
  assert.equal((await f.request('/v1/panes/w1%3Ap1/focus','POST',{})).status,404);
  assert.equal((await f.request('/v1/panes/w1%3Ap1/rename','POST',{title:'Closed'})).status,404);
});

test('snapshot associates canonical descendants with the most specific configured project',async t=>{
  const f=await fixture(t);const nested=path.join(f.dir,'nested');fs.mkdirSync(nested);fs.mkdirSync(path.join(nested,'src'));
  const sibling=f.dir+'-other';fs.mkdirSync(sibling);t.after(()=>fs.rmSync(sibling,{recursive:true,force:true}));
  const app=createBridge({stateDir:path.join(f.dir,'nested-state'),projects:[{id:'outer',label:'Outer',path:f.dir},{id:'inner',label:'Inner',path:nested}]},{herdr:f.herdr});t.after(()=>app.close());
  f.pane.foreground_cwd=path.join(nested,'src');let s=await app.snapshot();assert.equal(s.panes[0].projectId,'inner');assert.equal(s.panes[0].projectLabel,'Inner');
  f.pane.foreground_cwd=sibling;s=await app.snapshot();assert.equal(s.panes[0].projectId,null);
  f.pane.foreground_cwd=path.join(f.dir,'alias');fs.symlinkSync(nested,f.pane.foreground_cwd);s=await app.snapshot();assert.equal(s.panes[0].projectId,'inner');
});

test('pane activity survives bridge restart without promoting unobserved or replaced panes',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-activity-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const panes=[
    {pane_id:'w:p1',terminal_id:'terminal-1',workspace_id:'w',tab_id:'tab-1',agent:'codex',agent_status:'working',revision:8,terminal_title_stripped:'First'},
    {pane_id:'w:p2',terminal_id:'terminal-2',workspace_id:'w',tab_id:'tab-2',agent:'claude',agent_status:'done',revision:4}
  ];
  const herdr={call:async method=>{
    assert.equal(method,'session.snapshot');
    return {snapshot:{protocol:22,workspaces:[{workspace_id:'w'}],panes,agents:[]}};
  }};
  const config={stateDir:path.join(dir,'state'),projects:[],activityTimeline:false};
  const first=createBridge(config,{herdr});
  t.after(()=>first.close());
  const initial=await first.snapshot();
  assert.deepEqual(initial.panes.map(p=>p.lastActivity),[null,null]);
  panes[0].terminal_title_stripped='Renamed';
  assert.equal((await first.snapshot()).panes[0].lastActivity,null);
  panes[0].revision=9;
  const active=(await first.snapshot()).panes[0].lastActivity;
  assert.ok(Number.isFinite(Date.parse(active)));
  assert.equal((await first.snapshot()).panes[1].lastActivity,null);
  await first.close();

  // Output produced while this bridge was down has no known event time.
  panes[0].revision=12;
  panes[1].revision=7;
  const restarted=createBridge(config,{herdr});
  t.after(()=>restarted.close());
  assert.deepEqual((await restarted.snapshot()).panes.map(p=>p.lastActivity),[active,null]);
  panes[1].agent_status='working';
  assert.ok(Number.isFinite(Date.parse((await restarted.snapshot()).panes[1].lastActivity)));
  panes[0].terminal_id='replacement-terminal';
  assert.equal((await restarted.snapshot()).panes[0].lastActivity,null);
  panes.splice(0,1);
  await restarted.snapshot();
  panes.unshift({pane_id:'w:p1',terminal_id:'replacement-terminal',workspace_id:'w',tab_id:'tab-1',agent:'codex',agent_status:'done',revision:1});
  assert.equal((await restarted.snapshot()).panes[0].lastActivity,null);
});

test('observed status event dates the pane and retains that time across a bridge restart',async t=>{
  let onStatus;
  const f=await fixture(t,{statusEventsFactory:(_socket,handlers)=>{
    onStatus=handlers.onStatus;
    return {update:()=>{},close:()=>{}};
  }});
  assert.equal((await(await f.request('/v1/snapshot')).json()).panes[0].lastActivity,null);
  f.pane.agent_status='done';
  await onStatus({pane_id:f.pane.pane_id,agent_status:'done'});
  const updated=(await(await f.request('/v1/snapshot')).json()).panes[0];
  assert.equal(updated.status,'done');
  assert.ok(Number.isFinite(Date.parse(updated.lastActivity)));
  const restarted=createBridge({stateDir:path.join(f.dir,'state'),projects:[],activityTimeline:false},{herdr:f.herdr});
  t.after(()=>restarted.close());
  assert.equal((await restarted.snapshot()).panes[0].lastActivity,updated.lastActivity);
});

test('an older in-flight snapshot cannot erase acknowledged input for a replacement pane',async t=>{
  const f=await fixture(t);
  assert.equal((await f.app.snapshot()).panes[0].lastActivity,null);
  const old={...f.pane};
  const original=f.herdr.call;
  let release,heldPanes=[old];
  f.herdr.call=(method,params)=>method==='session.snapshot'&&release===undefined
    ?new Promise(resolve=>{release=()=>resolve({snapshot:{protocol:22,workspaces:[{workspace_id:'w1'}],panes:heldPanes,agents:[]}});})
    :original(method,params);
  const staleFlight=f.app.snapshot();
  assert.equal(typeof release,'function');
  f.pane.terminal_id='replacement-terminal';
  f.pane.revision=2;
  const {attachmentId}=await(await f.request('/v1/panes/w1%3Ap1/output')).json();
  assert.equal((await f.request('/v1/panes/w1%3Ap1/keys','POST',{keys:['enter'],attachmentId})).status,200);
  release();
  assert.equal((await staleFlight).panes[0].lastActivity,null);
  const current=(await f.app.snapshot()).panes[0];
  assert.ok(Number.isFinite(Date.parse(current.lastActivity)));
  assert.equal(current.revision,2);
  // The same ordering also applies when the older RPC had no pane at all.
  release=undefined;
  heldPanes=[];
  const emptyFlight=f.app.snapshot();
  const secondAttachment=(await(await f.request('/v1/panes/w1%3Ap1/output')).json()).attachmentId;
  assert.equal((await f.request('/v1/panes/w1%3Ap1/keys','POST',{keys:['esc'],attachmentId:secondAttachment})).status,200);
  release();
  assert.deepEqual((await emptyFlight).panes,[]);
  assert.ok(Number.isFinite(Date.parse((await f.app.snapshot()).panes[0].lastActivity)));
});
