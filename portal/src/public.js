import {admit} from './admission.js';
import {Buffer} from 'node:buffer';
import {timingSafeEqual} from 'node:crypto';
import {sha256Hex} from './crypto-utils.js';
const now=()=>Math.floor(Date.now()/1000);
const random=()=>Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const validToken=value=>typeof value==='string'&&/^[\w-]{43}$/.test(value);
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
// Outbound email cost breaker and per-IP daily share (25000/50 = 500 addresses).
const EMAIL_GLOBAL_DAILY=25000,EMAIL_IP_DAILY=50;
const enabled=env=>env.PUBLIC_SIGNUP_ENABLED==='true';
export const accountAllowed=(env,email,legacyAllowed)=>enabled(env)||legacyAllowed(env,email);
export async function lookupLaptop(env,id,token) {
  if(typeof id!=='string'||!/^[\w-]{1,80}$/.test(id)||!validToken(token))return null;
  const row=await env.DB.prepare('SELECT * FROM laptops WHERE id=? AND revoked_at IS NULL').bind(id).first();
  return row&&equal(row.relay_token_hash,await sha256Hex(token))?row:null;
}
function otp() {
  const bytes=new Uint32Array(1);
  do {crypto.getRandomValues(bytes);} while(bytes[0]>=4294000000);
  return String(bytes[0]%1000000).padStart(6,'0');
}
async function otpHash(env,challenge,code) {
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.EMAIL_OTP_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${challenge}:${code}`))).toString('hex');
}
/** Native clients only; origin, query and body guards live in index.js. */
export async function handlePublic(request,env,{body,rate,fail,json}) {
  const path=new URL(request.url).pathname;
  if(path==='/v1/laptops/register'||path.startsWith('/v1/auth/email/')){
    if(!env.EDGE_SIGNUP_LIMIT)fail(503,'login_unavailable','Signup abuse protection is not configured.');
    if(!(await env.EDGE_SIGNUP_LIMIT.limit({key:request.headers.get('CF-Connecting-IP')||'local'})).success)fail(429,'rate_limited','Please wait before trying again.');
  }
  if(path==='/v1/laptops/register'&&request.method==='POST') {
    if(env.LAPTOP_REGISTRATION_ENABLED!=='true')fail(503,'registration_unavailable','Laptop registration is not available yet.');
    const input=await body(request);
    if(typeof input.label!=='string'||!input.label.trim()||input.label.length>100||/[\x00-\x1f\x7f]/.test(input.label)||typeof input.publicKey!=='string'||!/^[\w+/=-]{40,200}$/.test(input.publicKey))fail(400,'invalid_request','A laptop name and public pairing key are required.');
    try{await crypto.subtle.importKey('spki',Buffer.from(input.publicKey,'base64url'),{name:'ECDH',namedCurve:'P-256'},false,[]);}catch{fail(400,'invalid_request','A valid P-256 public pairing key is required.');}
    if(!await admit(env,crypto.randomUUID(),[{key:'register:global',limit:1000,window:86400},{key:`register:${request.headers.get('CF-Connecting-IP')||'unknown'}`,limit:10,window:3600}]))fail(429,'rate_limited','Please wait before trying again.');
    const id=crypto.randomUUID(),relayToken=random(),claimToken=random();
    // One conditional D1 statement admits the laptop and checks the persisted
    // stop switch and optional cap. Concurrent requests cannot pass a stale count.
    const inserted=await env.DB.prepare(`INSERT INTO laptops(id,label,relay_token_hash,claim_token_hash,public_key,created_at,relay_auth_version)
      SELECT ?,?,?,?,?,?,1 FROM beta_controls
      WHERE id=1 AND registration_enabled=1
        AND (registration_unrestricted=1 OR (SELECT COUNT(*) FROM laptops WHERE revoked_at IS NULL)<max_laptops)
      RETURNING id`).bind(id,input.label.trim(),await sha256Hex(relayToken),await sha256Hex(claimToken),input.publicKey,now()).first();
    if(!inserted)fail(503,'registration_closed','New laptop registration is paused or its registration limit has been reached.');
    return json({id,relayToken,claimToken,url:env.PORTAL_ORIGIN});
  }
  if(!path.startsWith('/v1/auth/email/'))return null;
  if(!enabled(env)||!env.EMAIL||!env.EMAIL_FROM||typeof env.EMAIL_OTP_SECRET!=='string'||env.EMAIL_OTP_SECRET.length<32)fail(503,'login_unavailable','Email sign-in is not available yet.');
  if(request.method!=='POST')fail(405,'method_not_allowed','Use POST.');
  const ip=request.headers.get('CF-Connecting-IP')||'unknown';
  if(path==='/v1/auth/email/start') {
    const input=await body(request);
    const email=typeof input.email==='string'?input.email.trim().toLowerCase():'';
    if(email.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email)||/[<>\r\n]/.test(email))fail(400,'invalid_email','Enter a valid email address.');
    // admit() is all-or-nothing, so per-IP or per-address rejections never charge
    // the global counter. The daily per-IP cap means the global send breaker needs
    // hundreds of addresses, not a handful, to trip.
    if(!await admit(env,crypto.randomUUID(),[{key:'email:global',limit:EMAIL_GLOBAL_DAILY,window:86400},{key:`email:ip:${ip}`,limit:20,window:3600},{key:`email:ip:daily:${ip}`,limit:EMAIL_IP_DAILY,window:86400},{key:`email:daily:${email}`,limit:10,window:86400},{key:`email:cooldown:${email}`,limit:1,window:60,cooldown:true}]))fail(429,'rate_limited','Please wait before trying again.');
    const challengeId=random(),code=otp(),challengeHash=await sha256Hex(challengeId);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM email_challenges WHERE expires_at<=?').bind(now()),
      env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(now()),
      env.DB.prepare('INSERT INTO email_challenges(challenge_hash,email,code_hash,expires_at) VALUES (?,?,?,?)').bind(challengeHash,email,await otpHash(env,challengeId,code),now()+600)
    ]);
    try {
      await env.EMAIL.send({from:env.EMAIL_FROM,to:email,subject:'Your Herdr Remote sign-in code',text:`Your Herdr Remote sign-in code is ${code}. It expires in 10 minutes. Only enter it in the app where you requested it. If you did not request this code, ignore this email.`});
      await env.DB.prepare('UPDATE email_challenges SET ready=1 WHERE challenge_hash=?').bind(challengeHash).run();
    } catch {
      await env.DB.prepare('DELETE FROM email_challenges WHERE challenge_hash=?').bind(challengeHash).run();
      fail(503,'email_unavailable','We could not send your code. Please try again later.');
    }
    return json({challengeId,expiresIn:600,resendAfter:60});
  }
  if(path==='/v1/auth/email/verify') {
    await rate(env,`email:verify:${ip}`,60,600);
    const input=await body(request);
    if(!validToken(input.challengeId)||typeof input.code!=='string'||!/^\d{6}$/.test(input.code))fail(400,'invalid_code','Enter the six-digit code from your email.');
    const challengeHash=await sha256Hex(input.challengeId),codeHash=await otpHash(env,input.challengeId,input.code);
    const token=random(),tokenHash=await sha256Hex(token),id=crypto.randomUUID(),expiresAt=now()+30*86400;
    // All statements run in one D1 transaction. Attempts, consumption and session
    // issuance are serialized; no SELECT-then-UPDATE race can reuse a code.
    const results=await env.DB.batch([
      env.DB.prepare("UPDATE email_challenges SET attempts=attempts+1 WHERE challenge_hash=? AND purpose='sign_in' AND ready=1 AND consumed=0 AND expires_at>? AND attempts<5").bind(challengeHash,now()),
      env.DB.prepare("INSERT OR IGNORE INTO sessions(token_hash,id,request_hash,email,expires_at) SELECT ?,?,?,email,? FROM email_challenges WHERE challenge_hash=? AND purpose='sign_in' AND code_hash=? AND ready=1 AND consumed=0 AND expires_at>? AND attempts<=5").bind(tokenHash,id,challengeHash,expiresAt,challengeHash,codeHash,now()),
      env.DB.prepare("UPDATE email_challenges SET consumed=1 WHERE challenge_hash=? AND purpose='sign_in' AND (attempts>=5 OR EXISTS(SELECT 1 FROM sessions WHERE request_hash=?))").bind(challengeHash,challengeHash),
      env.DB.prepare('SELECT email FROM sessions WHERE token_hash=?').bind(tokenHash)
    ]);
    const row=results[3].results[0];
    if(!row)fail(401,'invalid_code','This code is incorrect, expired, or already used. Request a new code if needed.');
    return json({token,email:row.email,expiresAt});
  }
  fail(404,'not_found','Route not found.');
}
export async function accountDevices(env,email,registry) {
  const legacy=registry(env).filter(d=>d.ownerEmail===email).map(({ownerEmail,...device})=>device);
  const rows=await env.DB.prepare('SELECT id,label FROM laptops WHERE owner_email=? AND revoked_at IS NULL').bind(email).all();
  return [...legacy,...rows.results.map(d=>({id:d.id,label:d.label,url:env.PORTAL_ORIGIN,transport:'relay'}))];
}
export async function handleAccountDevices(request,env,s,{body,fail,json}) {
  const path=new URL(request.url).pathname;
  if(path==='/v1/devices/claim'&&request.method==='POST') {
    const input=await body(request);
    if(typeof input.deviceId!=='string'||!/^[\w-]{1,80}$/.test(input.deviceId)||!validToken(input.claimToken))fail(400,'invalid_request','Invalid laptop claim.');
    const row=await env.DB.prepare('UPDATE laptops SET owner_email=? WHERE id=? AND claim_token_hash=? AND revoked_at IS NULL AND (owner_email IS NULL OR owner_email=?) AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND email=? AND expires_at>?) RETURNING id,label').bind(s.email,input.deviceId,await sha256Hex(input.claimToken),s.email,s.id,s.email,now()).first();
    if(!row)fail(404,'device_not_found','Laptop claim is invalid or belongs to another account.');
    return json({device:{id:row.id,label:row.label,url:env.PORTAL_ORIGIN,transport:'relay'}});
  }
  const match=path.match(/^\/v1\/devices\/([\w-]{1,80})$/);
  if(match&&request.method==='DELETE') {
    const owned=await env.DB.prepare('SELECT id FROM laptops WHERE id=? AND owner_email=? AND revoked_at IS NULL').bind(match[1],s.email).first();
    if(!owned)fail(404,'device_not_found','Laptop not found.');
    if(!env.RELAY)fail(503,'relay_unavailable','Revocation is temporarily unavailable.');
    const revoked=await env.RELAY.getByName(match[1]).fetch(new Request('https://relay.internal/admin/revoke',{method:'POST',body:JSON.stringify({id:match[1]})}));
    if(!revoked.ok)fail(503,'relay_unavailable','Revocation is temporarily unavailable.');
    const row=await env.DB.prepare('UPDATE laptops SET revoked_at=? WHERE id=? AND owner_email=? AND revoked_at IS NULL RETURNING id').bind(now(),match[1],s.email).first();
    if(!row)fail(404,'device_not_found','Laptop not found.');
    return json({ok:true});
  }
  return null;
}

/** Delete cloud account records. Laptop-local phone trust is a separate authority. */
export async function deleteCloudAccount(env,email) {
  const statements=[
    env.DB.prepare('DELETE FROM push_deliveries WHERE session_id IN (SELECT id FROM sessions WHERE email=?)').bind(email),
    env.DB.prepare('DELETE FROM push_subscriptions WHERE session_id IN (SELECT id FROM sessions WHERE email=?)').bind(email),
    env.DB.prepare('DELETE FROM sessions WHERE email=?').bind(email),
    env.DB.prepare('DELETE FROM email_challenges WHERE email=?').bind(email),
    env.DB.prepare('DELETE FROM auth_requests WHERE email=?').bind(email),
    env.DB.prepare('UPDATE laptops SET owner_email=NULL WHERE owner_email=?').bind(email)
  ];
  await env.DB.batch(statements);
}

/** Public web deletion remains available even while new signups are paused. */
export async function startWebDeletion(env,email,ip) {
  if(!env.EMAIL||!env.EMAIL_FROM||typeof env.EMAIL_OTP_SECRET!=='string'||env.EMAIL_OTP_SECRET.length<32)throw Error('deletion_email_unavailable');
  const normalized=typeof email==='string'?email.trim().toLowerCase():'';
  if(normalized.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(normalized)||/[<>\r\n]/.test(normalized))return null;
  if(!await admit(env,crypto.randomUUID(),[{key:'deletion:global',limit:EMAIL_GLOBAL_DAILY,window:86400},{key:`deletion:ip:${ip}`,limit:20,window:3600},{key:`deletion:ip:daily:${ip}`,limit:EMAIL_IP_DAILY,window:86400},{key:`deletion:daily:${normalized}`,limit:10,window:86400},{key:`deletion:cooldown:${normalized}`,limit:1,window:60,cooldown:true}]))return false;
  const challengeId=random(),code=otp(),challengeHash=await sha256Hex(challengeId);
  await env.DB.prepare("INSERT INTO email_challenges(challenge_hash,email,code_hash,expires_at,purpose) VALUES (?,?,?,?,'deletion')").bind(challengeHash,normalized,await otpHash(env,challengeId,code),now()+600).run();
  try {
    await env.EMAIL.send({from:env.EMAIL_FROM,to:normalized,subject:'Confirm Herdr Remote account deletion',text:`Your Herdr Remote account deletion code is ${code}. It expires in 10 minutes. Enter it only on the Herdr Remote deletion page. If you did not request deletion, ignore this email.`});
    await env.DB.prepare('UPDATE email_challenges SET ready=1 WHERE challenge_hash=?').bind(challengeHash).run();
  } catch {
    await env.DB.prepare('DELETE FROM email_challenges WHERE challenge_hash=?').bind(challengeHash).run();
    throw Error('deletion_email_unavailable');
  }
  return challengeId;
}

export async function confirmWebDeletion(env,challengeId,code) {
  if(!validToken(challengeId)||typeof code!=='string'||!/^\d{6}$/.test(code))return false;
  const challengeHash=await sha256Hex(challengeId),codeHash=await otpHash(env,challengeId,code);
  const results=await env.DB.batch([
    env.DB.prepare("UPDATE email_challenges SET attempts=attempts+1 WHERE challenge_hash=? AND purpose='deletion' AND ready=1 AND consumed=0 AND expires_at>? AND attempts<5").bind(challengeHash,now()),
    env.DB.prepare("UPDATE email_challenges SET consumed=1 WHERE challenge_hash=? AND purpose='deletion' AND code_hash=? AND ready=1 AND consumed=0 AND expires_at>? AND attempts<=5 RETURNING email").bind(challengeHash,codeHash,now()),
    env.DB.prepare("UPDATE email_challenges SET consumed=1 WHERE challenge_hash=? AND purpose='deletion' AND attempts>=5").bind(challengeHash)
  ]);
  const email=results[1].results[0]?.email;
  if(!email)return false;
  await deleteCloudAccount(env,email);
  return true;
}
