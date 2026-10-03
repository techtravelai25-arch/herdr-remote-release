import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createBridge} from '../src/server.js';

test('phone output polling does not scroll an idle agent on the desktop', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-remote-passive-read-'));
  const pane={pane_id:'w1:p1',workspace_id:'w1',tab_id:'w1:t1',cwd:dir,agent:'codex',agent_status:'idle',revision:1};
  let desktopScrolls=0;
  const calls=[];
  const herdr={call:async(method,params)=>{
    calls.push({method,params});
    if(method==='pane.get')return {pane};
    if(method==='pane.read'){
      // Herdr 0.9 traverses the agent viewport for deep recent text reads.
      if(params.source==='recent_unwrapped'&&params.format==='text'&&params.lines>30)desktopScrolls++;
      return {read:{text:params.format==='ansi'?'\x1b[32mhello\x1b[0m\nworld':'hello\nworld',revision:1,truncated:false}};
    }
    if(method==='session.snapshot')return {snapshot:{protocol:22,workspaces:[{workspace_id:'w1'}],panes:[pane],agents:[pane]}};
    return {type:'ok'};
  }};
  const app=createBridge({socketPath:'/unused',stateDir:dir,projects:[]},{herdr});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const credential=app.store.pair(app.store.pairCode(),'Test phone');
  const url=`http://127.0.0.1:${app.server.address().port}/v1/panes/w1%3Ap1/output`;
  for(let poll=0;poll<2;poll++){
    const response=await fetch(url,{headers:{authorization:`Bearer ${credential.token}`}});
    assert.equal(response.status,200);
    assert.equal((await response.json()).text,'hello\nworld');
  }
  assert.equal(desktopScrolls,0,'polling must not trigger Herdr alternate-screen history traversal');
  assert.equal(calls.filter(call=>call.method==='pane.read'&&call.params.source==='recent_unwrapped').length,2);
});
