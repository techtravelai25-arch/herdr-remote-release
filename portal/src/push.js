import {importPKCS8, SignJWT} from 'jose';
import {timingSafeEqual} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {sha256Hex} from './crypto-utils.js';
import {lookupLaptop} from './public.js';

const clock = () => Math.floor(Date.now()/1000);
const validId = value => typeof value==='string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const messageKinds = new Set(['done','needs_input','error','clear']);

/** No analytics, terminal content, filenames, or credentials enter a push payload. */
export function clientPushConfig(env) {
  try {
    const c=JSON.parse(env.FIREBASE_ANDROID_CONFIG||'null');
    if(!c || !/^[a-z][a-z0-9-]{4,60}$/.test(c.projectId) || !/^1:\d+:android:[a-f0-9]+$/.test(c.applicationId) || !/^\d+$/.test(c.senderId) || typeof c.apiKey!=='string' || !/^AIza[\w-]{20,80}$/.test(c.apiKey) || !env.FIREBASE_SERVICE_ACCOUNT) return {available:false};
    return {available:true,projectId:c.projectId,applicationId:c.applicationId,senderId:c.senderId,apiKey:c.apiKey};
  } catch { return {available:false}; }
}

/** Fixed Google endpoints. Private service-account material remains a Worker secret. */
export async function sendFCM(env, token, event) {
  const account=JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const config=clientPushConfig(env);
  if(!config.available || account.project_id!==config.projectId || typeof account.client_email!=='string') throw Error('push_configuration');
  const assertion=await new SignJWT({scope:'https://www.googleapis.com/auth/firebase.messaging'})
    .setProtectedHeader({alg:'RS256',typ:'JWT'}).setIssuer(account.client_email)
    .setAudience('https://oauth2.googleapis.com/token').setIssuedAt().setExpirationTime('5m')
    .sign(await importPKCS8(account.private_key,'RS256'));
  const oauth=await fetch('https://oauth2.googleapis.com/token',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});
  if(!oauth.ok) throw Error('push_authentication');
  const access=await oauth.json();
  if(typeof access.access_token!=='string') throw Error('push_authentication');
  const data={eventId:event.eventId,deviceId:event.deviceId,paneId:event.paneId,kind:event.kind,
    ...(event.kind==='clear'?{targetEventId:event.targetEventId}:{})};
  const response=await fetch(`https://fcm.googleapis.com/v1/projects/${config.projectId}/messages:send`,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${access.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({message:{token,data,android:{priority:event.kind==='clear'?'NORMAL':'HIGH',ttl:'86400s'}}})});
  if(response.ok) return {invalidToken:false};
  const error=await response.json().catch(()=>({}));
  if(error.error?.details?.some(item=>item.errorCode==='UNREGISTERED')) return {invalidToken:true};
  throw Error('push_delivery');
}

