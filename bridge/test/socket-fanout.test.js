import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {Store} from '../src/store.js';
import {createSocketFanout} from '../src/socket-fanout.js';

test('an authenticator failure closes only that socket and never rejects a fan-out',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'socket-fanout-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),server=http.createServer();
  const authenticate=async token=>{if(token==='broken')throw Error('corrupt device store');return {deviceId:token};};
  const sockets=createSocketFanout({server,store,config:{},authenticate,authorizeUpgrade:async req=>req.headers.authorization,
    scopedSnapshot:(data,device)=>({...data,device:device.deviceId,permissionMode:'normal'}),latest:()=>null});
  t.after(()=>{sockets.close();server.close();});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`ws://127.0.0.1:${server.address().port}/v1/events`;
  const open=async token=>{const ws=new WebSocket(url,{headers:{authorization:token}});await once(ws,'open');return ws;};
  const good=await open('phone'),bad=await open('broken');
  const closed=once(bad,'close'),message=once(good,'message');
  await sockets.broadcast({panes:[]});
  const [code]=await closed;assert.equal(code,4001);
  assert.deepEqual(JSON.parse((await message)[0]),{type:'snapshot',data:{panes:[],device:'phone',permissionMode:'normal'}});
  assert.equal(good.readyState,WebSocket.OPEN);good.close();
});
