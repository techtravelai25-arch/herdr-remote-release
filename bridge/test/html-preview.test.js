import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createHtmlPreview} from '../src/html-preview.js';
import {listProjectArtifacts} from '../src/artifacts.js';

function setup(t, options={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-html-preview-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const pane={pane_id:'w:p',workspace_id:'w',tab_id:'t',terminal_id:'one',cwd:root,agent:'codex'};
  const preview=createHtmlPreview({config:{projects:[{id:'project',path:root}],homeDirectory:root},...options});
  // Unit fixtures act for a device with control access unless a test denies it.
  const allow=()=>{};
  const create=(target,deviceId='phone',authorizeLocalhost=allow)=>preview.create({deviceId,pane,target,authorizeLocalhost});
  const read=(id,relative,offset='0',deviceId='phone',authorizeLocalhost=allow)=>preview.read({deviceId,pane,id,relative,offset,authorizeLocalhost});
  return {root,pane,preview,create,read};
}

test('file page and sibling assets stream exact bounded chunks to their owning device',async t=>{
  const f=setup(t);
  fs.mkdirSync(path.join(f.root,'.lavish'));
  fs.writeFileSync(path.join(f.root,'.lavish','report.html'),'<link rel="stylesheet" href="style.css">');
  const css=Buffer.alloc(200000,65);fs.writeFileSync(path.join(f.root,'.lavish','style.css'),css);
  const session=await f.create('.lavish/report.html');
  assert.match(session.id,/^[a-f0-9]{32}$/);assert.equal(session.entryPath,'report.html');assert.equal(session.source,'file');
  const html=await f.read(session.id,'report.html');
  assert.equal(Buffer.from(html.data,'base64url').toString(),'<link rel="stylesheet" href="style.css">');
  assert.equal(html.contentType,'text/html');assert.equal(html.eof,true);
  const first=await f.read(session.id,'style.css');const second=await f.read(session.id,'style.css',String(Buffer.from(first.data,'base64url').length));
  assert.deepEqual(Buffer.concat([Buffer.from(first.data,'base64url'),Buffer.from(second.data,'base64url')]),css);
  assert.equal(second.contentType,'text/css');assert.equal(second.eof,true);
  assert.equal((await f.create(`file://localhost${path.join(f.root,'.lavish','report.html')}:12#chart`)).entryPath,'report.html');
  assert.equal((await f.create('.lavish/report.html:4#chart')).entryPath,'report.html');
  assert.equal((await f.create('./.lavish/report.html')).entryPath,'report.html');
  fs.mkdirSync(path.join(f.root,'output'));
  fs.writeFileSync(path.join(f.root,'output','report.html'),'<p>output</p>');
  assert.equal((await f.create('./output/report.html')).entryPath,'report.html');
  fs.writeFileSync(path.join(f.root,'.lavish','space report.html'),'<p>space</p>');
  assert.equal((await f.create('./.lavish/space%20report.html')).entryPath,'space report.html');
  await assert.rejects(f.create('./.lavish/%252e%252e/report.html'),e=>e.status===400);
  await assert.rejects(f.read(session.id,'report.html','0','other'),e=>e.status===404);
  f.pane.terminal_id='two';await assert.rejects(f.read(session.id,'report.html'),e=>e.status===409);
});

test('file preview rejects traversal, hidden files, links, oversize files and changed pane cwd',async t=>{
  const f=setup(t);fs.mkdirSync(path.join(f.root,'pages'));
  fs.writeFileSync(path.join(f.root,'pages','index.html'),'ok');
  fs.writeFileSync(path.join(f.root,'.env'),'secret');
  fs.writeFileSync(path.join(f.root,'pages','secret.pem'),'secret');
  fs.symlinkSync(path.join(f.root,'.env'),path.join(f.root,'pages','linked.css'));
  fs.linkSync(path.join(f.root,'.env'),path.join(f.root,'pages','hard.css'));
  fs.writeFileSync(path.join(f.root,'pages','huge.css'),'');fs.truncateSync(path.join(f.root,'pages','huge.css'),20*1024*1024+1);
  const s=await f.create('pages/index.html');
  for(const target of ['../index.html','.env','pages/../.env','file:///etc/passwd','pages/.hidden.html'])
    await assert.rejects(f.create(target),e=>e.status>=400,target);
  for(const name of ['../.env','/etc/passwd','.env','secret.pem','linked.css','hard.css','huge.css'])
    await assert.rejects(f.read(s.id,name),e=>e.status>=400,name);
  const elsewhere=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-preview-other-'));t.after(()=>fs.rmSync(elsewhere,{recursive:true,force:true}));
  f.pane.cwd=elsewhere;await assert.rejects(f.read(s.id,'index.html'),e=>e.status===403||e.status===409);
});

test('HTML artifacts are discoverable and preview sessions expire',async t=>{
  let time=1000;const f=setup(t,{now:()=>time});
  fs.mkdirSync(path.join(f.root,'artifacts'));
  fs.writeFileSync(path.join(f.root,'artifacts','report.html'),'<h1>Report</h1>');
  const artifact=listProjectArtifacts({projects:[{id:'project',path:f.root}],homeDirectory:f.root},f.root,f.pane.pane_id)
    .find(item=>item.name==='artifacts/report.html');
  assert.ok(artifact);assert.equal(artifact.source,'project');
  const s=await f.preview.create({deviceId:'phone',pane:f.pane,artifactId:artifact.id});
  assert.equal(s.entryPath,'report.html');
  time+=15*60*1000+1;
  await assert.rejects(f.read(s.id,'report.html'),e=>e.status===404);
});

test('localhost page stays on its selected directory and fetches without forwarded cookies or redirects',async t=>{
  const seen=[];const local=http.createServer((req,res)=>{
    seen.push({url:req.url,headers:req.headers});
    if(req.url==='/site/'){res.writeHead(200,{'content-type':'text/html','set-cookie':'secret=x'});res.end('<img src="image.png">');}
    else if(req.url==='/site/image.png'){setTimeout(()=>{res.writeHead(200,{'content-type':'image/png'});res.end('png');},10);}
    else{res.writeHead(302,{location:'http://evil.test'});res.end();}
  });
  local.listen(0,'127.0.0.1');await once(local,'listening');t.after(()=>local.close());
  const port=local.address().port,f=setup(t,{bridgePort:()=>8787});
  const s=await f.create(`http://localhost:${port}/site/#chart`);
  assert.equal(s.entryPath,'index.html');assert.equal(s.source,'localhost');
  const images=await Promise.all([f.read(s.id,'image.png'),f.read(s.id,'image.png')]);
  assert.equal(Buffer.from(images[0].data,'base64url').toString(),'png');
  assert.equal(images[0].data,images[1].data);
  assert.equal(seen[0].url,'/site/');assert.equal(seen[1].url,'/site/image.png');
  assert.equal(seen.filter(item=>item.url==='/site/image.png').length,1,'concurrent reads share one bounded asset fetch');
  assert.equal(seen[0].headers.cookie,undefined);assert.equal(seen[0].headers.authorization,undefined);
  await assert.rejects(f.read(s.id,'redirect.html'),e=>e.status===404);
  const before=seen.length;
  for(const unsafe of ['delete','api/action','image.png?confirm=yes','../delete.html'])
    await assert.rejects(f.read(s.id,unsafe),e=>e.status>=400);
  assert.equal(seen.length,before,'unsafe resources must be rejected before a local GET');
  for(const target of [`http://localhost:8787/site/`,`http://localhost:${port}/site/?token=x`,`http://user:pass@localhost:${port}/site/`,`http://localhost:${port}/site/../secret.html`,`http://localhost:${port}/.git/site/index.html`,'http://example.com:3000/site/'])
    await assert.rejects(f.create(target),e=>e.status>=400,target);
});

test('localhost pages require control access before any loopback fetch; project files do not',async t=>{
  let fetches=0;
  const f=setup(t,{bridgePort:()=>8787,fetchImpl:async()=>{fetches++;return new Response('<p>local</p>');}});
  const denied=()=>{const error=Error('observer');error.status=403;throw error;};
  await assert.rejects(f.create('http://localhost:3000/site/','phone',denied),e=>e.status===403);
  await assert.rejects(f.preview.create({deviceId:'phone',pane:f.pane,target:'http://localhost:3000/site/'}),
    e=>e.status===403&&e.code==='permission_denied','callers that omit the check are denied');
  assert.equal(fetches,0);
  const session=await f.create('http://localhost:3000/site/');assert.equal(fetches,1);
  await assert.rejects(f.read(session.id,'index.html','0','phone',denied),e=>e.status===403,'a later downgrade stops reads');
  await assert.rejects(f.preview.read({deviceId:'phone',pane:f.pane,id:session.id,relative:'other.html',offset:'0'}),e=>e.status===403);
  assert.equal(fetches,1);
  fs.writeFileSync(path.join(f.root,'page.html'),'<p>file</p>');
  const file=await f.create('page.html','phone',denied);assert.equal(file.source,'file');
  assert.equal(Buffer.from((await f.read(file.id,'page.html','0','phone',denied)).data,'base64url').toString(),'<p>file</p>');
});
