import fs from 'node:fs';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {requireAccess} from './access.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
export function routingCapabilities(store,{now=Date.now}={}){
  const filename=id=>`routing-cap-${id}.json`;
  function records(){return fs.readdirSync(store.dir).filter(n=>/^routing-cap-[a-f0-9-]{36}\.json$/.test(n)).map(n=>store.read(n,null)).filter(Boolean);}
  function get(id){return /^[a-f0-9-]{36}$/.test(id||'')?store.read(filename(id),null):null;}
  function revoke(id){const value=get(id);if(value){value.revoked=true;store.write(filename(id),value);}}
  function create(kind,{deviceId,expires=0,predecessor}={}){
    if(kind==='bootstrap')for(const old of records())if(old.capability.kind==='bootstrap')revoke(old.capability.id);
    const token=randomBytes(32).toString('base64url'),capability={id:randomUUID(),kind,tokenHash:hash(token),expires};
    const record={capability,token,...(deviceId?{deviceId}:{}),...(predecessor?{predecessor}:{})};store.write(filename(capability.id),record);return record;
  }
  async function acknowledged(id,{timeoutMs=15000,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){const deadline=now()+timeoutMs;while(now()<deadline){const ack=store.read(`routing-ack-${id}.json`,null);if(ack?.ok)return;if(ack?.error)throw Error('The relay could not register this routing credential. Retry pairing.');await sleep(100);}throw Error('The relay has not acknowledged this routing credential. Reconnect and retry pairing.');}
  function check(frame,req){
    if(!frame)return !store.read('routing-mode.json',{strict:false}).strict && store.read('access.json',{enabled:true})?.enabled!==false;
    const record=get(frame.id);if(!record||record.revoked||record.capability.kind!==frame.kind||(record.capability.expires&&record.capability.expires*1000<now()))return false;
    if(frame.kind==='bootstrap'){
      try {requireAccess(store,{deviceId:'pairing'});} catch {return false;}
      return req.method==='POST'&&req.path==='/v1/pair';
    }
    const auth=Object.entries(req.headers||{}).find(([name])=>name.toLowerCase()==='authorization')?.[1];
    const device=typeof auth==='string'&&auth.startsWith('Bearer ')?store.authenticate(auth.slice(7)):null;
    const valid=!!device&&device.deviceId===record.deviceId;
    if(valid)try {requireAccess(store,device);} catch {return false;}
    if(valid&&record.predecessor)revoke(record.predecessor);
    return valid;
  }
  function requests(){const devices=new Set(store.read('devices.json',[]).map(d=>d.deviceId));return records().map(record=>{if(!record.revoked&&((record.capability.expires&&record.capability.expires*1000<now())||(record.deviceId&&!devices.has(record.deviceId)))){revoke(record.capability.id);record.revoked=true;}return record;});}
  function enforce(){store.write('routing-mode.json',{strict:true});}
  function acknowledgedAction(record){const ack=store.read(`routing-ack-${record.capability.id}.json`,null);return (ack?.ok&&ack.action===(record.revoked?'revoke':'register'))||(!ack?.ok&&ack?.error&&now()-ack.updatedAt<30000);}
  function onAck(id,action,message){if(action==='register'&&message.ok)enforce();if(action==='revoke'&&message.error==='capability_not_found')message={ok:true};if(action==='register'&&message.error==='capability_revoked')revoke(id);store.write(`routing-ack-${id}.json`,{ok:message.ok===true,action,updatedAt:now(),...(!message.ok?{error:true}:{})});if(message.ok&&action==='revoke'){fs.rmSync(store.dir+'/'+filename(id),{force:true});fs.rmSync(store.dir+`/routing-ack-${id}.json`,{force:true});fs.rmSync(store.dir+`/routing-pair-${id}.json`,{force:true});}}
  async function pair(frame,body,send,nonce){
    if(!frame||frame.kind!=='bootstrap')return send();
    if(typeof nonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(nonce))throw Error('An unguessable pairing nonce is required.');
    const cacheFile=`routing-pair-${frame.id}.json`,bodyHash=hash(Buffer.concat([Buffer.from(nonce),Buffer.from([0]),body])),cached=store.read(cacheFile,null);
    if(cached){if(cached.bodyHash!==bodyHash)throw Error('Pairing exchange changed');const cap=get(cached.capId),paired=JSON.parse(Buffer.from(cached.response.body,'base64url'));if(!cap||cap.revoked||store.authenticate(paired.token)?.deviceId!==cap.deviceId)throw Error('This paired phone was revoked. Generate a new QR.');await acknowledged(cached.capId);return cached.response;}
    const response=await send();if(response.status!==200)return response;
    const paired=JSON.parse(response.bytes.toString()),record=create('phone',{deviceId:paired.deviceId});
    const value={...paired,routingToken:record.token,routingExpires:0};
    const saved={status:response.status,headers:response.headers,body:Buffer.from(JSON.stringify(value)).toString('base64url')};
    store.write(cacheFile,{bodyHash,capId:record.capability.id,response:saved});await acknowledged(record.capability.id);return saved;
  }
  async function rotate(frame){const old=get(frame?.id);if(!old||old.revoked||old.capability.kind!=='phone')throw Error('A trusted phone capability is required.');let next=old.successor?get(old.successor):null;if(!next){next=create('phone',{deviceId:old.deviceId,predecessor:old.capability.id});old.successor=next.capability.id;store.write(filename(old.capability.id),old);}await acknowledged(next.capability.id);return {routingToken:next.token,routingExpires:0};}
  return {enforce,rotate,create,get,records,requests,revoke,acknowledged,check,onAck,acknowledgedAction,pair};
}
