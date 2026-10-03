import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {createBridge} from '../src/server.js';
import {Directories} from '../src/directories.js';
import {Store} from '../src/store.js';
import {Attachments} from '../src/attachments.js';
import {BridgeError} from '../src/herdr.js';
import {associatedProject} from '../src/projects.js';

async function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'remote-directory-test-'));
 const home=path.join(root,'home'),outside=path.join(root,'outside'),stateDir=path.join(root,'state');
 fs.mkdirSync(home);fs.mkdirSync(outside);
 const calls=[];const pane={pane_id:'w1:p1',workspace_id:'w1',cwd:home,agent:'codex',agent_status:'idle',revision:1};
 let failure=null;
 const herdr={call:async(method,params)=>{
  calls.push({method,params});
  if(method==='session.snapshot')return {snapshot:{protocol:22,workspaces:[],panes:[pane],agents:[pane]}};
  if(method==='agent.list')return {agents:[]};
  if(method==='pane.get')return {pane};
  if(method==='agent.get')return {agent:{...pane,name:'original'}};
  if(method==='workspace.create'||method==='tab.create')return {root_pane:{pane_id:'w1:p2'}};
  if(method==='agent.start'&&failure)throw failure;
  return {type:'ok'};
 }};
 const config={socketPath:'/unused',stateDir,projects:[{id:'outside',label:'Approved external',path:outside}]};
 const app=createBridge(config,{herdr,homeDirectory:home});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 const token=app.store.pair(app.store.pairCode(),'Test phone').token;
 const base=`http://127.0.0.1:${app.server.address().port}`;
 const request=(route,method='GET',body,headers={})=>fetch(base+route,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,home,outside,stateDir,app,request,calls,pane,config,base,token,fail(error){failure=error;}};
}
const route=directory=>'/v1/directories?path='+encodeURIComponent(directory);

test('terminal creation resolves home folders, rejects escapes and permits configured external projects',async t=>{
 const f=await fixture(t);const nested=path.join(f.home,'shell folder');fs.mkdirSync(nested);
 const alias=path.join(f.home,'alias');fs.symlinkSync(nested,alias);
 const escape=path.join(f.home,'escape');fs.symlinkSync(f.outside,escape);
 for(const directory of [f.outside,escape]) {
  assert.equal((await f.request('/v1/agents','POST',{directory,kind:'terminal',name:'shell'})).status,403);
 }
 assert.equal(f.calls.length,0);
 assert.equal((await f.request('/v1/agents','POST',{directory:alias,kind:'terminal',name:'shell'})).status,201);
 assert.equal(f.calls.find(c=>c.method==='workspace.create').params.cwd,nested);
 assert.deepEqual((await(await f.request('/v1/directories')).json()).recent.map(d=>d.path),[nested]);
 assert.equal((await f.request('/v1/agents','POST',{projectId:'outside',kind:'terminal',name:'external'})).status,201);
 assert.equal(f.calls.filter(c=>c.method==='workspace.create').at(-1).params.cwd,f.outside);
 assert.ok(!f.calls.some(c=>['agent.start','agent.list','pane.send_input'].includes(c.method)));
});

test('directory browser is authenticated, includes hidden folders and excludes files and escaping links',async t=>{
 const f=await fixture(t);
 fs.mkdirSync(path.join(f.home,'.hidden'));fs.mkdirSync(path.join(f.home,'nested'));
 fs.writeFileSync(path.join(f.home,'file.txt'),'not a folder');
 fs.symlinkSync(f.outside,path.join(f.home,'escape'));fs.symlinkSync(path.join(f.home,'nested'),path.join(f.home,'inside-link'));
 assert.equal((await f.request('/v1/directories','GET',undefined,{Authorization:'Bearer bad'})).status,401);
 const snapshot=await(await f.request('/v1/snapshot')).json();assert.equal(snapshot.directoryBrowsingEnabled,true);
 const listing=await(await f.request('/v1/directories')).json();
 assert.equal(listing.home,f.home);assert.equal(listing.current,f.home);assert.equal(listing.parent,null);assert.equal(listing.nextCursor,null);
 assert.deepEqual(listing.directories.map(d=>d.name),['.hidden','inside-link','nested']);
 assert.equal(listing.directories.find(d=>d.name==='inside-link').path,path.join(f.home,'nested'));
 assert.equal((await(await f.request(route(path.join(f.home,'nested')))).json()).parent,f.home);
 for(const directory of [f.outside,path.dirname(f.home),path.join(f.home,'escape')])assert.equal((await f.request(route(directory))).status,403);
 for(const query of ['?path=relative','?path='+encodeURIComponent(f.home)+'&path='+encodeURIComponent(f.home),'?unexpected=1','?cursor=-1'])assert.equal((await f.request('/v1/directories'+query)).status,400);
 assert.equal((await f.request('/v1/snapshot?path=x')).status,400);
 assert.equal((await f.request(route(path.join(f.home,'file.txt')))).status,409);
});

