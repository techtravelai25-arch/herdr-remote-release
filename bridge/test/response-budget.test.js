import test from 'node:test';import assert from 'node:assert/strict';
import {boundedOutput,MAX_BRIDGE_RESPONSE_BYTES} from '../src/response-budget.js';
import {generateIdentity,deriveKey,encryptPayload,decryptPayload,createRelayHandler} from '../src/relay.js';
import {randomUUID} from 'node:crypto';
test('large ASCII, Unicode and JSON-escaped output retains its newest text within envelope budget',async()=>{
 for(const text of ['x'.repeat(300000),'😀'.repeat(100000),'\u0001'.repeat(100000)]){
  const bounded=boundedOutput({text:text+' END',truncated:false,revision:1,currentModel:null,agentModelMenu:{id:'0'.repeat(64),provider:'claude',options:['Model A','Model B']}});
  assert.ok(Buffer.byteLength(JSON.stringify(bounded))<=MAX_BRIDGE_RESPONSE_BYTES);assert.equal(bounded.truncated,true);assert.ok(bounded.text.endsWith(' END'));assert.deepEqual(bounded.agentModelMenu.options,['Model A','Model B']);
  const laptop={...generateIdentity(),id:'budget'},phone=generateIdentity(),id=randomUUID(),key=deriveKey(phone.privateKey,laptop.publicKey,laptop.id,id),envelope={...encryptPayload(key,laptop.id,id,{method:'GET',path:'/v1/panes/test/output',timestamp:Date.now()},'request'),epk:phone.publicKey};
  const handler=createRelayHandler({identity:laptop,port:1234,fetchImpl:async()=>new Response(JSON.stringify(bounded))});const reply=decryptPayload(key,laptop.id,await handler(envelope),'response');assert.equal(reply.status,200);assert.deepEqual(JSON.parse(Buffer.from(reply.body,'base64url')),bounded);
 }
});
test('oversized menus are omitted whole, ordinary output remains unchanged',()=>{
 const input={text:'hello',truncated:false,currentModel:null};assert.deepEqual(boundedOutput(input),input);
 const value=boundedOutput({...input,agentModelMenu:{options:['x'.repeat(70000)]},codexModelMenu:{options:['A','B']}});assert.equal(value.agentModelMenu,undefined);assert.equal(value.codexModelMenu,undefined);assert.equal(value.controlsTruncated,true);
});
test('question controls remain complete under output pressure and oversized questions are omitted whole',()=>{
 const question={id:'a'.repeat(64),prompt:'Which preview?',options:['Keep current','Use compact','Other'],selectedIndex:0,stage:'choices'};
 const value=boundedOutput({text:'😀'.repeat(100000)+' END',question,questionReviewAvailable:false});
 assert.deepEqual(value.question,question);assert.ok(value.text.endsWith(' END'));
 assert.ok(Buffer.byteLength(JSON.stringify(value))<=MAX_BRIDGE_RESPONSE_BYTES);
 const oversized=boundedOutput({text:'terminal',question:{...question,prompt:'x'.repeat(70000)}});
 assert.equal(oversized.question,undefined);assert.equal(oversized.controlsTruncated,true);assert.equal(oversized.text,'terminal');
});
