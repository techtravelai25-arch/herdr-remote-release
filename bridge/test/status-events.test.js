import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createStatusEvents} from '../src/status-events.js';

const status = (pane_id, agent_status, extra = {}) => JSON.stringify({event:'pane.agent_status_changed',data:{pane_id,workspace_id:'w1',agent_status,...extra}}) + '\n';
const ack = request => JSON.stringify({id:request.id,result:{type:'subscription_started'}}) + '\n';
async function until(predicate) {
  for (let i=0;i<250;i++) { if (predicate()) return; await delay(10); }
  assert.fail('Timed out waiting for subscription state');
}
async function fixture(t, onRequest, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'herdr-status-'));
  const socketPath = path.join(dir,'api.sock');
  const sockets = new Set(); const requests = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close',()=>sockets.delete(socket)); socket.on('error',()=>{});
    socket.setEncoding('utf8'); let buffer='';
    socket.on('data',chunk=>{
      buffer+=chunk; let index;
      while ((index=buffer.indexOf('\n'))!==-1) {
        const request=JSON.parse(buffer.slice(0,index));buffer=buffer.slice(index+1);
        requests.push(request); onRequest(socket,request,requests.length);
      }
    });
  });
  server.listen(socketPath); await once(server,'listening');
  const monitor=createStatusEvents(socketPath,options);
  t.after(async()=>{monitor.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  return {monitor,requests,sockets};
}

test('dormant until enabled, exact protocol subscriptions and ordered events after async baseline',async t=>{
  const seen=[];let release;const baseline=new Promise(resolve=>release=resolve);let ready=0;
  const f=await fixture(t,(socket,request)=>{
    const payload=status('p1','working',{title:'日本語'})+ack(request)+status('p1','done');
    const bytes=Buffer.from(payload);const split=bytes.indexOf(Buffer.from('日'))+1;
    socket.write(bytes.subarray(0,split));socket.write(bytes.subarray(split));
  },{onReady:async()=>{ready++;await baseline;seen.push('baseline');},onStatus:data=>seen.push(data.agent_status)});
  await delay(30);assert.equal(f.requests.length,0);
  f.monitor.update(['p1']);await until(()=>ready===1);
  assert.deepEqual(f.requests[0].params,{subscriptions:[{type:'pane.agent_status_changed',pane_id:'p1'}]});
  assert.equal(f.requests[0].method,'events.subscribe');assert.deepEqual(seen,[]);
  release();await until(()=>seen.length===3);assert.deepEqual(seen,['baseline','working','done']);
});

test('ignores unknown panes and unrelated event families',async t=>{
  const seen=[];
  const f=await fixture(t,(socket,request)=>socket.write(ack(request)+status('alien','working')+
    JSON.stringify({event:'pane_agent_status_changed',data:{pane_id:'p1',agent_status:'blocked'}})+'\n'+status('p1','blocked')),
    {onStatus:data=>seen.push(data)});
  f.monitor.update({panes:[{id:'p1'}]});await until(()=>seen.length===1);
  assert.equal(seen[0].pane_id,'p1');assert.equal(seen[0].agent_status,'blocked');
});

test('malformed input disconnects then resubscribes and reconciles',async t=>{
  let baselines=0;const seen=[];
  const f=await fixture(t,(socket,request,count)=>socket.write(count===1?'not-json\n':ack(request)+status('p1','idle')),
    {onReady:()=>{baselines++;},onStatus:data=>seen.push(data.agent_status)});
  f.monitor.update(['p1']);await until(()=>seen.length===1);
  assert.ok(f.requests.length>=2);assert.equal(baselines,1);assert.deepEqual(seen,['idle']);
});

test('remote close reconnects, unchanged membership does not reconnect, close cancels retries',async t=>{
  let first;
  const f=await fixture(t,(socket,request,count)=>{socket.write(ack(request));if(count===1)first=socket;});
  f.monitor.update(['p1']);await until(()=>first);
  f.monitor.update(['p1','p1']);await delay(30);assert.equal(f.requests.length,1);
  first.destroy();await until(()=>f.requests.length===2);
  f.monitor.close();for(const socket of f.sockets)socket.destroy();await delay(500);
  assert.equal(f.requests.length,2);f.monitor.update(['p2']);await delay(30);assert.equal(f.requests.length,2);
});

test('membership changes replace subscription and discard stale baseline queue',async t=>{
  let release;const pending=new Promise(resolve=>release=resolve);let ready=0;const seen=[];
  const f=await fixture(t,(socket,request)=>socket.write(ack(request)+status(request.params.subscriptions[0].pane_id,'done')),
    {onReady:()=>++ready===1?pending:undefined,onStatus:data=>seen.push(data.pane_id)});
  f.monitor.update(['p1']);await until(()=>ready===1);
  f.monitor.update({snapshot:{panes:[{pane_id:'p2'}]}});await until(()=>seen.length===1);
  release();await delay(30);assert.deepEqual(seen,['p2']);
  f.monitor.update([]);await until(()=>f.sockets.size===0);
});

test('oversized partial frame and queue overflow reconnect without emitting unbaselined events',async t=>{
  let release;const pending=new Promise(resolve=>release=resolve);const seen=[];let ready=0;
  const f=await fixture(t,(socket,request,count)=>{
    if(count===1)socket.write('x'.repeat(65537));
    else if(count===2)socket.write(ack(request)+Array.from({length:129},()=>status('p1','working')).join(''));
    else socket.write(ack(request)+status('p1','idle'));
  },{onReady:()=>++ready===1?pending:undefined,onStatus:data=>seen.push(data.agent_status)});
  f.monitor.update(['p1']);await until(()=>seen.length===1);release();
  assert.ok(f.requests.length>=3);assert.deepEqual(seen,['idle']);
});

test('bad acknowledgment, invalid status, and callback failure recover without unhandled rejection',async t=>{
  let attempts=0;const seen=[];
  const f=await fixture(t,(socket,request,count)=>{
    if(count===1)socket.write(JSON.stringify({id:request.id,result:{type:'ok'}})+'\n');
    else if(count===2)socket.write(ack(request)+status('p1','invented-status'));
    else socket.write(ack(request)+status('p1','done'));
  },{onStatus:async data=>{if(++attempts===1)throw new Error('consumer unavailable');seen.push(data.agent_status);}});
  f.monitor.update(['p1']);await until(()=>seen.length===1);assert.ok(f.requests.length>=4);
});
