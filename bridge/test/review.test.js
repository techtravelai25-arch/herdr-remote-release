import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {parseChangedFiles,reviewProject} from '../src/review.js';

test('porcelain records preserve literal filenames and rename direction',()=>{
  const result=parseChangedFiles(' M folder/space name.kt\0R  new/文\t"file.txt\0old/line\nfile.txt\0?? notes -> draft.md\0UU conflict.kt\0');
  assert.equal(result.complete,true);
  assert.deepEqual(result.files.map(f=>[f.path,f.previousPath,f.status]),[
    ['folder/space name.kt',undefined,'modified'],['new/文\t"file.txt','old/line\nfile.txt','renamed'],
    ['notes -> draft.md',undefined,'untracked'],['conflict.kt',undefined,'conflicted'],
  ]);
});

test('incomplete records and rename sources cannot claim a complete clean tree',()=>{
  assert.deepEqual(parseChangedFiles(''),{files:[],complete:true});
  assert.deepEqual(parseChangedFiles(' M cut-off'),{files:[],complete:false});
  assert.deepEqual(parseChangedFiles('R  new.txt\0old'),{files:[],complete:false});
  assert.deepEqual(parseChangedFiles('## main\0'),{files:[],complete:false});
  const partial=parseChangedFiles(' M full.txt\0?? half');
  assert.equal(partial.complete,false);assert.equal(partial.files[0].path,'full.txt');
});

test('review returns a truly empty file list for clean branch metadata and precise changed paths',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-review-list-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd:dir,stdio:'pipe'});
  git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');
  fs.writeFileSync(path.join(dir,'before.txt'),'tracked\n');git('add','.');git('commit','-qm','fixture');
  const review=()=>reviewProject({projects:[{id:'project',label:'Project',path:dir}]},dir,{list:()=>({attachments:[]})},'phone','pane');
  const clean=await review();
  assert.match(clean.status,/^## /);assert.deepEqual(clean.changedFiles,[]);assert.equal(clean.changedFilesComplete,true);
  git('mv','before.txt','after name.txt');
  fs.writeFileSync(path.join(dir,'文\nnotes.txt'),'untracked');
  const changed=await review();
  assert.equal(changed.changedFilesComplete,true);
  assert.ok(changed.changedFiles.some(f=>f.path==='after name.txt'&&f.previousPath==='before.txt'&&f.status==='renamed'));
  assert.ok(changed.changedFiles.some(f=>f.path==='文\nnotes.txt'&&f.status==='untracked'));
});

test('nested pane review excludes sibling changes from status and changed files',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-review-nested-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd:dir,stdio:'pipe'});
  const pane=path.join(dir,'pane');
  const sibling=path.join(dir,'sibling');
  fs.mkdirSync(pane);fs.mkdirSync(sibling);
  git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');
  fs.writeFileSync(path.join(pane,'pane.txt'),'before\n');
  fs.writeFileSync(path.join(sibling,'old.txt'),'sibling\n');
  git('add','.');git('commit','-qm','fixture');
  fs.writeFileSync(path.join(pane,'pane.txt'),'after\n');
  git('mv','sibling/old.txt','sibling/new.txt');
  fs.writeFileSync(path.join(sibling,'extra.txt'),'untracked');

  const review=await reviewProject({projects:[{id:'project',label:'Project',path:dir}]},pane,{list:()=>({attachments:[]})},'phone','pane');
  assert.equal(review.available,true);
  assert.equal(review.changedFilesComplete,true);
  assert.deepEqual(review.changedFiles.map(file=>file.path),['pane/pane.txt']);
  assert.match(review.status,/pane.txt/);
  assert.doesNotMatch(review.status,/sibling|old.txt|new.txt|extra.txt/);
  assert.match(review.diff,/pane.txt/);
  assert.doesNotMatch(review.diff,/sibling|old.txt|new.txt|extra.txt/);
});
