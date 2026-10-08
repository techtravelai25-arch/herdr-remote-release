import {createHash,createPublicKey,createPrivateKey,diffieHellman,hkdfSync,randomBytes,createCipheriv,createDecipheriv,generateKeyPairSync,randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {createTransfers} from './relay-transfers.js';
import {routingCapabilities} from './routing-capabilities.js';
import {MAX_BRIDGE_RESPONSE_BYTES} from './response-budget.js';
const CONTEXT='herdr-remote-relay-v1';
export const MAX_ENVELOPE_BYTES=512*1024;
const SALT=createHash('sha256').update(CONTEXT).digest();
const decode=(s,max)=>{if(typeof s!=='string'||s.length>max||!/^[A-Za-z0-9_-]*$/.test(s))throw Error('Invalid encoding');return Buffer.from(s,'base64url');};
export function generateIdentity(){const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});return {publicKey:publicKey.export({type:'spki',format:'der'}).toString('base64url'),privateKey:privateKey.export({type:'pkcs8',format:'pem'}).toString()};}
export function deriveKey(privateKey,epk,laptopId,id){const publicKey=createPublicKey({key:decode(epk,256),type:'spki',format:'der'});if(publicKey.asymmetricKeyType!=='ec'||publicKey.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw Error('Invalid key');return Buffer.from(hkdfSync('sha256',diffieHellman({privateKey:createPrivateKey(privateKey),publicKey}),SALT,Buffer.from(`${laptopId}:${id}`),32));}
export function encryptPayload(key,laptopId,id,value,direction='response'){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(`${CONTEXT}:${laptopId}:${id}:${direction}`));const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final(),cipher.getAuthTag()]);if(data.length>MAX_ENVELOPE_BYTES*0.74)throw Error('Response too large');return {v:1,id,iv:iv.toString('base64url'),data:data.toString('base64url')};}
export function decryptPayload(key,laptopId,envelope,direction='request'){const iv=decode(envelope.iv,16),data=decode(envelope.data,MAX_ENVELOPE_BYTES);if(iv.length!==12||data.length<16)throw Error('Invalid envelope');const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(Buffer.from(`${CONTEXT}:${laptopId}:${envelope.id}:${direction}`));decipher.setAuthTag(data.subarray(-16));return JSON.parse(Buffer.concat([decipher.update(data.subarray(0,-16)),decipher.final()]).toString());}
const REQUEST_SKEW_MS=120000,REPLAY_WINDOW_MS=2*REQUEST_SKEW_MS,MAX_REPLAY_IDS=10000;
/**
 * Request IDs seen within the timestamp window. The set lives in memory and is
 * written compactly before every request is forwarded, so a restarted or
 * crashed companion still rejects replays. Mutating (non-GET) requests are
 * fsynced to survive power loss; GET IDs skip fsync because a replayed read
 * returns a response encrypted to the phone's ephemeral key.
 */
