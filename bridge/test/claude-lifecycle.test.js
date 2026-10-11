import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readClaudeLifecycle} from '../src/claude-lifecycle.js';

const id='3d69680a-1111-4222-8333-444455556666';
function fixture(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'claude-lifecycle-'));
  const root=path.join(home,'.claude/projects');fs.mkdirSync(path.join(root,'project'),{recursive:true});
  const file=path.join(root,'project',id+'.jsonl');fs.writeFileSync(file,'');
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const session={agent:'claude',kind:'path',value:file};
  const append=record=>fs.appendFileSync(file,JSON.stringify({timestamp:'2026-10-10T00:00:00.000Z',...record})+'\n');
  const read=options=>readClaudeLifecycle(session,home,options);
  const final=()=>append({type:'assistant',message:{stop_reason:'end_turn',content:[{type:'text',text:'Done.'}]}});
  const duration=()=>append({type:'system',subtype:'turn_duration'});
  return {home,root,file,session,append,read,final,duration};
}
test('tool cycles, thinking, null and truncated response endings never prove completion',t=>{
  const f=fixture(t);
  for(const reason of ['tool_use',null,'max_tokens','pause_turn']) {
    f.append({type:'assistant',message:{stop_reason:reason,content:[{type:'text',text:'Progress.'}]}});
    f.duration();assert.equal(f.read().state,'active');
  }
  f.append({type:'assistant',message:{stop_reason:'end_turn',content:[{type:'thinking',thinking:'reasoning'}]}});
  f.duration();assert.equal(f.read().state,'active');
  f.final();assert.equal(f.read().state,'final');f.duration();assert.equal(f.read().state,'complete');
  f.append({type:'user',message:{content:[{type:'tool_result',content:'result'}]}});
  f.duration();assert.equal(f.read().state,'active');
});
test('post-hook boundary is required and newer continuation cancels the preliminary final',t=>{
  const f=fixture(t);f.final();
  f.append({type:'system',subtype:'stop_hook_summary',preventedContinuation:false});
  assert.equal(f.read().state,'final');
  f.append({type:'user',message:{content:'Continue after stop hook'}});
  f.duration();assert.equal(f.read().state,'active');
  f.final();f.duration();assert.equal(f.read().state,'complete');
});
test('sidechain, housekeeping and older duration do not end a newer main turn',t=>{
  const f=fixture(t);f.append({type:'user',message:{content:'Task'}});
  f.append({type:'assistant',isSidechain:true,message:{stop_reason:'end_turn',content:[{type:'text',text:'Subagent done'}]}});
  f.duration();assert.equal(f.read().state,'active');
  f.final();f.append({type:'system',subtype:'turn_duration',timestamp:'2026-10-09T00:00:00.000Z'});
  assert.equal(f.read().state,'final');f.duration();
  const key=f.read().key;f.append({type:'system',subtype:'away_summary'});
  assert.equal(f.read().key,key);assert.equal(f.read().state,'complete');
});
test('partial or malformed append fails closed instead of recycling old completion',t=>{
  const f=fixture(t);f.final();f.duration();assert.equal(f.read().state,'complete');
  const diagnostic={};
  fs.appendFileSync(f.file,'{"type":"user"');assert.equal(readClaudeLifecycle(f.session,f.home,{diagnostic}),null);
  assert.equal(diagnostic.reason,'partial_append');
  fs.appendFileSync(f.file,'\n');assert.equal(readClaudeLifecycle(f.session,f.home,{diagnostic}),null);
  assert.equal(diagnostic.reason,'unsupported_schema');
  f.final();f.duration();assert.equal(f.read().state,'complete','new valid evidence can recover after old damage');
});
test('unrecognized Claude records after completion cannot certify the old turn',t=>{
  const f=fixture(t);f.final();f.duration();
  const diagnostic={};
  f.append({type:'system',subtype:'turn_started'});
  assert.equal(f.read({diagnostic}),null);assert.equal(diagnostic.reason,'unsupported_schema');
  fs.writeFileSync(f.file,'');f.final();f.duration();f.append({type:'future-turn-record'});
  assert.equal(f.read({diagnostic}),null);assert.equal(diagnostic.reason,'unsupported_schema');
  fs.writeFileSync(f.file,'');f.final();f.duration();f.append({type:'system',subtype:'away_summary'});
  assert.equal(f.read({diagnostic})?.state,'complete');
});
test('transcript-only compaction preserves completed work but cannot finish active work',t=>{
  const f=fixture(t);
  const compact=()=>{
    f.append({type:'system',subtype:'compact_boundary'});
    f.append({type:'user',isCompactSummary:true,isVisibleInTranscriptOnly:true,message:{content:'Saved context'}});
    f.append({type:'attachment'});
  };
  f.final();f.duration();const completed=f.read();
  compact();assert.deepEqual(f.read(),completed,'housekeeping must not create a new turn or completion identity');
  f.append({type:'user',isMeta:true,promptSource:'system',turnOrigin:'scheduled',message:{content:'Scheduled task'}});
  const active=f.read();compact();assert.deepEqual(f.read(),active,'a real scheduled task remains active');
  f.final();compact();f.duration();
  assert.notEqual(f.read()?.state,'complete','a boundary cannot certify a preliminary final across compaction');
  f.final();f.duration();compact();
  f.append({type:'user',message:{content:[{type:'tool_result',content:'New tool result'}]}});
  assert.equal(f.read().state,'active');
});
test('summary flags must both be true and a summary-only tail cannot prove completion',t=>{
  const f=fixture(t);
  f.append({type:'user',isCompactSummary:true,isVisibleInTranscriptOnly:true,message:{content:'Saved context'}});
  assert.equal(f.read(),null);
  for(const flags of [{isCompactSummary:true},{isVisibleInTranscriptOnly:true}]){
    f.final();f.duration();f.append({type:'user',...flags,message:{content:'Actual input'}});
    assert.equal(f.read().state,'active');
  }
  f.final();f.duration();
  f.append({type:'user',isCompactSummary:true,isVisibleInTranscriptOnly:true,message:{content:'x'.repeat(3000)}});
  assert.equal(f.read({maxBytes:500}),null,'no unbounded recovery of a final outside the tail');
});
test('main UUID lookup ignores deep artifact and subagent folders',t=>{
  const f=fixture(t);f.final();f.duration();
  fs.mkdirSync(path.join(f.root,'project','artifacts','a','b','c','d'),{recursive:true});
  fs.mkdirSync(path.join(f.root,'project','subagents'),{recursive:true});
  fs.copyFileSync(f.file,path.join(f.root,'project','subagents',id+'.jsonl'));
  assert.equal(readClaudeLifecycle({kind:'id',value:id},f.home).state,'complete');
});
test('bounded tails may prove a long final only with both final text and loop boundary',t=>{
  const f=fixture(t);f.append({type:'user',message:{content:'x'.repeat(3000)}});f.final();f.duration();
  assert.equal(f.read({maxBytes:500}).state,'complete');
  assert.equal(f.read({maxBytes:100}),null);
});
test('unsafe path, symlink, hard link, duplicate ID and wrong source fail closed',t=>{
  const f=fixture(t);f.final();f.duration();
  const alias=path.join(f.root,'project','alias.jsonl');fs.symlinkSync(f.file,alias);
  assert.equal(readClaudeLifecycle({...f.session,value:alias},f.home),null);
  assert.equal(readClaudeLifecycle({...f.session,agent:'codex'},f.home),null);
  const outside=path.join(f.home,'outside.jsonl');fs.copyFileSync(f.file,outside);
  assert.equal(readClaudeLifecycle({...f.session,value:outside},f.home),null);
  assert.equal(readClaudeLifecycle({agent:'claude',kind:'id',value:id},f.home).state,'complete');
  fs.mkdirSync(path.join(f.root,'other'));fs.copyFileSync(f.file,path.join(f.root,'other',id+'.jsonl'));
  assert.equal(readClaudeLifecycle({kind:'id',value:id},f.home),null);
  fs.linkSync(f.file,path.join(f.root,'project','hard.jsonl'));assert.equal(f.read(),null);
});
test('a concurrent append invalidates a completion read',t=>{
  const f=fixture(t);f.final();f.duration();
  const original=fs.readSync;let changed=false;
  fs.readSync=function(...args) {const result=original(...args);if(!changed){changed=true;f.append({type:'user',message:{content:'new'}});}return result;};
  try {assert.equal(f.read(),null);} finally {fs.readSync=original;}
});
