import {handleSetup} from './setup.js';
import {timingSafeEqual} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {createRemoteJWKSet, importJWK, jwtVerify, SignJWT} from 'jose';
import {handlePush, sendFCM} from './push.js';
import {handlePublic, accountAllowed, accountDevices, handleAccountDevices, deleteCloudAccount, startWebDeletion, confirmWebDeletion} from './public.js';
import {handleRelay} from './relay.js';
import {hasMediaType} from './media-type.js';
import {sha256Hex} from './crypto-utils.js';
import {recordAndroidDownload} from './download-metrics.js';

/** @typedef {{[K in keyof Env]: Env[K] extends string ? string : Env[K]} & {GRANT_SIGNING_JWK: string, GRANT_ISSUER?: string, EMAIL_OTP_SECRET?: string}} PortalEnv */

// Cache only public signing-key resolvers, never request or user state.
const accessKeySets = new Map();
function accessKeys(domain) {
  if(!accessKeySets.has(domain)) {
    if(accessKeySets.size >= 4) accessKeySets.clear();
    accessKeySets.set(domain,createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`)));
  }
  return accessKeySets.get(domain);
}
const now = () => Math.floor(Date.now() / 1000);
const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
export const hash = sha256Hex;
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const GITHUB_APK_URL='https://github.com/techtravelai25-arch/herdr-remote-release/releases/latest/download/herdr-remote.apk';
function publicApkUrl(env) {
  const candidate=env.PUBLIC_APK_URL||GITHUB_APK_URL;
  if(candidate==='/v1/app-update/apk')return candidate;
  try { const url=new URL(candidate);if(url.protocol==='https:'&&!url.username&&!url.password&&!url.hash)return candidate; }
  catch {}
  return GITHUB_APK_URL;
}
class HttpError extends Error { constructor(status, code, message) { super(message); this.status=status; this.code=code; } }
const fail = (status, code, message) => { throw new HttpError(status,code,message); };
const headers = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"};
const json = (data,status=200) => Response.json(data,{status,headers});
// Native form submissions inherit the document policy. no-referrer turns
// their Origin header into null, so approval pages must preserve same-origin.
const html = (body,cookie,referrerPolicy='no-referrer') => new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Herdr Remote</title><style>body{font:18px system-ui;max-width:32rem;margin:12vh auto;padding:24px;line-height:1.6;background:#f5f5f3;color:#202321}button{font:inherit;padding:12px 18px}code{font-size:2rem}</style>${body}</html>`,{headers:{...headers,'Referrer-Policy':referrerPolicy,'Content-Type':'text/html; charset=utf-8',...(cookie?{'Set-Cookie':cookie}:{})}});
/** @param {PortalEnv} env */
function allowed(env,email) { const entries=JSON.parse(env.ALLOWED_EMAILS||'[]'); return typeof email==='string' && entries.some(e=>typeof e==='string'&&e.toLowerCase()===email.toLowerCase()); }
function requireAllowed(env,email) { if(!allowed(env,email)) fail(403,'access_denied','This email is not allowed to sign in.'); }
/** @param {PortalEnv} env */
function configured(env) { if(!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.GRANT_SIGNING_JWK || !JSON.parse(env.ALLOWED_EMAILS||'[]').length) fail(503,'login_unavailable','Email sign-in is not configured yet.'); }
async function smallBody(request) {
  const reader=request.body?.getReader(); if(!reader) return '';
  const chunks=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4096){try{void reader.cancel().catch(()=>{});}catch{}fail(413,'body_too_large','Request is too large.');}chunks.push(value);}
  return Buffer.concat(chunks).toString('utf8');
}
async function body(request) { if(!hasMediaType(request,'application/json'))fail(415,'content_type','Use application/json.');try{const v=JSON.parse(await smallBody(request));if(!v||typeof v!=='object'||Array.isArray(v))throw Error();return v;}catch(e){if(e instanceof HttpError)throw e;fail(400,'invalid_json','Invalid request.');} }
async function rate(env,key,limit,window=60) {
  const bucket=Math.floor(now()/window); const id=await hash(`${key}:${bucket}`);
  const row=await env.DB.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(id,now()+window*2).first();
  if(row.count>limit)fail(429,'rate_limited','Please wait before trying again.');
}
async function session(request,env,allowDeletion=false) {
  const value=request.headers.get('authorization');
  if(!value?.startsWith('Bearer ')||value.length>300)fail(401,'unauthorized','Sign in again.');
  const tokenHash=await hash(value.slice(7));
  const row=await env.DB.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').bind(tokenHash,now()).first();
  if(!row)fail(401,'unauthorized','Your sign-in expired or was revoked.');
  if(!allowDeletion&&!accountAllowed(env,row.email,allowed))requireAllowed(env,row.email); return row;
}
/** @param {PortalEnv} env */
export function registry(env) {
  const devices=JSON.parse(env.DEVICES||'[]');
  if(!Array.isArray(devices))throw Error('Invalid device registry');
  return devices.map(d=>{const u=new URL(d.url);if(!/^[a-zA-Z0-9_-]{1,80}$/.test(d.id)||typeof d.label!=='string'||d.label.length>100||u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||u.port)throw Error('Invalid device registry');return{id:d.id,label:d.label,url:u.origin,ownerEmail:typeof d.ownerEmail==='string'?d.ownerEmail.toLowerCase():null};});
}
/** @param {Request} request @param {PortalEnv} env */
export async function verifyAccess(request,env,keySet,{skipAppAllowlist=false}={}) {
  const domain=env.ACCESS_TEAM_DOMAIN;
  if(!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain||'')||!env.ACCESS_AUD)fail(503,'login_unavailable','Email sign-in is not configured yet.');
  const token=request.headers.get('Cf-Access-Jwt-Assertion');if(!token)fail(401,'access_required','Open this page through Cloudflare Access.');
  let payload;
  try { ({payload}=await jwtVerify(token,keySet||accessKeys(domain),{issuer:`https://${domain}`,audience:env.ACCESS_AUD,algorithms:['RS256'],requiredClaims:['exp','iat','sub','email']})); }
  catch { fail(401,'access_invalid','Your email sign-in could not be verified.'); }
  if(typeof payload.email!=='string')fail(401,'access_invalid','Your email sign-in could not be verified.');
  if(!skipAppAllowlist)requireAllowed(env,payload.email);return payload.email.toLowerCase();
}
/** @param {PortalEnv} env */
export async function signGrant(env,s,device) {
  const jwk=JSON.parse(env.GRANT_SIGNING_JWK);if(jwk.kty!=='OKP'||jwk.crv!=='Ed25519'||!jwk.kid||!jwk.d)throw Error('Invalid grant signing key');
  const issuer=env.GRANT_ISSUER??env.PORTAL_ORIGIN;
  if(env.GRANT_ISSUER!==undefined){
    let url;
    try{url=new URL(issuer);}catch{throw Error('Invalid grant issuer');}
    if(url.protocol!=='https:'||url.origin!==issuer||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.port)throw Error('Invalid grant issuer');
  }
  const expiresAt=now()+300;
  const token=await new SignJWT({sid:s.id}).setProtectedHeader({alg:'EdDSA',typ:'herdr-grant+jwt',kid:jwk.kid}).setIssuer(issuer).setAudience(device.id).setSubject(s.email).setIssuedAt().setExpirationTime(expiresAt).sign(await importJWK(jwk,'EdDSA'));
  return {token,expiresAt,url:device.url,deviceId:device.id};
}
export function createPortal({accessVerifier=verifyAccess,pushSender=sendFCM}={}) {
  return {/** @param {Request} request @param {PortalEnv} env @param {ExecutionContext} [ctx] */ async fetch(request,env,ctx) {
    try {
      const url=new URL(request.url);
      if(url.origin!==env.PORTAL_ORIGIN)fail(421,'wrong_origin','Use the configured sign-in address.');
      const setupResponse=await handleSetup(request,env);
      if(setupResponse)return setupResponse;
      const releaseAsset = url.pathname === '/v1/app-update' ? '/app-update.json'
        : url.pathname === '/v1/app-update/apk' ? '/herdr-remote.apk' : null;
      if(releaseAsset) {
        if(url.search) fail(400,'invalid_request','Query parameters are not supported.');
        if(!['GET','HEAD'].includes(request.method)) fail(405,'method_not_allowed','Use GET or HEAD.');
        if(!env.ASSETS) fail(503,'update_unavailable','No app update is available yet.');
        // Build a fresh request: no account credentials, cookies, conditional or
        // range headers cross into asset storage. Keep the APK body streaming.
        const asset=await env.ASSETS.fetch(new Request(new URL(releaseAsset,env.PORTAL_ORIGIN),{method:request.method}));
        if(asset.status!==200) fail(503,'update_unavailable','No app update is available yet.');
        const outputHeaders=new Headers(headers);
        const apk=releaseAsset.endsWith('.apk');
        outputHeaders.set('Content-Type',apk?'application/vnd.android.package-archive':'application/json');
        if(apk)outputHeaders.set('Content-Disposition','attachment; filename="herdr-remote.apk"');
        const length=asset.headers.get('Content-Length');if(length)outputHeaders.set('Content-Length',length);
        const output=new Response(request.method==='HEAD'?null:asset.body,{status:200,headers:outputHeaders});
        if(apk&&request.method==='GET') {
          // Counts responses served, not completed transfers or unique installs.
          // Telemetry failure must never block an app download.
          const count=recordAndroidDownload(env,output,request).catch(()=>{console.warn('android_download_metrics_unavailable');});
          if(ctx)ctx.waitUntil(count);else await count;
        }
        return output;
      }
      if((url.pathname==='/'||url.pathname==='/download')&&request.method==='GET')return html(`<h1>Herdr Remote</h1><p>Connect to your laptops from your Android phone.</p><p><a href="${escapeHtml(publicApkUrl(env))}">Download Herdr Remote for Android</a></p><p>Open the downloaded APK to install or update the app. Android keeps app data when updating a compatible, identically signed package.</p><p><a href="/setup">Set up your Linux laptop</a>, then scan its QR code in the app. <a href="/source">Source code and licence</a> · <a href="/privacy">Privacy</a> · <a href="/account/delete">Account deletion</a>.</p>`);
      if(url.pathname==='/privacy'&&request.method==='GET')return html('<h1>Herdr Remote privacy</h1><p>Herdr Remote routes encrypted Android relay traffic between your phone and laptop. The relay sees routing and connection metadata but cannot read encrypted prompts, terminal output, or files. Agents and voice services you choose may send content to their own providers.</p><p>Optional email sign-in stores your email, sign-in sessions, laptop directory entries, and push routing tokens. The service also stores short-lived abuse counters and login challenges. Push alerts contain generic event metadata, not agent output or file contents.</p><p>You can delete the optional cloud account in the Android app or <a href="/account/delete">request deletion here</a>. Cloud deletion removes sign-in sessions, pending email challenges, push subscriptions, and the account link to laptops. It does not remove files or agent history on your laptop, or revoke a phone key trusted locally by that laptop. Use the laptop’s remote-control settings to revoke local control.</p><p>For privacy, support, or security questions, email <a href="mailto:techtravelai25@gmail.com">techtravelai25@gmail.com</a>.</p>');
      if(url.pathname==='/account/delete'&&request.method==='GET')return html('<h1>Delete your Herdr Remote cloud account</h1><p>Enter your account email to receive a one-time deletion code. The Android app also offers cloud account deletion in account settings.</p><form method="POST" action="/account/delete/start"><label>Email <input name="email" type="email" autocomplete="email" required maxlength="254"></label><button type="submit">Send deletion code</button></form><p>This removes email sign-in sessions, push registrations, and cloud laptop directory links. It does not revoke a phone key trusted locally by your laptop or remove laptop files and agent history. Use the laptop’s remote-control settings to revoke local control.</p><p>Need help with deletion? Email <a href="mailto:techtravelai25@gmail.com">techtravelai25@gmail.com</a>.</p><p><a href="/privacy">Privacy information</a></p>','', 'same-origin');
      if(url.pathname==='/account/delete/start'&&request.method==='POST'){
        if(request.headers.get('origin')!==env.PORTAL_ORIGIN)fail(403,'invalid_origin','Open the deletion page directly.');
        if(!hasMediaType(request,'application/x-www-form-urlencoded'))fail(415,'content_type','Use the deletion form.');
        if(!env.EDGE_SIGNUP_LIMIT||!(await env.EDGE_SIGNUP_LIMIT.limit({key:request.headers.get('CF-Connecting-IP')||'local'})).success)fail(429,'rate_limited','Please wait before trying again.');
        const fields=new URLSearchParams(await smallBody(request));
        if([...fields.keys()].some(key=>key!=='email')||fields.getAll('email').length!==1)fail(400,'invalid_request','Enter an email address.');
        const challenge=await startWebDeletion(env,fields.get('email'),request.headers.get('CF-Connecting-IP')||'unknown');
        if(challenge===null)fail(400,'invalid_email','Enter a valid email address.');
        if(challenge===false)fail(429,'rate_limited','Please wait before trying again.');
        return html(`<h1>Confirm cloud account deletion</h1><p>If this address receives mail, enter the six-digit code sent to it. The code expires in ten minutes.</p><form method="POST" action="/account/delete/confirm"><input type="hidden" name="challenge" value="${challenge}"><label>Deletion code <input name="code" inputmode="numeric" pattern="[0-9]{6}" required maxlength="6"></label><button type="submit">Delete cloud account</button></form>`,'','same-origin');
      }
      if(url.pathname==='/account/delete/confirm'&&request.method==='POST'){
        if(request.headers.get('origin')!==env.PORTAL_ORIGIN)fail(403,'invalid_origin','Open the deletion page directly.');
        if(!hasMediaType(request,'application/x-www-form-urlencoded'))fail(415,'content_type','Use the deletion form.');
        await rate(env,`delete-confirm:${request.headers.get('CF-Connecting-IP')||'unknown'}`,60,600);
        const fields=new URLSearchParams(await smallBody(request));
        if([...fields.keys()].some(key=>!['challenge','code'].includes(key))||fields.getAll('challenge').length!==1||fields.getAll('code').length!==1)fail(400,'invalid_request','Enter the deletion code.');
        if(!await confirmWebDeletion(env,fields.get('challenge'),fields.get('code')))fail(401,'invalid_code','The code is invalid, expired, or already used. Start again if needed.');
        return html('<h1>Cloud account deleted</h1><p>Your cloud sign-in, push routing, and laptop directory links have been removed. Locally paired phones may still be trusted by the laptop. Use the laptop’s remote-control settings to revoke local control.</p>');
      }
      if(url.pathname==='/.well-known/jwks.json'&&request.method==='GET') {
        if(!env.GRANT_SIGNING_JWK)fail(503,'login_unavailable','Email sign-in is not configured yet.');
        const {kty,crv,x,kid}=JSON.parse(env.GRANT_SIGNING_JWK);
        return json({keys:[{kty,crv,x,kid,alg:'EdDSA',use:'sig'}]});
      }
      const relayResponse=url.pathname.startsWith('/v1/relay/')?await handleRelay(request,env):null;
      if(relayResponse)return relayResponse;
      if(url.pathname==='/login'||url.pathname==='/login/approve') {
        configured(env);
        const email=await accessVerifier(request,env);
        const userCode=url.searchParams.get('code')||'';
        if(!/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(userCode))fail(400,'invalid_code','Start sign-in from the app.');
        const pending=await env.DB.prepare('SELECT * FROM auth_requests WHERE user_code=? AND expires_at>?').bind(userCode,now()).first();
        if(!pending||pending.email)fail(410,'login_expired','This sign-in request expired or was already approved.');
        if(url.pathname==='/login'&&request.method==='GET') {
          const csrf=random();
          await env.DB.prepare('UPDATE auth_requests SET csrf_hash=? WHERE user_code=? AND email IS NULL').bind(await hash(csrf),userCode).run();
          return html(`<h1>Sign in to Herdr Remote</h1><p>Signed in as <strong>${escapeHtml(email)}</strong>.</p><p>Only approve if you started sign-in in your app and it shows this code:</p><p><code>${userCode}</code></p><p>Device: ${escapeHtml(pending.device_name)}</p><form method="POST" action="/login/approve?code=${userCode}"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Approve this device</button></form>`,`__Host-herdr-csrf=${csrf}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=600`,'same-origin');
        }
        if(url.pathname==='/login/approve'&&request.method==='POST') {
          if(request.headers.get('origin')!==env.PORTAL_ORIGIN)fail(403,'csrf','Open sign-in again from the app.');
          if(!hasMediaType(request,'application/x-www-form-urlencoded'))fail(415,'content_type','Use the approval form.');
          const fields=new URLSearchParams(await smallBody(request));
          const csrf=fields.get('csrf')||'';
          const cookie=request.headers.get('cookie')?.split(';').map(c=>c.trim()).find(c=>c.startsWith('__Host-herdr-csrf='))?.slice('__Host-herdr-csrf='.length)||'';
          if(!csrf||csrf.length>100||!timingSafeEqual(Buffer.from(await hash(csrf)),Buffer.from(await hash(cookie)))||typeof pending.csrf_hash!=='string'||!timingSafeEqual(Buffer.from(await hash(csrf)),Buffer.from(pending.csrf_hash)))fail(403,'csrf','Open sign-in again from the app.');
          const result=await env.DB.prepare('UPDATE auth_requests SET email=?,csrf_hash=NULL WHERE user_code=? AND email IS NULL AND expires_at>? AND csrf_hash=? RETURNING user_code').bind(email,userCode,now(),await hash(csrf)).first();
          if(!result)fail(410,'login_expired','Start sign-in again from the app.');
          return html('<h1>Device approved</h1><p>Return to Herdr Remote. Your laptops will appear automatically.</p>','__Host-herdr-csrf=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        }
        fail(404,'not_found','Page not found.');
      }
      if(!url.pathname.startsWith('/v1/'))fail(404,'not_found','Page not found.');
      if(request.headers.has('origin'))fail(403,'origin_forbidden','Use the Android app.');
      if(url.search)fail(400,'invalid_request','Query parameters are not supported.');
      const publicResponse=await handlePublic(request,env,{body,rate,fail,json});
      if(publicResponse)return publicResponse;
      if(url.pathname==='/v1/auth/start'&&request.method==='POST') {
        configured(env);
        await rate(env,'start:global',60,600);
        await rate(env,`start:${request.headers.get('CF-Connecting-IP')||'unknown'}`,10,600);
        const input=await body(request);const deviceName=typeof input.deviceName==='string'?input.deviceName.trim().slice(0,80):'Android phone';
        const deviceCode=random();const bytes=Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString('hex').toUpperCase();const userCode=`${bytes.slice(0,4)}-${bytes.slice(4)}`;
        await env.DB.batch([env.DB.prepare('DELETE FROM auth_requests WHERE expires_at<=?').bind(now()),env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(now()),env.DB.prepare('DELETE FROM rate_limits WHERE expires_at<=?').bind(now()),env.DB.prepare('INSERT INTO auth_requests(device_hash,user_code,device_name,expires_at) VALUES (?,?,?,?)').bind(await hash(deviceCode),userCode,deviceName||'Android phone',now()+600)]);
        return json({deviceCode,userCode,verificationUrl:`${env.PORTAL_ORIGIN}/login?code=${userCode}`,expiresIn:600,interval:3});
      }
      if(url.pathname==='/v1/auth/poll'&&request.method==='POST') {
        configured(env);
        const input=await body(request);if(typeof input.deviceCode!=='string'||!/^[\w-]{43}$/.test(input.deviceCode))fail(400,'invalid_request','Invalid device code.');
        const deviceHash=await hash(input.deviceCode);
        await rate(env,'poll:global',3000);
        const p=await env.DB.prepare('SELECT email FROM auth_requests WHERE device_hash=? AND expires_at>?').bind(deviceHash,now()).first();
        if(!p)fail(410,'login_expired','Start sign-in again.');
        await rate(env,`poll:${deviceHash}`,30);
        if(!p.email)return json({status:'pending'},202);
        requireAllowed(env,p.email);
        const token=random();const tokenHash=await hash(token);const id=crypto.randomUUID();const expiresAt=now()+30*86400;
        // D1 executes this batch as one transaction. UNIQUE request_hash ensures
        // concurrent polls can issue at most one account session.
        const results=await env.DB.batch([
          env.DB.prepare('INSERT OR IGNORE INTO sessions(token_hash,id,request_hash,email,expires_at) SELECT ?,?,device_hash,email,? FROM auth_requests WHERE device_hash=? AND email IS NOT NULL AND expires_at>?').bind(tokenHash,id,expiresAt,deviceHash,now()),
          env.DB.prepare('DELETE FROM auth_requests WHERE device_hash=? AND EXISTS(SELECT 1 FROM sessions WHERE request_hash=?)').bind(deviceHash,deviceHash),
          env.DB.prepare('SELECT email FROM sessions WHERE token_hash=?').bind(tokenHash)
        ]);
        if(!results[2].results.length)fail(410,'login_expired','This sign-in request was already used.');
        return json({token,email:p.email,expiresAt});
      }
      if(url.pathname.startsWith('/v1/push/')) return await handlePush(request,env,{body,session,rate,registry,allowed:(e,email)=>accountAllowed(e,email,allowed),fail,json},pushSender);
      const s=await session(request,env,url.pathname==='/v1/account'&&request.method==='DELETE');await rate(env,`session:${s.id}`,180);
      if(url.pathname==='/v1/account'&&request.method==='DELETE'){
        await deleteCloudAccount(env,s.email);
        return json({ok:true,cloudAccountDeleted:true,localControlRevoked:false});
      }
      if(url.pathname==='/v1/auth/session'&&request.method==='DELETE'){await env.DB.prepare('DELETE FROM sessions WHERE id=?').bind(s.id).run();return json({ok:true});}
      const deviceResponse=await handleAccountDevices(request,env,s,{body,fail,json});
      if(deviceResponse)return deviceResponse;
      if(url.pathname==='/v1/devices'&&request.method==='GET')return json({devices:await accountDevices(env,s.email,registry)});
      const match=url.pathname.match(/^\/v1\/devices\/([a-zA-Z0-9_-]{1,80})\/grant$/);
      if(match&&request.method==='POST'){const d=(await accountDevices(env,s.email,registry)).find(d=>d.id===match[1]);if(!d)fail(404,'device_not_found','Laptop not found.');if(d.transport==='relay')fail(409,'pairing_required','Scan this laptop’s QR code to securely pair this phone.');return json(await signGrant(env,s,d));}
      fail(404,'not_found','Route not found.');
    } catch(e) {
      if(e instanceof HttpError)return json({error:{code:e.code,message:e.message}},e.status);
      // No exception text: SQL/JWT/library errors may contain credentials.
      return json({error:{code:'unavailable',message:'Sign-in is temporarily unavailable.'}},503);
    }
  }};
}
export default createPortal();
