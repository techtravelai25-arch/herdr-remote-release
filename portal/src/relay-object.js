import {DurableObject} from 'cloudflare:workers';
import {MAX_ENVELOPE_BYTES, readEnvelope, validEnvelope, relayError} from './relay.js';
import {RelayMetrics} from './relay-metrics.js';
import {sha256Hex} from './crypto-utils.js';
const clock=()=>Math.floor(Date.now()/1000);
const UPLOAD_DEADLINE_MS=15000;
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
/** Authoritative routing metadata only. Never persist payloads, control tokens or private keys. */
export class Relay extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.pending=new Map();this.reading=new Map();this.metrics=new RelayMetrics(env.RELAY_METRICS_ENABLED==='true');
    this.state={initialized:false,strict:false,revoked:false,generation:0,revocations:0,laptopId:'',mirrorPending:false,mirrorAttempts:0,caps:{},budget:{bucket:0,rpc:0,connect:0,ws:0,control:0,bytes:0,cap:{}}};
    ctx.blockConcurrencyWhile(async()=>{this.state=await ctx.storage.get('state')||this.state;});
  }
  async save(){await this.ctx.storage.put('state',this.state);}
  async budget(kind,bytes=0,capId='',bootstrap=false) {
    const minute=Math.floor(clock()/60);
    const b=this.state.budget;
    if(b.bucket!==minute)this.state.budget={bucket:minute,rpc:0,connect:0,ws:0,control:0,bytes:0,cap:{}};
    const current=this.state.budget;
    if(kind==='connect'){if((current.connect||0)>=60)return false;current.connect=(current.connect||0)+1;await this.save();return true;}
    if(kind==='ws'){
      current.ws++;current.bytes+=bytes;
      await this.save();return current.ws<=2400&&current.bytes<=32*1024*1024;
    }
    current.rpc++;current.cap[capId]=(current.cap[capId]||0)+1;
    await this.save();return current.rpc<=1800&&current.cap[capId]<=(bootstrap?10:600);
  }
  async fetch(request) {
    if(new URL(request.url).pathname!=='/rpc')return this.handle(request);
    const started=this.metrics.start();
    try{const response=await this.handle(request);this.metrics.finish(started,response.status);return response;}catch(error){this.metrics.finish(started,500);throw error;}
  }
  async handle(request) {
    const path=new URL(request.url).pathname;
    // These administrative paths are reachable only by this Worker's DO binding.
    if(path==='/admin/init'&&request.method==='POST') {
      const input=await request.json();
      if(!uuid(input.id))return relayError(400,'invalid_request','Invalid laptop identity.');
      const changed=!this.state.initialized||this.state.laptopId!==input.id||(!this.state.strict&&input.strict===true);
      this.state.laptopId=input.id;this.state.initialized=true;this.state.strict ||= input.strict===true;
      if(changed)await this.save();return Response.json({ok:true});
    }
    if(path==='/admin/revoke'&&request.method==='POST') {
      const input=await request.json();if(!uuid(input.id))return relayError(400,'invalid_request','Invalid laptop identity.');
      this.state.laptopId=input.id;this.state.revoked=true;this.state.mirrorPending=true;this.state.mirrorAttempts=0;
      await this.ctx.storage.transaction(async txn=>{await txn.put('state',this.state);await txn.setAlarm(Date.now()+1000);});
      for(const entry of this.reading.values())entry.cancel(relayError(404,'laptop_unavailable','This laptop has been revoked.'));
      for(const socket of this.ctx.getWebSockets()){socket.close(4001,'Laptop revoked');this.disconnected(socket);}
      return Response.json({ok:true});
    }
    if(this.state.revoked)return relayError(404,'laptop_unavailable','This laptop has been revoked.');
    if(path==='/connect'&&request.headers.get('upgrade')==='websocket') {
      if(!this.state.initialized)return relayError(503,'laptop_unavailable','Register this laptop again.');
      if(!await this.budget('connect'))return relayError(429,'rate_limited','Please wait before reconnecting.');
      for(const old of this.ctx.getWebSockets()){old.close(4000,'Laptop reconnected');this.disconnected(old);}
      this.state.generation++;await this.save();
      const pair=new WebSocketPair();this.ctx.acceptWebSocket(pair[1],['laptop']);
      pair[1].serializeAttachment({generation:this.state.generation});
      return new Response(null,{status:101,webSocket:pair[0]});
    }
    if(path!=='/rpc'||request.method!=='POST')return relayError(404,'not_found','Route not found.');
    if(!this.state.initialized)return relayError(503,'laptop_offline','Your laptop is offline.');
    const bearer=request.headers.get('authorization')?.match(/^Bearer ([\w-]{43})$/)?.[1];
    let capability=null;
    if(bearer){const h=await sha256Hex(bearer);const match=Object.entries(this.state.caps).find(([,cap])=>cap.hash===h&&(cap.expires===0||cap.expires>clock()));if(match)capability={id:match[0],kind:match[1].kind};}
    const legacyUntil=Number(this.env.LEGACY_RELAY_UNTIL||0);
    if(!capability&&(bearer||this.state.strict||clock()>=legacyUntil))return relayError(401,'routing_required','Scan a new laptop QR code to authorize this phone.');
    if(!await this.budget('rpc',0,capability?.id||'legacy',capability?.kind==='bootstrap'))return relayError(429,'rate_limited','Please wait before trying again.');
    if(this.state.revoked)return relayError(404,'laptop_unavailable','This laptop has been revoked.');
    if(capability){const cap=this.state.caps[capability.id];if(!cap||(cap.expires!==0&&cap.expires<=clock()))return relayError(401,'routing_required','This phone authorization expired or was revoked.');}
    else if(this.state.strict||clock()>=legacyUntil)return relayError(401,'routing_required','Scan a new laptop QR code to authorize this phone.');
    // Reserve before reading a potentially slow body; pending + reading share the same limits.
    const active=[...this.pending.values(),...this.reading.values()];
    if(active.length>=16||(capability?.kind==='bootstrap'&&active.filter(p=>p.kind==='bootstrap').length>=2)||active.filter(p=>p.capId===capability?.id).length>=(capability?.kind==='bootstrap'?2:8))return relayError(429,'relay_busy','Your laptop is busy. Try again shortly.');
    const slot=crypto.randomUUID(),controller=new AbortController();
    const cancel=response=>{if(!controller.signal.aborted)controller.abort(response);};
    this.reading.set(slot,{capId:capability?.id,kind:capability?.kind,cancel});this.metrics.pressure(this.pending.size,this.reading.size);
    const authorizationEnds=capability?this.state.caps[capability.id].expires*1000:legacyUntil*1000;
    const deadline=Math.min(Date.now()+UPLOAD_DEADLINE_MS,authorizationEnds||Infinity);
    const timeout=setTimeout(()=>cancel(deadline===authorizationEnds
      ?relayError(401,'routing_required','This phone authorization expired or was revoked.')
      :relayError(408,'upload_timeout','Encrypted request upload timed out. Try again.')),Math.max(0,deadline-Date.now()));
    const abort=()=>cancel(relayError(499,'cancelled','Request cancelled.'));
    request.signal.addEventListener('abort',abort,{once:true});
    let envelope;
    try{if(request.signal.aborted)abort();envelope=await readEnvelope(request,{signal:controller.signal});}
    catch(error){if(error instanceof Response)return error;throw error;}
    finally{clearTimeout(timeout);request.signal.removeEventListener('abort',abort);this.reading.delete(slot);}
    if(!envelope)return relayError(400,'invalid_envelope','Invalid encrypted request.');
    if(this.state.revoked)return relayError(404,'laptop_unavailable','This laptop has been revoked.');
    if(capability){const cap=this.state.caps[capability.id];if(!cap||(cap.expires!==0&&cap.expires<=clock()))return relayError(401,'routing_required','This phone authorization expired or was revoked.');}
    else if(this.state.strict||clock()>=legacyUntil)return relayError(401,'routing_required','Scan a new laptop QR code to authorize this phone.');
    const socket=this.ctx.getWebSockets('laptop').find(ws=>ws.readyState===WebSocket.OPEN);
    if(!socket)return relayError(503,'laptop_offline','Your laptop is offline. Wake it or check its connection.');
    if((capability?.kind==='bootstrap'&&[...this.pending.values()].filter(p=>p.kind==='bootstrap').length>=2)||this.pending.size>=16||[...this.pending.values()].filter(p=>p.capId===capability?.id).length>=(capability?.kind==='bootstrap'?2:8))return relayError(429,'relay_busy','Your laptop is busy. Try again shortly.');
    if(this.pending.has(envelope.id))return relayError(409,'duplicate_request','This request is already in progress.');
    return new Promise(resolve=>{
      let settled=false;
      const finish=response=>{if(settled)return;settled=true;clearTimeout(timer);request.signal.removeEventListener('abort',abort);this.pending.delete(envelope.id);resolve(response);};
      const timer=setTimeout(()=>finish(relayError(504,'delivery_unknown','The laptop did not respond. Check status before retrying; the action may have completed.')),70000);
      const abort=()=>finish(relayError(499,'cancelled','Request cancelled.'));
      this.pending.set(envelope.id,{finish,socket,capId:capability?.id,kind:capability?.kind});this.metrics.pressure(this.pending.size,this.reading.size);request.signal.addEventListener('abort',abort,{once:true});
      if(request.signal.aborted){abort();return;}
      try{socket.send(JSON.stringify({type:'request',...(capability?{capability}:{}),envelope}));}catch{finish(relayError(503,'delivery_unknown','Laptop disconnected. Check status before retrying.'));}
    });
  }
  async webSocketMessage(socket,message) {
    if(this.state.revoked||socket.deserializeAttachment()?.generation!==this.state.generation){socket.close(4001,'Inactive connection');return;}
    if(typeof message!=='string'||message.length>MAX_ENVELOPE_BYTES||new TextEncoder().encode(message).byteLength>MAX_ENVELOPE_BYTES||!await this.budget('ws',new TextEncoder().encode(message).byteLength)){socket.close(1008,'Message budget exceeded');this.disconnected(socket);return;}
    if(this.state.revoked||socket.deserializeAttachment()?.generation!==this.state.generation){socket.close(4001,'Inactive connection');return;}
    let frame;try{frame=JSON.parse(message);}catch{socket.close(1003,'Invalid frame');this.disconnected(socket);return;}
    if(frame.type==='capability'){
      this.state.budget.control=(this.state.budget.control||0)+1;await this.save();
      if(this.state.budget.control>300){socket.close(1008,'Control budget exceeded');this.disconnected(socket);return;}
      let error;const cap=frame.capability;
      if(!uuid(frame.id)||!uuid(cap?.id))error='invalid_capability';
      else if(frame.action==='revoke'&&!this.state.caps[cap.id]){if(!await this.ctx.storage.get('revoked:'+cap.id))error='capability_not_found';}
      else if(frame.action==='revoke'){
        this.state.revocations++;
        delete this.state.caps[cap.id];await this.ctx.storage.put({['revoked:'+cap.id]:true,state:this.state});
        for(const entry of this.reading.values())if(entry.capId===cap.id)entry.cancel(relayError(401,'routing_required','This phone was revoked.'));
        for(const entry of this.pending.values())if(entry.capId===cap.id)entry.finish(relayError(401,'routing_required','This phone was revoked.'));
      }else if(frame.action==='register'&&await this.ctx.storage.get('revoked:'+cap.id))error='capability_revoked';
      else if(frame.action==='register'){
        for(const [id,value] of Object.entries(this.state.caps))if(value.expires!==0&&value.expires<=clock())delete this.state.caps[id];
        if(!['bootstrap','phone'].includes(cap.kind)||!/^[a-f0-9]{64}$/.test(cap.tokenHash||'')||!Number.isSafeInteger(cap.expires)||(cap.kind==='phone'?cap.expires!==0:cap.expires<=clock()||cap.expires>clock()+600))error='invalid_capability';
        else if(this.state.caps[cap.id]&&(this.state.caps[cap.id].hash!==cap.tokenHash||this.state.caps[cap.id].kind!==cap.kind||this.state.caps[cap.id].expires!==cap.expires))error='capability_conflict';
        else if(!this.state.caps[cap.id]&&(Object.keys(this.state.caps).length>=128||this.state.revocations>=4096))error='capability_limit';
        else {const promoted=!this.state.strict;this.state.strict=true;this.state.caps[cap.id]={hash:cap.tokenHash,kind:cap.kind,expires:cap.expires};await this.save();if(promoted)for(const entry of this.reading.values())if(!entry.capId)entry.cancel(relayError(401,'routing_required','Scan a new laptop QR code to authorize this phone.'));}
      }else error='invalid_action';
      socket.send(JSON.stringify({type:'capability-ack',id:frame.id,ok:!error,...(error?{error}:{})}));return;
    }
    if(frame.type!=='response'||!validEnvelope(frame.envelope,false)){socket.close(1003,'Invalid frame');this.disconnected(socket);return;}
    const entry=this.pending.get(frame.envelope.id);if(entry?.socket===socket)this.metrics.response(new TextEncoder().encode(JSON.stringify(frame.envelope)).byteLength);if(entry?.socket===socket)entry.finish(Response.json(frame.envelope,{headers:{'Cache-Control':'no-store'}}));
  }
  async alarm(){
    if(!this.state.mirrorPending||!this.state.revoked)return;
    try{
      await this.env.DB.prepare('UPDATE laptops SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(clock(),this.state.laptopId).run();
      this.state.mirrorPending=false;this.state.mirrorAttempts=0;await this.save();
    }catch{
      this.state.mirrorAttempts++;await this.ctx.storage.transaction(async txn=>{await txn.put('state',this.state);await txn.setAlarm(Date.now()+Math.min(3600000,30000*2**Math.min(this.state.mirrorAttempts-1,7)));});
    }
  }
  disconnected(socket){for(const entry of this.pending.values())if(entry.socket===socket)entry.finish(relayError(503,'delivery_unknown','Laptop disconnected. Check status before retrying; the action may have completed.'));}
  webSocketClose(socket){this.disconnected(socket);}
  webSocketError(socket){this.disconnected(socket);}
}
