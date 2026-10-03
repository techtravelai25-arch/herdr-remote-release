import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {listProjectFiles, openProjectArtifact} from '../src/artifacts.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-project-files-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  return {root, config:{projects:[{id:'test',path:root}]}};
}

test('project browser navigates ordinary files and downloads exact bytes by opaque reference', t => {
  const {root,config}=fixture(t);
  fs.mkdirSync(path.join(root,'src'));
  fs.writeFileSync(path.join(root,'src','hello world.kt'),'fun main() {}');
  const top=listProjectFiles(config,root,'');
  assert.equal(top.parent,null);assert.equal(top.entries[0].type,'directory');
  const inner=listProjectFiles(config,root,'src');
  assert.equal(inner.parent,'');assert.equal(inner.entries[0].downloadable,true);
  const opened=openProjectArtifact(config,root,inner.entries[0].id);
  try {assert.equal(fs.readFileSync(opened.fd,'utf8'),'fun main() {}');assert.equal(opened.name,'hello world.kt');}
  finally {fs.closeSync(opened.fd);}
  assert.throws(()=>openProjectArtifact(config,path.join(root,'src'),inner.entries[0].id));
});

test('browser blocks traversal, hidden credentials, links and changed references', t => {
  const {root,config}=fixture(t);
  for(const name of ['.env','private.pem','server.key.old','id_rsa.bak','credentials.json','credentials.yaml','secrets.yml','backup.kdbx','safe.txt'])fs.writeFileSync(path.join(root,name),'private');
  fs.symlinkSync(root,path.join(root,'linked'));
  fs.linkSync(path.join(root,'safe.txt'),path.join(root,'hard.txt'));
  assert.deepEqual(listProjectFiles(config,root,'').entries,[]);
  for(const directory of ['..','../outside','/tmp','linked','.git','a/../b','a\\b','a//b'])
    assert.throws(()=>listProjectFiles(config,root,directory));
  fs.unlinkSync(path.join(root,'hard.txt'));
  const id=listProjectFiles(config,root,'').entries[0].id;
  fs.unlinkSync(path.join(root,'safe.txt'));fs.symlinkSync(path.join(root,'.env'),path.join(root,'safe.txt'));
  assert.throws(()=>openProjectArtifact(config,root,id));
});

test('browser bounds listing and marks oversize files unavailable', t => {
  const {root,config}=fixture(t);
  const fd=fs.openSync(path.join(root,'large.zip'),'w');fs.ftruncateSync(fd,20*1024*1024+1);fs.closeSync(fd);
  const large=listProjectFiles(config,root,'').entries[0];
  assert.equal(large.downloadable,false);assert.equal(large.id,undefined);
  for(let i=0;i<110;i++)fs.writeFileSync(path.join(root,`file-${i}.txt`),'');
  const result=listProjectFiles(config,root,'');assert.equal(result.entries.length,100);assert.equal(result.truncated,true);
  const next=listProjectFiles(config,root,'',result.nextCursor);
  assert.equal(next.entries.length,11);assert.equal(next.nextCursor,null);
  assert.equal(new Set([...result.entries,...next.entries].map(x=>x.path)).size,111);
  assert.throws(()=>listProjectFiles(config,root,'',result.nextCursor));
  assert.throws(()=>listProjectFiles({projects:[]},root,''));
});

test('pagination cursors cannot cross directories or survive directory replacement', t => {
  const {root,config}=fixture(t);fs.mkdirSync(path.join(root,'sub'));
  for(let i=0;i<105;i++)fs.writeFileSync(path.join(root,'sub',`entry-${i}.txt`),'');
  const first=listProjectFiles(config,root,'sub');assert.ok(first.nextCursor);
  assert.throws(()=>listProjectFiles(config,root,'',first.nextCursor));
  assert.throws(()=>listProjectFiles(config,root,'sub','a'.repeat(48)));
  fs.renameSync(path.join(root,'sub'),path.join(root,'old'));fs.mkdirSync(path.join(root,'sub'));
  assert.throws(()=>listProjectFiles(config,root,'sub',first.nextCursor));
});

test('an exact page boundary does not advertise an empty next page', t => {
  const {root,config}=fixture(t);
  for(let i=0;i<100;i++)fs.writeFileSync(path.join(root,`entry-${i}.txt`),'');
  const listing=listProjectFiles(config,root,'');
  assert.equal(listing.entries.length,100);
  assert.equal(listing.truncated,false);
  assert.equal(listing.nextCursor,null);
});