test('directory pages are stable and allow every folder to be reached',async t=>{
 const f=await fixture(t);for(let i=0;i<205;i++)fs.mkdirSync(path.join(f.home,'folder-'+String(i).padStart(3,'0')));
 const first=await(await f.request('/v1/directories')).json();assert.equal(first.directories.length,200);assert.equal(first.nextCursor,'200');
 const second=await(await f.request('/v1/directories?cursor='+first.nextCursor)).json();assert.equal(second.directories.length,5);assert.equal(second.nextCursor,null);
 assert.equal(new Set([...first.directories,...second.directories].map(d=>d.path)).size,205);
});

test('home and nested directories launch fixed agent kinds, persist bounded recents, and keep per-folder grouping',async t=>{
 const f=await fixture(t);const nested=path.join(f.home,'nested folder');fs.mkdirSync(nested);
 for(const [directory,name] of [[f.home,'home-agent'],[nested,'nested-agent']]) {
  const response=await f.request('/v1/agents','POST',{directory,kind:'codex',name});assert.equal(response.status,201,JSON.stringify(await response.json()));
  assert.equal(f.calls.filter(c=>c.method==='workspace.create').at(-1).params.cwd,directory);
 }
 const alias=path.join(f.home,'alias');fs.symlinkSync(nested,alias);
 assert.equal((await f.request('/v1/agents','POST',{directory:alias,kind:'codex',name:'canonical'})).status,201);
 assert.equal(f.calls.filter(c=>c.method==='workspace.create').at(-1).params.cwd,nested);
 const recent=await(await f.request('/v1/directories')).json();assert.deepEqual(recent.recent.map(d=>d.path),[nested,f.home]);
 assert.deepEqual(new Directories(f.home,new Store(f.stateDir)).recent(),recent.recent);
 f.pane.cwd=nested;const first=(await(await f.request('/v1/snapshot')).json()).panes[0];
 f.pane.cwd=f.home;const second=(await(await f.request('/v1/snapshot')).json()).panes[0];
 assert.notEqual(first.projectId,second.projectId);assert.equal(first.projectLabel,'nested folder');
 assert.equal((await f.request('/v1/agents','POST',{directory:f.outside,kind:'codex',name:'bad'})).status,403);
 assert.equal((await f.request('/v1/agents','POST',{directory:nested,projectId:'outside',kind:'codex',name:'bad'})).status,400);
 assert.equal((await f.request('/v1/agents','POST',{directory:nested,kind:'bash',name:'bad'})).status,400);
 assert.equal((await f.request('/v1/agents','POST',{projectId:'outside',kind:'codex',name:'legacy'})).status,201);
 assert.equal(f.calls.filter(c=>c.method==='workspace.create').at(-1).params.cwd,f.outside);
 const browser=new Directories(f.home,new Store(f.stateDir));
 for(let i=0;i<15;i++){const folder=path.join(f.home,'recent-'+i);fs.mkdirSync(folder);browser.record(folder);}
 assert.equal(browser.recent().length,12);browser.record(nested);assert.equal(browser.recent()[0].path,nested);assert.equal(browser.recent().length,12);
 fs.rmdirSync(nested);assert.ok(!browser.recent().some(d=>d.path===nested));
});