function createReplayGuard(store,now,limit) {
  const seen=new Map((store?.read('relay-replay.json',[])||[]).filter(([,expiry])=>expiry>=now()));
  function accept(id,durable) {
    const time=now();
    for(const [key,expiry] of seen)if(expiry<time)seen.delete(key);
    if(seen.has(id))throw Error('Request replayed');
    // Never reject an unseen ID: a full window must not lock out the phone.
    // Past the cap (~42 requests/s sustained for the whole window) the oldest
    // ID is forgotten early. It could be replayed only while its timestamp is
    // still within the skew; mutations also carry operation-ID receipts.
    while(seen.size>=limit)seen.delete(seen.keys().next().value);
    seen.set(id,time+REPLAY_WINDOW_MS);
    store?.write('relay-replay.json',[...seen],{compact:true,durable});
  }
  return {accept,close(){}};
}
export function createRelayHandler({identity,port,fetchImpl=fetch,now=Date.now,transfers,store,routing,replayLimit=MAX_REPLAY_IDS}){
  const replay=createReplayGuard(store,now,replayLimit);let active=0;
  const handler=async (envelope,capability)=>{
    if(envelope?.v!==1||typeof envelope.id!=='string'||!/^[a-f0-9-]{36}$/i.test(envelope.id))throw Error('Invalid envelope');
    const key=deriveKey(identity.privateKey,envelope.epk,identity.id,envelope.id);
    const req=decryptPayload(key,identity.id,envelope);
    if(!Number.isSafeInteger(req.timestamp)||Math.abs(now()-req.timestamp)>REQUEST_SKEW_MS)throw Error('Request expired');
    replay.accept(envelope.id,req.method!=='GET');
    const response=value=>encryptPayload(key,identity.id,envelope.id,value);
    const error=(status,message)=>response({status,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify({error:{code:'relay_error',message}})).toString('base64url')});
    if(routing&&!routing.check(capability,req))return error(403,'Routing capability does not authorize this request.');
    if(active>=8)return error(429,'Laptop is busy. Try again.');
    active++;
    try{
      if(!['GET','POST','PUT','PATCH','DELETE'].includes(req.method)||typeof req.path!=='string'||req.path.length>4096||!req.path.startsWith('/v1/')||/[\\\r\n#]/.test(req.path))return error(400,'Invalid request');
      const url=new URL(req.path,`http://127.0.0.1:${port}`);
      if(url.origin!==`http://127.0.0.1:${port}`||!url.pathname.startsWith('/v1/'))return error(400,'Invalid path');
      const headers={};for(const [name,value] of Object.entries(req.headers||{}))if(['authorization','content-type','x-attachment-name','x-operation-id'].includes(name.toLowerCase())&&typeof value==='string'&&value.length<8192)headers[name.toLowerCase()]=value;
      const body=decode(req.body||'',MAX_ENVELOPE_BYTES);
      if(url.pathname==='/v1/relay-capability/rotate'&&req.method==='POST'&&routing){const value=await routing.rotate(capability);return response({status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(value)).toString('base64url')});}
      if(url.pathname.startsWith('/v1/relay-transfer/')){if(!transfers)return error(503,'Transfers unavailable');const out=await transfers.handle({...req,headers,body});return response({status:out.status,headers:out.headers,body:out.bytes.toString('base64url')});}
      const dispatch=async()=>{
      const res=await fetchImpl(url,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:body,redirect:'error',signal:AbortSignal.timeout(60000)});
      let size=0;const chunks=[];for await(const chunk of res.body||[]){size+=chunk.length;if(size>MAX_BRIDGE_RESPONSE_BYTES)throw Error('Response exceeds encrypted relay limit');chunks.push(chunk);}
      let bytes=Buffer.concat(chunks);
      if(req.method==='POST'&&url.pathname==='/v1/pair'&&res.status===200){const paired=JSON.parse(bytes.toString());bytes=Buffer.from(JSON.stringify({...paired,laptopId:identity.id,claimToken:identity.claimToken}));}
      const outHeaders={};for(const name of ['content-type','content-disposition','etag'])if(res.headers.has(name))outHeaders[name]=res.headers.get(name);
      return {status:res.status,headers:outHeaders,bytes};
      };
      const out=req.method==='POST'&&url.pathname==='/v1/pair'&&routing?await routing.pair(capability,body,dispatch,Object.entries(req.headers||{}).find(([name])=>name.toLowerCase()==='x-pairing-nonce')?.[1]):await dispatch();
      return response({status:out.status,headers:out.headers,body:out.body??out.bytes.toString('base64url')});
    }catch{return error(502,req.method==='GET'?'The laptop could not complete this request.':'The connection failed. This action may have completed; check its status before retrying.');}finally{active--;}
  };
  handler.close=replay.close;
  return handler;
}
export function startRelay({identity,port,store,onStatus=()=>{},WebSocketImpl=WebSocket}){
  const routing=routingCapabilities(store);const transfers=createTransfers({store,port});const handler=createRelayHandler({identity,port,transfers,store,routing});let stopped=false,ws,timer,heartbeat,attempt=0,alive=false;const controls=new Map();let syncTimer;
  function sync(){
    if(ws?.readyState!==WebSocket.OPEN)return;
    for(const [id,pending] of controls)if(Date.now()-pending.at>5000)controls.delete(id);
    for(const record of routing.requests()){
      if(routing.acknowledgedAction(record)||[...controls.values()].some(p=>p.capId===record.capability.id))continue;
      const id=randomUUID(),action=record.revoked?'revoke':'register';controls.set(id,{capId:record.capability.id,action,at:Date.now()});
      if(action==='register')routing.enforce();
      ws.send(JSON.stringify({type:'capability',id,action,capability:record.capability}));
    }
  }
  function connect(){if(stopped)return;onStatus(false);const url=new URL(`/v1/relay/${encodeURIComponent(identity.id)}/connect`,identity.url);url.protocol='wss:';
    ws=new WebSocketImpl(url,{headers:{authorization:`Bearer ${identity.relayToken}`},maxPayload:MAX_ENVELOPE_BYTES,handshakeTimeout:15000});
    ws.on('open',()=>{sync();attempt=0;alive=true;onStatus(true);heartbeat=setInterval(()=>{if(!alive){ws.terminate();return;}alive=false;ws.ping();},25000);heartbeat.unref();});
    ws.on('pong',()=>{alive=true;});
    ws.on('message',async raw=>{try{if(raw.length>MAX_ENVELOPE_BYTES)return;const msg=JSON.parse(raw);if(msg.type==='capability-ack'){const pending=controls.get(msg.id);if(pending){controls.delete(msg.id);routing.onAck(pending.capId,pending.action,msg);}return;}if(msg.type!=='request')return;const socket=ws;const envelope=await handler(msg.envelope,msg.capability);if(socket.readyState===WebSocket.OPEN&&socket.bufferedAmount<MAX_ENVELOPE_BYTES)socket.send(JSON.stringify({type:'response',envelope}));}catch{/* Untrusted/tampered requests get no oracle. */}});
    ws.on('error',()=>{});ws.on('close',()=>{controls.clear();clearInterval(heartbeat);onStatus(false);if(!stopped){timer=setTimeout(connect,Math.min(30000,500*2**Math.min(attempt++,6))+Math.random()*500);timer.unref();}});
  }
  syncTimer=setInterval(()=>{try{sync();}catch{}},500);syncTimer.unref();connect();
  return {stop(){clearInterval(syncTimer);transfers.close();handler.close();stopped=true;clearTimeout(timer);clearInterval(heartbeat);onStatus(false);ws?.terminate();}};
}