/** Called only after native-origin and query guards. helpers enforce existing account auth. */
export async function handlePush(request, env, helpers, sender=sendFCM) {
  const {body,session,rate,registry,allowed,fail,json}=helpers;
  const route=new URL(request.url).pathname;
  if(route==='/v1/push/events' && request.method==='POST') {
    const auth=request.headers.get('authorization')||'';
    if(!/^Bearer [\w-]{43,128}$/.test(auth)) fail(401,'unauthorized','Invalid bridge credential.');
    const token=auth.slice(7),tokenHash=await sha256Hex(token),laptopId=request.headers.get('X-Herdr-Laptop-ID');
    let deviceId,ownerEmail=null;
    if(laptopId!==null) {
      const laptop=await lookupLaptop(env,laptopId,token);
      if(!laptop || typeof laptop.owner_email!=='string' || !laptop.owner_email.trim() ||
          !allowed(env,laptop.owner_email)) fail(401,'unauthorized','Invalid bridge credential.');
      deviceId=laptop.id;ownerEmail=laptop.owner_email;
    } else {
      const configured=JSON.parse(env.PUSH_BRIDGE_TOKEN_HASHES||'{}');
      deviceId=Object.keys(configured).find(id=>validId(id) && /^[a-f0-9]{64}$/.test(configured[id]) && timingSafeEqual(Buffer.from(tokenHash),Buffer.from(configured[id])));
      if(!deviceId || !registry(env).some(d=>d.id===deviceId)) fail(401,'unauthorized','Invalid bridge credential.');
    }
    await rate(env,`push:${deviceId}`,180);
    if(!clientPushConfig(env).available) fail(503,'push_unavailable','Cloud push is not configured.');
    const input=await body(request);
    const clear=input.kind==='clear';
    const fields=clear?['eventId','paneId','kind','createdAt','targetEventId']:['eventId','paneId','kind','createdAt'];
    if(!validId(input.eventId) || typeof input.paneId!=='string' || !input.paneId || input.paneId.length>256 || /[\u0000-\u001f\u007f]/.test(input.paneId) || !messageKinds.has(input.kind) || !Number.isInteger(input.createdAt) || input.createdAt<clock()-86400 || input.createdAt>clock()+60 || Object.keys(input).some(k=>!fields.includes(k)) || (clear&&(!validId(input.targetEventId)||input.targetEventId===input.eventId))) fail(400,'invalid_event','Invalid event.');
    const event={eventId:input.eventId,paneId:input.paneId,kind:input.kind,deviceId,
      ...(clear?{targetEventId:input.targetEventId}:{})};
    await env.DB.prepare('DELETE FROM push_deliveries WHERE claimed_at<?').bind(clock()-172800).run();
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE session_id NOT IN (SELECT id FROM sessions WHERE expires_at>?)').bind(clock()).run();
    const records=await env.DB.prepare('SELECT p.session_id,p.token,s.email FROM push_subscriptions p JOIN sessions s ON p.session_id=s.id WHERE s.expires_at>?').bind(clock()).all();
    let failed=false;
    for(const record of records.results) {
      if(ownerEmail!==null ? record.email!==ownerEmail || !allowed(env,record.email) :
          !allowed(env,record.email)||!registry(env).some(d=>d.id===deviceId&&d.ownerEmail===record.email)) continue;
      const claim=await env.DB.prepare('INSERT INTO push_deliveries(device_id,event_id,session_id,claimed_at,sent) VALUES (?,?,?,?,0) ON CONFLICT(device_id,event_id,session_id) DO UPDATE SET claimed_at=excluded.claimed_at WHERE sent=0 AND claimed_at<? RETURNING session_id').bind(deviceId,input.eventId,record.session_id,clock(),clock()-60).first();
      if(!claim) {
        const old=await env.DB.prepare('SELECT sent FROM push_deliveries WHERE device_id=? AND event_id=? AND session_id=?').bind(deviceId,input.eventId,record.session_id).first();
        if(!old?.sent) failed=true;
        continue;
      }
      try {
        // One final read guards the recipient and current laptop authority after the claim.
        if(ownerEmail!==null && !allowed(env,ownerEmail)) continue;
        const live=ownerEmail!==null
          ? await env.DB.prepare('SELECT s.id FROM sessions s JOIN push_subscriptions p ON p.session_id=s.id JOIN laptops l ON l.id=? AND l.owner_email=s.email WHERE s.id=? AND s.email=? AND s.expires_at>? AND p.token=? AND l.owner_email=? AND l.revoked_at IS NULL AND l.relay_token_hash=?').bind(deviceId,record.session_id,record.email,clock(),record.token,ownerEmail,tokenHash).first()
          : await env.DB.prepare('SELECT s.id FROM sessions s JOIN push_subscriptions p ON p.session_id=s.id WHERE s.id=? AND s.email=? AND s.expires_at>? AND p.token=?').bind(record.session_id,record.email,clock(),record.token).first();
        if(!live) continue;
        if(ownerEmail===null && (!allowed(env,record.email)||!registry(env).some(d=>d.id===deviceId&&d.ownerEmail===record.email))) continue;
        const result=await sender(env,record.token,event);
        if(result.invalidToken) await env.DB.prepare('DELETE FROM push_subscriptions WHERE session_id=? AND token=?').bind(record.session_id,record.token).run();
        await env.DB.prepare('UPDATE push_deliveries SET sent=1 WHERE device_id=? AND event_id=? AND session_id=?').bind(deviceId,input.eventId,record.session_id).run();
      } catch (error) {
        const known = ['push_configuration','push_authentication','push_delivery'];
        console.error('push_send_failed', known.includes(error?.message) ? error.message : error?.name === 'SyntaxError' ? 'invalid_configuration_json' : 'runtime_error');
        failed=true;
        await env.DB.prepare('UPDATE push_deliveries SET claimed_at=0 WHERE device_id=? AND event_id=? AND session_id=? AND sent=0').bind(deviceId,input.eventId,record.session_id).run();
      }
    }
    if(failed) fail(503,'push_retry','Push delivery is temporarily unavailable.');
    return json({ok:true});
  }
  const s=await session(request,env);
  await rate(env,`push-account:${s.id}`,30);
  if(route==='/v1/push/config' && request.method==='GET') return json(clientPushConfig(env));
  if(route==='/v1/push/subscription' && request.method==='DELETE') {
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE session_id=?').bind(s.id).run();
    return json({ok:true});
  }
  if(route==='/v1/push/subscription' && request.method==='PUT') {
    if(!clientPushConfig(env).available) fail(503,'push_unavailable','Cloud push is not configured.');
    const input=await body(request);
    if(typeof input.token!=='string' || !/^[\w:.-]{20,4096}$/.test(input.token) || Object.keys(input).length!==1) fail(400,'invalid_token','Invalid push registration.');
    // A token belongs to one active phone session; fresh sign-in replaces the old registration.
    const written=await env.DB.batch([
      env.DB.prepare('DELETE FROM push_subscriptions WHERE token=? AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND expires_at>?)').bind(input.token,s.id,clock()),
      env.DB.prepare('INSERT INTO push_subscriptions(session_id,token,updated_at) SELECT id,?,? FROM sessions WHERE id=? AND expires_at>? ON CONFLICT(session_id) DO UPDATE SET token=excluded.token,updated_at=excluded.updated_at RETURNING session_id').bind(input.token,clock(),s.id,clock())
    ]);
    if(!written[1].results.length) fail(401,'unauthorized','Your sign-in expired or was revoked.');
    return json({ok:true});
  }
  fail(404,'not_found','Route not found.');
}
