import test from 'node:test';
import assert from 'node:assert/strict';
import {promptAgent} from '../src/prompt-agent.js';

const current={pane_id:'w:p',terminal_id:'terminal-1',agent:'codex',agent_session:{value:'one'},cwd:'/project'};
const failure=code=>Object.assign(new Error(code),{code});

function fixture(errors=[]) {
  const calls=[];let attempt=0;
  return {calls,call:async(method,params)=>{
    calls.push({method,params});
    if(method==='agent.prompt') {const error=errors[attempt++];if(error)throw failure(error);return {ok:true};}
    throw Error(`Unexpected ${method}`);
  }};
}

test('normal prompt uses only the Herdr agent surface',async()=>{
  const h=fixture();assert.deepEqual(await promptAgent(h,current.pane_id,'hello',current),{ok:true});
  assert.deepEqual(h.calls,[{method:'agent.prompt',params:{target:current.pane_id,text:'hello'}}]);
});

test('readiness, busy, modal, and uncertain rejections do not retry or use raw input',async()=>{
  for(const code of ['agent_not_ready','agent_pane_busy','agent_blocked','agent_busy','agent_not_found','herdr_timeout','herdr_disconnected']) {
    const h=fixture([code]);await assert.rejects(promptAgent(h,current.pane_id,'hello',current),error=>error.code===code);
    assert.deepEqual(h.calls.map(call=>call.method),['agent.prompt']);
  }
});