test('folder identity participates in operation receipts and failed launches do not enter recents',async t=>{
 const f=await fixture(t);const nested=path.join(f.home,'nested');fs.mkdirSync(nested);
 const body={directory:f.home,kind:'codex',name:'once'};const headers={'X-Operation-Id':'directory-create-1'};
 assert.equal((await f.request('/v1/agents','POST',body,headers)).status,201);
 const replay=await f.request('/v1/agents','POST',body,headers);assert.equal(replay.status,201);assert.equal((await replay.json()).replayed,true);
 assert.equal((await f.request('/v1/agents','POST',{...body,directory:nested},headers)).status,409);
 assert.equal(f.calls.filter(c=>c.method==='workspace.create').length,1);
 f.fail(new BridgeError('agent_start_failed','Test startup failed.',409));
 assert.equal((await f.request('/v1/agents','POST',{directory:nested,kind:'codex',name:'failure'})).status,409);
 assert.deepEqual((await(await f.request('/v1/directories')).json()).recent.map(d=>d.path),[f.home]);
});

test('recent-list storage failures cannot turn successful startup into a retryable failure',async t=>{
 const f=await fixture(t);const write=f.app.store.write.bind(f.app.store);
 f.app.store.write=(name,data)=>{if(name==='recent-directories.json')throw Error('disk full');return write(name,data);};
 assert.equal((await f.request('/v1/agents','POST',{directory:f.home,kind:'codex',name:'success'})).status,201);
});

test('unreadable or malformed recent history never blocks folder browsing',async t=>{
 const f=await fixture(t);fs.mkdirSync(path.join(f.home,'visible'));
 fs.writeFileSync(path.join(f.stateDir,'recent-directories.json'),'{broken');
 let listing=await(await f.request('/v1/directories')).json();assert.deepEqual(listing.recent,[]);assert.equal(listing.directories[0].name,'visible');
 const read=f.app.store.read.bind(f.app.store);
 f.app.store.read=(name,fallback)=>{if(name==='recent-directories.json')throw Error('unreadable');return read(name,fallback);};
 listing=await(await f.request('/v1/directories')).json();assert.deepEqual(listing.recent,[]);assert.equal(listing.directories[0].name,'visible');
});

test('fresh starts preserve nested home cwd and legacy approved subdirectory cwd',async t=>{
 const f=await fixture(t);
 for(const parent of [f.home,f.outside]) {
  const nested=path.join(parent,'nested');fs.mkdirSync(nested);f.pane.cwd=nested;f.pane.foreground_cwd=parent;
  const response=await f.request('/v1/panes/w1%3Ap1/restart','POST',{});assert.equal(response.status,200,JSON.stringify(await response.json()));
  assert.equal(f.calls.filter(c=>c.method==='tab.create').at(-1).params.cwd,nested);
 }
});

test('home-folder attachments survive bridge policy reload and review permits a Git parent within home',async t=>{
 const f=await fixture(t);const repo=path.join(f.home,'repository'),nested=path.join(repo,'subfolder');fs.mkdirSync(nested,{recursive:true});
 execFileSync('git',['init','--quiet',repo]);f.pane.cwd=nested;
 assert.equal(associatedProject({homeDirectory:f.home,projects:[{id:'subfolder',label:'Subfolder',path:nested}]},nested).authorizationRoot,f.home);
 const rawUpload=()=>fetch(f.base+'/v1/panes/w1%3Ap1/attachments',{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'Content-Type':'application/octet-stream','X-Attachment-Name':'test.txt'},body:'test'});
 const upload=await rawUpload();assert.equal(upload.status,201,JSON.stringify(await upload.clone().json()));const attachment=await upload.json();
 const deviceId=f.app.store.read('devices.json',[])[0].deviceId;
 const reloaded=new Attachments({...f.config,homeDirectory:f.home},new Store(f.stateDir));
 assert.equal(reloaded.file(attachment.id,deviceId).cwd,nested);
 fs.mkdirSync(path.join(nested,'output'));fs.writeFileSync(path.join(nested,'output','result.txt'),'artifact');
 const response=await f.request('/v1/panes/w1%3Ap1/review');assert.equal(response.status,200);const review=await response.json();
 assert.equal(review.available,true);assert.equal(review.root,repo);
 const artifact=review.artifacts.find(item=>item.source==='project');assert.ok(artifact);
 const download=await f.request(artifact.url);assert.equal(download.status,200);assert.equal(await download.text(),'artifact');
 f.pane.cwd=f.root;
 assert.equal((await rawUpload()).status,403);
 assert.equal((await f.request('/v1/panes/w1%3Ap1/review')).status,403);
 assert.equal((await f.request(artifact.url)).status,403);
});
