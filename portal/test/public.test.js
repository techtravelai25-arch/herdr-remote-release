import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createPortal} from '../src/index.js';
import {lookupLaptop,handleAccountDevices} from '../src/public.js';
import {generateKeyPairSync} from 'node:crypto';
const publicKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'der'}).toString('base64url');
function setup(t) {
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 for(const f of ['0001_auth.sql','0002_push.sql','0003_public.sql','0004_admission.sql','0005_beta_controls.sql','0008_unrestricted_registration.sql'])db.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
 const stmt=(sql,args=[])=>({sql,args,bind:(...a)=>stmt(sql,a),async first(){return db.prepare(sql).get(...args)||null;},async run(){return db.prepare(sql).run(...args);},async all(){return {results:db.prepare(sql).all(...args)};}});
 const mail=[];
 const env={EDGE_SIGNUP_LIMIT:{limit:async()=>({success:true})},DB:{prepare:stmt,async batch(ss){db.exec('BEGIN');try{const result=ss.map(s=>({results:db.prepare(s.sql).all(...s.args)}));db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}},RELAY:{getByName:()=>({fetch:async()=>Response.json({ok:true})})},PORTAL_ORIGIN:'https://remote.example.com',PUBLIC_SIGNUP_ENABLED:'true',LAPTOP_REGISTRATION_ENABLED:'true',EMAIL_FROM:'signin@example.com',EMAIL_OTP_SECRET:'s'.repeat(32),EMAIL:{async send(m){mail.push(m);}},DEVICES:'[]',ALLOWED_EMAILS:'[]'};
 const app=createPortal();
 const call=(path,payload,token,method='POST')=>app.fetch(new Request(env.PORTAL_ORIGIN+path,{method,headers:{'Content-Type':'application/json','CF-Connecting-IP':'127.0.0.1',...(token?{Authorization:'Bearer '+token}:{})},...(payload===undefined?{}:{body:JSON.stringify(payload)})}),env);
 const start=async(email='owner@example.com')=>{const r=await call('/v1/auth/email/start',{email});assert.equal(r.status,200);return {...await r.json(),code:mail.at(-1).text.match(/\b\d{6}\b/)[0]};};
 const signin=async email=>{const c=await start(email);const r=await call('/v1/auth/email/verify',{challengeId:c.challengeId,code:c.code});assert.equal(r.status,200);return (await r.json()).token;};
 return {db,env,mail,call,start,signin};
}
test('public email login stores only hashes and atomically consumes code once',async t=>{
 const s=setup(t),c=await s.start(' OWNER@example.com ');
 const stored=s.db.prepare('SELECT * FROM email_challenges').get();assert.equal(stored.email,'owner@example.com');assert.notEqual(stored.code_hash,c.code);assert.notEqual(stored.challenge_hash,c.challengeId);
 const requests=await Promise.all([s.call('/v1/auth/email/verify',c),s.call('/v1/auth/email/verify',c)]);assert.deepEqual(requests.map(r=>r.status).sort(),[200,401]);
 const account=await requests.find(r=>r.status===200).json();assert.equal(account.email,'owner@example.com');
 assert.equal((await s.call('/v1/devices',undefined,account.token,'GET')).status,200);
 assert.equal((await s.call('/v1/auth/email/verify',c)).status,401);
});
test('expiry, five failures, concurrent attempts and email delivery failure fail closed',async t=>{
 const s=setup(t),c=await s.start();
 const wrong=c.code==='000000'?'111111':'000000';
 await Promise.all(Array.from({length:5},()=>s.call('/v1/auth/email/verify',{...c,code:wrong})));
 assert.equal((await s.call('/v1/auth/email/verify',c)).status,401);
 const next=await s.start('second@example.com');s.db.prepare('UPDATE email_challenges SET expires_at=0').run();
 assert.equal((await s.call('/v1/auth/email/verify',next)).status,401);
 s.env.EMAIL.send=async()=>{throw Error('credential-sensitive error');};
 const r=await s.call('/v1/auth/email/start',{email:'third@example.com'});assert.equal(r.status,503);assert.equal((await r.text()).includes('credential-sensitive'),false);
 assert.equal(s.db.prepare("SELECT count(*) n FROM email_challenges WHERE email='third@example.com'").get().n,0);
});
test('email quotas, feature gates, origins and missing secret block public auth',async t=>{
 const s=setup(t);await s.start();assert.equal((await s.call('/v1/auth/email/start',{email:'owner@example.com'})).status,429);
 s.env.PUBLIC_SIGNUP_ENABLED='false';assert.equal((await s.call('/v1/auth/email/start',{email:'new@example.com'})).status,503);
 s.env.PUBLIC_SIGNUP_ENABLED='true';s.env.EMAIL_OTP_SECRET='';assert.equal((await s.call('/v1/auth/email/start',{email:'new@example.com'})).status,503);
 s.env.LAPTOP_REGISTRATION_ENABLED='false';assert.equal((await s.call('/v1/laptops/register',{})).status,503);
});
test('oversized public auth upload rejects promptly when stream cancellation stalls',async t=>{
 const s=setup(t);
 const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(4097));},cancel(){return new Promise(()=>{});}});
 const request=new Request(s.env.PORTAL_ORIGIN+'/v1/auth/email/start',{method:'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':'127.0.0.1'},body:stream,duplex:'half'});
 const result=await Promise.race([createPortal().fetch(request,s.env),new Promise((_,reject)=>setTimeout(()=>reject(Error('oversized upload stalled')),500))]);
 assert.equal(result.status,413);
});
test('laptop claims isolate owners; QR authority cannot be granted by account login; revocation denies relay',async t=>{
 const s=setup(t),owner=await s.signin('owner@example.com'),other=await s.signin('other@example.com');
 const r=await s.call('/v1/laptops/register',{label:'Laptop',publicKey});assert.equal(r.status,200);const laptop=await r.json();
 assert.ok(await lookupLaptop(s.env,laptop.id,laptop.relayToken));assert.equal(await lookupLaptop(s.env,laptop.id,'x'.repeat(43)),null);
 const claim={deviceId:laptop.id,claimToken:laptop.claimToken};assert.equal((await s.call('/v1/devices/claim',claim,owner)).status,200);assert.equal((await s.call('/v1/devices/claim',claim,owner)).status,200);assert.equal((await s.call('/v1/devices/claim',claim,other)).status,404);
 const directory=await(await s.call('/v1/devices',undefined,owner,'GET')).json();assert.equal(directory.devices[0].transport,'relay');assert.equal(JSON.stringify(directory).includes(laptop.relayToken),false);
 assert.deepEqual((await(await s.call('/v1/devices',undefined,other,'GET')).json()).devices,[]);
 assert.equal((await s.call(`/v1/devices/${laptop.id}/grant`,{},owner)).status,409);
 assert.equal((await s.call(`/v1/devices/${laptop.id}`,undefined,other,'DELETE')).status,404);
 assert.equal((await s.call(`/v1/devices/${laptop.id}`,undefined,owner,'DELETE')).status,200);assert.equal(await lookupLaptop(s.env,laptop.id,laptop.relayToken),null);
});
test('legacy directory must explicitly map each device to its owner',async t=>{
 const s=setup(t),token=await s.signin();s.env.DEVICES=JSON.stringify([{id:'unowned',label:'Old',url:'https://old.example.com'},{id:'other',label:'Other',url:'https://other.example.com',ownerEmail:'other@example.com'},{id:'mine',label:'Mine',url:'https://mine.example.com',ownerEmail:'owner@example.com'}]);
 assert.deepEqual((await(await s.call('/v1/devices',undefined,token,'GET')).json()).devices.map(d=>d.id),['mine']);
});
test('malformed registration cannot consume shared business quotas; edge limiter runs before storage',async t=>{
 const s=setup(t);for(let i=0;i<1000;i++)assert.equal((await s.call('/v1/laptops/register',{})).status,400);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM quota_counters').get().n,0);
 assert.equal((await s.call('/v1/laptops/register',{label:'Accepted',publicKey})).status,200);
 s.env.EDGE_SIGNUP_LIMIT={limit:async()=>({success:false})};assert.equal((await s.call('/v1/auth/email/start',{email:'new@example.com'})).status,429);assert.equal(s.mail.length,0);
});
test('persistent beta cap and operator stop switch atomically gate registrations',async t=>{
 const s=setup(t);s.db.prepare('UPDATE beta_controls SET max_laptops=1').run();
 const pair=await Promise.all([s.call('/v1/laptops/register',{label:'One',publicKey}),s.call('/v1/laptops/register',{label:'Two',publicKey})]);
 assert.deepEqual(pair.map(r=>r.status).sort(),[200,503]);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM laptops WHERE revoked_at IS NULL').get().n,1);
 s.db.prepare('UPDATE beta_controls SET registration_enabled=0,max_laptops=2').run();
 const stopped=await s.call('/v1/laptops/register',{label:'Stopped',publicKey});
 assert.equal(stopped.status,503);assert.equal((await stopped.json()).error.code,'registration_closed');
 s.db.prepare('UPDATE beta_controls SET registration_enabled=1').run();
 assert.equal((await s.call('/v1/laptops/register',{label:'Resumed',publicKey})).status,200);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM laptops WHERE revoked_at IS NULL').get().n,2);
});
test('account deletion erases cloud identity and push routes without revoking laptop-local trust',async t=>{
 const s=setup(t),token=await s.signin();
 const registered=await(await s.call('/v1/laptops/register',{label:'Laptop',publicKey})).json();
 await s.call('/v1/devices/claim',{deviceId:registered.id,claimToken:registered.claimToken},token);
 const sid=s.db.prepare('SELECT id FROM sessions WHERE email=?').get('owner@example.com').id;
 s.db.prepare('INSERT INTO push_subscriptions(session_id,token,updated_at) VALUES (?,?,1)').run(sid,'push-token');
 s.db.prepare('INSERT INTO push_deliveries(device_id,event_id,session_id,claimed_at,sent) VALUES (?,?,?,1,1)').run(registered.id,'event',sid);
 s.env.PUBLIC_SIGNUP_ENABLED='false';
 const deleted=await s.call('/v1/account',undefined,token,'DELETE');
 assert.equal(deleted.status,200);assert.deepEqual(await deleted.json(),{ok:true,cloudAccountDeleted:true,localControlRevoked:false});
 assert.equal((await s.call('/v1/devices',undefined,token,'GET')).status,401);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n,0);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM push_deliveries').get().n,0);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM email_challenges').get().n,0);
 assert.equal(s.db.prepare('SELECT owner_email FROM laptops WHERE id=?').get(registered.id).owner_email,null);
 assert.ok(await lookupLaptop(s.env,registered.id,registered.relayToken));
 await assert.rejects(handleAccountDevices(new Request(s.env.PORTAL_ORIGIN+'/v1/devices/claim',{method:'POST'}),s.env,{id:sid,email:'owner@example.com'},{body:async()=>({deviceId:registered.id,claimToken:registered.claimToken}),fail:(_status,code)=>{throw Error(code);},json:Response.json}),/device_not_found/);
 assert.equal(s.db.prepare('SELECT owner_email FROM laptops WHERE id=?').get(registered.id).owner_email,null);
 assert.equal((await s.call('/v1/account',undefined,token,'DELETE')).status,401);
 for(const path of ['/privacy','/account/delete']) {
   const page=await s.call(path,undefined,null,'GET');assert.equal(page.status,200);
   assert.equal(page.headers.get('content-type'),'text/html; charset=utf-8');
   assert.match(await page.text(),/href="mailto:techtravelai25@gmail\.com"/);
 }
});
test('public web deletion requires same-origin form and single-use email code',async t=>{
 const s=setup(t),signin=await s.start('other@example.com'),token=await s.signin();
 s.env.PUBLIC_SIGNUP_ENABLED='false';
 const form=(path,fields,origin=s.env.PORTAL_ORIGIN)=>s.env.PORTAL_ORIGIN&&createPortal().fetch(new Request(s.env.PORTAL_ORIGIN+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded','CF-Connecting-IP':'127.0.0.1'},body:new URLSearchParams(fields)}),s.env);
 assert.equal((await form('/account/delete/start',{email:'owner@example.com'},'https://attacker.invalid')).status,403);
 const started=await form('/account/delete/start',{email:'owner@example.com'});assert.equal(started.status,200);
 const page=await started.text(),challenge=page.match(/name="challenge" value="([\w-]+)"/)[1];
 const code=s.mail.at(-1).text.match(/\b\d{6}\b/)[0];
 assert.equal((await form('/account/delete/confirm',{challenge:signin.challengeId,code:signin.code})).status,401);
 s.env.PUBLIC_SIGNUP_ENABLED='true';
 assert.equal((await s.call('/v1/auth/email/verify',{challengeId:challenge,code})).status,401);
 s.env.PUBLIC_SIGNUP_ENABLED='false';
 assert.equal((await form('/account/delete/confirm',{challenge,code:'000000'})).status,401);
 const done=await form('/account/delete/confirm',{challenge,code});assert.equal(done.status,200);
 assert.match(await done.text(),/Cloud account deleted/);
 assert.equal((await s.call('/v1/devices',undefined,token,'GET')).status,401);
 assert.equal((await form('/account/delete/confirm',{challenge,code})).status,401);
 const locked=await form('/account/delete/start',{email:'lock@example.com'});
 const lockedId=(await locked.text()).match(/name="challenge" value="([\w-]+)"/)[1];
 const lockedCode=s.mail.at(-1).text.match(/\b\d{6}\b/)[0];
 const wrong=lockedCode==='000000'?'111111':'000000';
 for(let i=0;i<5;i++)assert.equal((await form('/account/delete/confirm',{challenge:lockedId,code:wrong})).status,401);
 assert.equal((await form('/account/delete/confirm',{challenge:lockedId,code:lockedCode})).status,401);
});

test('unrestricted registration retains the global daily admission abuse quota',async t=>{
 const s=setup(t);s.db.prepare('UPDATE beta_controls SET registration_unrestricted=1').run();
 assert.equal((await s.call('/v1/laptops/register',{label:'First',publicKey})).status,200);
 // Both counters are normally written; saturate them to test denial before insertion.
 s.db.prepare('UPDATE quota_counters SET count=1000').run();
 const request=new Request(s.env.PORTAL_ORIGIN+'/v1/laptops/register',{method:'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.2'},body:JSON.stringify({label:'Daily quota rejected',publicKey})});
 assert.equal((await createPortal().fetch(request,s.env)).status,429);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM laptops').get().n,1);
});
