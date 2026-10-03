import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../src/store.js';import {routingCapabilities} from '../src/routing-capabilities.js';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'routing-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new Store(dir);return {store,routing:routingCapabilities(store)};}
const ack=(routing,record)=>routing.onAck(record.capability.id,'register',{ok:true});
test('bootstrap permits pairing only, expires, and strict mode rejects anonymous frames',t=>{
 const {routing}=fixture(t),bootstrap=routing.create('bootstrap',{expires:Math.floor(Date.now()/1000)+60}),frame={id:bootstrap.capability.id,kind:'bootstrap'};
 ack(routing,bootstrap);assert.equal(routing.check(frame,{method:'POST',path:'/v1/pair'}),true);for(const [method,path] of [['GET','/v1/health'],['POST','/v1/agents'],['GET','/v1/pair']])assert.equal(routing.check(frame,{method,path}),false);assert.equal(routing.check(null,{method:'POST',path:'/v1/pair'}),false);
 const expired=routing.create('bootstrap',{expires:Math.floor(Date.now()/1000)-1});assert.equal(routing.check({id:expired.capability.id,kind:'bootstrap'},{method:'POST',path:'/v1/pair'}),false);assert.equal(routing.check(frame,{method:'POST',path:'/v1/pair'}),false);
});
test('phone capability is bound to its device and local revoke queues cloud revocation',t=>{
 const {routing,store}=fixture(t),a=store.pair(store.pairCode(),'a'),b=store.pair(store.pairCode(),'b'),record=routing.create('phone',{deviceId:a.deviceId}),frame={id:record.capability.id,kind:'phone'};
 const req=token=>({method:'GET',path:'/v1/health',headers:{Authorization:`Bearer ${token}`}});assert.equal(routing.check(frame,req(a.token)),true);assert.equal(routing.check(frame,req(b.token)),false);store.revoke(a.deviceId);assert.equal(routing.check(frame,req(a.token)),false);assert.equal(routing.requests().find(r=>r.capability.id===frame.id).revoked,true);
});
test('pairing waits for register ack and retries idempotently without creating duplicate grants',async t=>{
 const {routing,store}=fixture(t),bootstrap=routing.create('bootstrap',{expires:Math.floor(Date.now()/1000)+60}),frame={id:bootstrap.capability.id,kind:'bootstrap'};let sends=0,complete=false;
 const device=store.pair(store.pairCode(),'phone'),send=async()=>{sends++;return {status:200,headers:{},bytes:Buffer.from(JSON.stringify(device))};};
 const pending=routing.pair(frame,Buffer.from('same-pair-body'),send,'A'.repeat(43)).then(value=>{complete=true;return value;});await new Promise(r=>setTimeout(r,20));assert.equal(complete,false);
 const phone=routing.records().find(r=>r.capability.kind==='phone');ack(routing,phone);const first=await pending,second=await routing.pair(frame,Buffer.from('same-pair-body'),send,'A'.repeat(43));assert.deepEqual(first,second);assert.equal(sends,1);assert.equal(JSON.parse(Buffer.from(first.body,'base64url')).routingToken,phone.token);
 await assert.rejects(routing.pair(frame,Buffer.from('same-pair-body'),send,'B'.repeat(43)),/exchange changed/);assert.equal(sends,1);
 store.revoke(device.deviceId);await assert.rejects(routing.pair(frame,Buffer.from('same-pair-body'),send,'A'.repeat(43)),/revoked/);
});
test('rotation preserves old capability until new token is acknowledged and used',async t=>{
 const {routing,store}=fixture(t),device=store.pair(store.pairCode(),'phone'),old=routing.create('phone',{deviceId:device.deviceId}),frame={id:old.capability.id,kind:'phone'},req={method:'GET',path:'/v1/health',headers:{authorization:`Bearer ${device.token}`}};ack(routing,old);
 const pending=routing.rotate(frame);await new Promise(r=>setTimeout(r,20));const next=routing.records().find(r=>r.predecessor===old.capability.id);assert.equal(routing.check(frame,req),true);ack(routing,next);const result=await pending;assert.equal(result.routingToken,next.token);assert.deepEqual(await routing.rotate(frame),result);assert.equal(routing.check(frame,req),true);
 assert.equal(routing.check({id:next.capability.id,kind:'phone'},req),true);assert.equal(routing.check(frame,req),false);assert.equal(routing.requests().find(r=>r.capability.id===old.capability.id).revoked,true);
});
