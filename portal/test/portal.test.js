import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {generateKeyPair,exportJWK,SignJWT,createLocalJWKSet,jwtVerify} from 'jose';
import {createPortal,signGrant,verifyAccess} from '../src/index.js';
import {createAuthenticator} from '../../bridge/src/auth.js';

let privateKey, accessPrivate, accessJwks, grantJwk;
before(async()=>{
 ({privateKey}=await generateKeyPair('EdDSA',{extractable:true}));grantJwk={...await exportJWK(privateKey),kid:'test-grant'};
 const pair=await generateKeyPair('RS256',{extractable:true});accessPrivate=pair.privateKey;accessJwks=createLocalJWKSet({keys:[{...await exportJWK(pair.publicKey),kid:'test-access'}]});
});
function database(){
 const sqlite=new DatabaseSync(':memory:');
 for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const statement=(sql,args=[])=>({bind:(...values)=>statement(sql,values),async first(){return sqlite.prepare(sql).get(...args)||null;},async run(){return sqlite.prepare(sql).run(...args);},async all(){return {results:sqlite.prepare(sql).all(...args)};},sql,args});
 return {prepare:statement,async batch(statements){sqlite.exec('BEGIN');try{const result=statements.map(s=>({results:sqlite.prepare(s.sql).all(...s.args)}));sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}},close:()=>sqlite.close(),sqlite};
}
async function setup(origin='https://remote.example.com'){
  const DB=database();
 const env={DB,PORTAL_ORIGIN:origin,PUBLIC_APK_URL:'/v1/app-update/apk',ACCESS_TEAM_DOMAIN:'test.cloudflareaccess.com',ACCESS_AUD:'aud',ALLOWED_EMAILS:'["owner@example.com"]',DEVICES:'[{"id":"laptop","ownerEmail":"owner@example.com","label":"Laptop","url":"https://laptop.example.com"}]',GRANT_SIGNING_JWK:JSON.stringify(grantJwk)};
 const app=createPortal({accessVerifier:(r,e)=>verifyAccess(r,e,accessJwks)});
 const access=await new SignJWT({email:'owner@example.com'}).setProtectedHeader({alg:'RS256',kid:'test-access'}).setIssuer('https://test.cloudflareaccess.com').setAudience('aud').setSubject('user').setIssuedAt().setExpirationTime('5m').sign(accessPrivate);
 const call=(path,method='GET',payload,headers={})=>app.fetch(new Request(env.PORTAL_ORIGIN+path,{method,headers:{...(payload===undefined?{}:{'Content-Type':'application/json'}),...headers},...(payload===undefined?{}:{body:typeof payload==='string'?payload:JSON.stringify(payload)})}),env);
 const start=async()=>{const r=await call('/v1/auth/start','POST',{});assert.equal(r.status,200);return r.json();};
 const approve=async login=>{const page=await call(new URL(login.verificationUrl).pathname+new URL(login.verificationUrl).search,'GET',undefined,{'Cf-Access-Jwt-Assertion':access});assert.equal(page.status,200);const csrf=(await page.text()).match(/name="csrf" value="([^"]+)"/)[1];const cookie=page.headers.get('set-cookie').split(';')[0];const result=await call('/login/approve?code='+login.userCode,'POST',new URLSearchParams({csrf}).toString(),{'Cf-Access-Jwt-Assertion':access,Origin:env.PORTAL_ORIGIN,Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'});assert.equal(result.status,200);};
 return {DB,env,call,start,approve,access};
}
test('full email approval, single exchange, directory and restricted signed grant',async()=>{
 const s=await setup();try{
 const login=await s.start();assert.equal(login.interval,3);assert.equal((await s.call('/v1/auth/poll','POST',{deviceCode:login.deviceCode})).status,202);
 await s.approve(login);
 const responses=await Promise.all([s.call('/v1/auth/poll','POST',{deviceCode:login.deviceCode}),s.call('/v1/auth/poll','POST',{deviceCode:login.deviceCode})]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,410]);
 const account=await responses.find(r=>r.status===200).json();const headers={Authorization:'Bearer '+account.token};
 assert.equal(account.email,'owner@example.com');assert.ok(account.expiresAt>Date.now()/1000);
 const devices=await (await s.call('/v1/devices','GET',undefined,headers)).json();assert.equal(devices.devices[0].id,'laptop');
 const grant=await (await s.call('/v1/devices/laptop/grant','POST',{},headers)).json();
 const jwks=await(await s.call('/.well-known/jwks.json')).json();assert.equal(jwks.keys[0].d,undefined);
 const {payload,protectedHeader}=await jwtVerify(grant.token,createLocalJWKSet(jwks),{issuer:s.env.PORTAL_ORIGIN,audience:'laptop'});assert.equal(protectedHeader.typ,'herdr-grant+jwt');assert.equal(payload.sub,account.email);assert.equal(payload.exp-payload.iat,300);assert.match(payload.sid,/^[\w-]{16,128}$/);
 assert.equal((await s.call('/v1/devices/unknown/grant','POST',{},headers)).status,404);
 const stored=s.DB.sqlite.prepare('SELECT * FROM sessions').get();assert.notEqual(stored.token_hash,account.token);assert.equal(Object.values(stored).includes(account.token),false);
 assert.equal((await s.call('/v1/auth/session','DELETE',undefined,headers)).status,200);assert.equal((await s.call('/v1/devices','GET',undefined,headers)).status,401);
 }finally{s.DB.close();}
});
test('canonical sign-in issues direct grants accepted by existing pinned-issuer bridges',async()=>{
 const s=await setup();try{
  s.env.GRANT_ISSUER='https://legacy.example.com';
  const login=await s.start();
  assert.equal(new URL(login.verificationUrl).origin,s.env.PORTAL_ORIGIN);
  await s.approve(login);
  const account=await(await s.call('/v1/auth/poll','POST',{deviceCode:login.deviceCode})).json();
  const response=await s.call('/v1/devices/laptop/grant','POST',{}, {Authorization:'Bearer '+account.token});
  assert.equal(response.status,200);
  const grant=await response.json();
  const jwks=await(await s.call('/.well-known/jwks.json')).json();
  const {payload}=await jwtVerify(grant.token,createLocalJWKSet(jwks),{issuer:s.env.GRANT_ISSUER,audience:'laptop'});
  assert.equal(payload.sub,account.email);
  await assert.rejects(jwtVerify(grant.token,createLocalJWKSet(jwks),{issuer:s.env.PORTAL_ORIGIN,audience:'laptop'}));
  const authenticate=createAuthenticator({authenticate:()=>null},{issuer:s.env.GRANT_ISSUER,audience:'laptop',jwks});
  assert.deepEqual(await authenticate(grant.token),{deviceId:`account:${payload.sid}`,deviceName:account.email,email:account.email});
  const wrongIssuer=await new SignJWT({sid:payload.sid}).setProtectedHeader({alg:'EdDSA',typ:'herdr-grant+jwt',kid:grantJwk.kid}).setIssuer(s.env.PORTAL_ORIGIN).setAudience('laptop').setSubject(account.email).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  assert.equal(await authenticate(wrongIssuer),null);
 }finally{s.DB.close();}
});
test('legacy portal origin remains the default direct grant issuer',async()=>{
 const s=await setup('https://legacy.example.com');try{
  const login=await s.start();await s.approve(login);
  const account=await(await s.call('/v1/auth/poll','POST',{deviceCode:login.deviceCode})).json();
  const grant=await(await s.call('/v1/devices/laptop/grant','POST',{}, {Authorization:'Bearer '+account.token})).json();
  const jwks=await(await s.call('/.well-known/jwks.json')).json();
  assert.equal((await jwtVerify(grant.token,createLocalJWKSet(jwks),{issuer:s.env.PORTAL_ORIGIN,audience:'laptop'})).payload.sub,account.email);
 }finally{s.DB.close();}
});
test('an explicit direct grant issuer must be a bare HTTPS origin',async()=>{
 const env={GRANT_SIGNING_JWK:JSON.stringify(grantJwk),PORTAL_ORIGIN:'https://remote.example.com'};
 const session={id:'session_1234567890123456',email:'owner@example.com'};
 const device={id:'laptop',url:'https://laptop.example.com'};
 for(const issuer of ['', 'http://legacy.example.com','https://legacy.example.com/path','https://legacy.example.com:8443','https://user@legacy.example.com','https://legacy.example.com?x=1']){
  await assert.rejects(signGrant({...env,GRANT_ISSUER:issuer},session,device),/Invalid grant issuer/,issuer);
 }
});
test('denies spoofed Access identity, cross-origin approval, and unapproved polling',async()=>{
 const s=await setup();try{
 const login=await s.start();const path='/login?code='+login.userCode;
 assert.equal((await s.call(path)).status,401);
 assert.equal((await s.call(path,'GET',undefined,{'Cf-Access-Jwt-Assertion':'forged','Cf-Access-Authenticated-User-Email':'owner@example.com'})).status,401);
 assert.equal((await s.call('/login/approve?code='+login.userCode,'POST','csrf=oops',{'Cf-Access-Jwt-Assertion':s.access,Origin:'https://attacker.example'})).status,403);
 assert.equal((await s.call('/v1/auth/poll','POST',{deviceCode:login.deviceCode})).status,202);
 assert.equal((await s.call('/v1/auth/start','POST',{}, {Origin:s.env.PORTAL_ORIGIN})).status,403);
 }finally{s.DB.close();}
});
test('JSON content type matching accepts parameters and rejects prefix lookalikes',async()=>{
 const s=await setup();try{
  const valid=await s.call('/v1/auth/start','POST','{}',{'Content-Type':'application/json; charset=utf-8'});
  assert.equal(valid.status,200);
  const invalid=await s.call('/v1/auth/start','POST','{}',{'Content-Type':'application/jsonx'});
  assert.equal(invalid.status,415);
 }finally{s.DB.close();}
});
test('expired login cannot approve or exchange, and missing setup fails closed',async()=>{
 const s=await setup();try{const login=await s.start();s.DB.sqlite.prepare('UPDATE auth_requests SET expires_at=0').run();assert.equal((await s.call('/v1/auth/poll','POST',{deviceCode:login.deviceCode})).status,410);assert.equal((await s.call('/login?code='+login.userCode,'GET',undefined,{'Cf-Access-Jwt-Assertion':s.access})).status,410);s.env.ALLOWED_EMAILS='[]';assert.equal((await s.call('/v1/auth/start','POST',{})).status,503);}finally{s.DB.close();}
});
test('removing an email blocks existing account sessions immediately',async()=>{
 const s=await setup();try{const login=await s.start();await s.approve(login);const account=await(await s.call('/v1/auth/poll','POST',{deviceCode:login.deviceCode})).json();s.env.ALLOWED_EMAILS='["someone-else@example.com"]';assert.equal((await s.call('/v1/devices','GET',undefined,{Authorization:'Bearer '+account.token})).status,403);}finally{s.DB.close();}
});
test('Access tokens with another audience and forged same-origin CSRF cannot approve',async()=>{
 const s=await setup();try{
 const login=await s.start();const wrongAudience=await new SignJWT({email:'owner@example.com'}).setProtectedHeader({alg:'RS256',kid:'test-access'}).setIssuer('https://test.cloudflareaccess.com').setAudience('other').setSubject('user').setIssuedAt().setExpirationTime('5m').sign(accessPrivate);
 assert.equal((await s.call('/login?code='+login.userCode,'GET',undefined,{'Cf-Access-Jwt-Assertion':wrongAudience})).status,401);
 await s.call('/login?code='+login.userCode,'GET',undefined,{'Cf-Access-Jwt-Assertion':s.access});
 assert.equal((await s.call('/login/approve?code='+login.userCode,'POST','csrf=wrong',{'Cf-Access-Jwt-Assertion':s.access,Origin:s.env.PORTAL_ORIGIN,Cookie:'__Host-herdr-csrf=wrong','Content-Type':'application/x-www-form-urlencoded'})).status,403);
 assert.equal((await s.call('/v1/auth/poll','POST',{deviceCode:login.deviceCode})).status,202);
 }finally{s.DB.close();}
});
test('valid signatures cannot authorize disallowed email or incorrect issuer',async()=>{
 const s=await setup();try{const login=await s.start();for(const [email,issuer,status] of [['intruder@example.com','https://test.cloudflareaccess.com',403],['owner@example.com','https://other.cloudflareaccess.com',401]]){const token=await new SignJWT({email}).setProtectedHeader({alg:'RS256',kid:'test-access'}).setIssuer(issuer).setAudience('aud').setSubject('user').setIssuedAt().setExpirationTime('5m').sign(accessPrivate);assert.equal((await s.call('/login?code='+login.userCode,'GET',undefined,{'Cf-Access-Jwt-Assertion':token})).status,status);}}finally{s.DB.close();}
});
test('random device codes cannot create per-code rate rows; valid polling is bounded',async()=>{
 const s=await setup();try{
 for(let i=0;i<5;i++)assert.equal((await s.call('/v1/auth/poll','POST',{deviceCode:('x'.repeat(42)+i)})).status,410);
 assert.equal(s.DB.sqlite.prepare('SELECT count(*) AS n FROM rate_limits').get().n,1);
 const login=await s.start();for(let i=0;i<30;i++)assert.equal((await s.call('/v1/auth/poll','POST',{deviceCode:login.deviceCode})).status,202);
 assert.equal((await s.call('/v1/auth/poll','POST',{deviceCode:login.deviceCode})).status,429);
 }finally{s.DB.close();}
});
test('public updates work while signed out and Access disabled, stream bytes without forwarding credentials',async()=>{
 const s=await setup();try{
 s.env.ACCESS_TEAM_DOMAIN='';s.env.ACCESS_AUD='';s.env.GRANT_SIGNING_JWK='';s.env.ALLOWED_EMAILS='[]';
 const calls=[];let assetBody;
 s.env.ASSETS={fetch:async request=>{calls.push(request);const apk=new URL(request.url).pathname.endsWith('.apk');const data=apk?'signed-apk-bytes':JSON.stringify({versionCode:12,versionName:'0.2.10',size:16,sha256:'a'.repeat(64),apkPath:'/v1/app-update/apk'});const response=new Response(request.method==='HEAD'?null:data,{headers:{'Content-Length':String(data.length),'Cache-Control':'public,max-age=31536000'}});assetBody=response.body;return response;}};
 const metadata=await s.call('/v1/app-update','GET',undefined,{Origin:s.env.PORTAL_ORIGIN});assert.equal(metadata.status,200);assert.equal((await metadata.json()).apkPath,'/v1/app-update/apk');
 const apk=await s.call('/v1/app-update/apk','GET',undefined,{Authorization:'Bearer should-not-be-forwarded',Cookie:'private=value',Range:'bytes=0-4','If-None-Match':'old'});assert.equal(apk.status,200);assert.equal(apk.body,assetBody);assert.equal(apk.headers.get('content-type'),'application/vnd.android.package-archive');assert.equal(apk.headers.get('cache-control'),'no-store');assert.match(apk.headers.get('content-disposition'),/herdr-remote.apk/);assert.equal(await apk.text(),'signed-apk-bytes');
 const internal=calls.at(-1);assert.equal(new URL(internal.url).pathname,'/herdr-remote.apk');assert.deepEqual([...internal.headers],[]);
 const head=await s.call('/v1/app-update/apk','HEAD');assert.equal(head.status,200);assert.equal(await head.text(),'');assert.equal(head.headers.get('content-length'),'16');assert.equal(calls.at(-1).method,'HEAD');
 assert.equal(s.DB.sqlite.prepare('SELECT SUM(download_count) AS n FROM android_download_daily').get().n,1);
 assert.equal((await s.call('/v1/devices')).status,401);assert.equal((await s.call('/v1/auth/start','POST',{})).status,503);
 for(const path of ['/','/download']){const landing=await s.call(path);assert.equal(landing.status,200);assert.match(await landing.text(),/href="\/v1\/app-update\/apk"/);}
 }finally{s.DB.close();}
});

test('removed internal routes expose no page, data or settings even with valid sign-in',async()=>{
 const s=await setup();try{
  const before=s.DB.sqlite.prepare('SELECT * FROM beta_controls').get();
  for(const path of ['/operator','/login/operator','/login/operator/overview','/login/operator/settings']){
   for(const method of ['GET','POST']){
    const response=await s.call(path,method,method==='POST'?{registrationEnabled:false,maxLaptops:1}:undefined,{'Cf-Access-Jwt-Assertion':s.access});
    assert.equal(response.status,404);
    assert.equal((await response.json()).error.code,'not_found');
    const browser=await s.call(path,method,method==='POST'?{registrationEnabled:false,maxLaptops:1}:undefined,{'Cf-Access-Jwt-Assertion':s.access,Origin:s.env.PORTAL_ORIGIN});
    assert.equal(browser.status,404);
   }
  }
  assert.deepEqual(s.DB.sqlite.prepare('SELECT * FROM beta_controls').get(),before);
 }finally{s.DB.close();}
});
test('release assets have no catch-all route, path traversal, queries, or mutable API',async()=>{
 const s=await setup();try{const calls=[];s.env.ASSETS={fetch:async r=>{calls.push(r);return new Response('asset');}};
 for(const path of ['/herdr-remote.apk','/app-update.json','/v1/app-update/anything','/v1/app-update/%2f..%2fsecret','/v1/app-update/apk%2f..%2fsecret']){const response=await s.call(path);assert.notEqual(response.status,200);}
 assert.equal((await s.call('/v1/app-update?file=secret')).status,400);assert.equal((await s.call('/v1/app-update/apk','POST',{})).status,405);assert.equal(calls.length,0);
 s.env.ASSETS={fetch:async()=>new Response('missing',{status:404})};assert.equal((await s.call('/v1/app-update')).status,503);
 delete s.env.ASSETS;assert.equal((await s.call('/v1/app-update/apk')).status,503);
 }finally{s.DB.close();}
});
test('approval document preserves native form Origin while null-origin and missing-cookie posts remain blocked',async()=>{
 const s=await setup();try{
 const login=await s.start();const page=await s.call('/login?code='+login.userCode,'GET',undefined,{'Cf-Access-Jwt-Assertion':s.access});
 // HTML form POST (unlike default fetch POST) sends Origin:null under no-referrer.
 // Keep same-origin policy on this document without loosening server CSRF checks.
 assert.equal(page.headers.get('referrer-policy'),'same-origin');
 assert.match(page.headers.get('set-cookie'),/Secure; HttpOnly; SameSite=Strict/);
 const csrf=(await page.text()).match(/name="csrf" value="([^"]+)"/)[1];const cookie=page.headers.get('set-cookie').split(';')[0];
 const data=new URLSearchParams({csrf}).toString();const auth={'Cf-Access-Jwt-Assertion':s.access,'Content-Type':'application/x-www-form-urlencoded'};
 for(const origin of ['null','https://attacker.example'])assert.equal((await s.call('/login/approve?code='+login.userCode,'POST',data,{...auth,Origin:origin,Cookie:cookie})).status,403);
 assert.equal((await s.call('/login/approve?code='+login.userCode,'POST',data,{...auth,Origin:s.env.PORTAL_ORIGIN})).status,403);
 assert.equal((await s.call('/v1/auth/poll','POST',{deviceCode:login.deviceCode})).status,202);
 assert.equal((await s.call('/login/approve?code='+login.userCode,'POST',data,{...auth,Origin:s.env.PORTAL_ORIGIN,Cookie:cookie})).status,200);
 assert.equal((await s.call('/v1/auth/poll','POST',{deviceCode:login.deviceCode})).status,200);
 assert.equal((await s.call('/v1/devices')).headers.get('referrer-policy'),'no-referrer');
 }finally{s.DB.close();}
});
test('a handful of IPs cannot lock out device sign-in; per-IP rejections never charge global start budget',async()=>{
 const s=await setup();try{
 const start=ip=>s.call('/v1/auth/start','POST',{},{'CF-Connecting-IP':ip});
 // Eight addresses exceed the old shared cap of 60 starts per ten minutes.
 for(let ip=1;ip<=8;ip++){for(let i=0;i<10;i++)assert.equal((await start('198.51.100.'+ip)).status,200);for(let i=0;i<5;i++)assert.equal((await start('198.51.100.'+ip)).status,429);}
 assert.equal((await start('203.0.113.9')).status,200);
 s.env.EDGE_SIGNUP_LIMIT={limit:async()=>({success:false})};const before=s.DB.sqlite.prepare('SELECT SUM(count) AS n FROM rate_limits').get().n;
 assert.equal((await start('203.0.113.10')).status,429);
 assert.equal(s.DB.sqlite.prepare('SELECT SUM(count) AS n FROM rate_limits').get().n,before);
 }finally{s.DB.close();}
});
test('random device codes never charge the global poll budget; edge rejection precedes D1',async()=>{
 const s=await setup();try{
 s.env.EDGE_SIGNUP_LIMIT={limit:async()=>({success:true})};
 for(let i=0;i<20;i++)assert.equal((await s.call('/v1/auth/poll','POST',{deviceCode:('y'.repeat(42)+(i%10))})).status,410);
 assert.equal(s.DB.sqlite.prepare('SELECT count(*) AS n FROM rate_limits').get().n,0);
 const login=await s.start();const rows=s.DB.sqlite.prepare('SELECT count(*) AS n FROM rate_limits').get().n;
 assert.equal((await s.call('/v1/auth/poll','POST',{deviceCode:login.deviceCode})).status,202);
 // A live code charges its own counter and then the shared circuit-breaker.
 assert.equal(s.DB.sqlite.prepare('SELECT count(*) AS n FROM rate_limits').get().n,rows+2);
 s.env.EDGE_SIGNUP_LIMIT={limit:async()=>({success:false})};const prepare=s.DB.prepare;s.DB.prepare=()=>{throw Error('Must not touch D1');};
 try{assert.equal((await s.call('/v1/auth/poll','POST',{deviceCode:login.deviceCode})).status,429);}finally{s.DB.prepare=prepare;}
 }finally{s.DB.close();}
});
test('unexpected failures log only error class and an identifier-free route; non-sign-in routes stay neutral',async t=>{
 const s=await setup();try{
 const logs=[];const original=console.error;console.error=(...args)=>logs.push(args);t.after(()=>{console.error=original;});
 const id='0b0c6c1e-2f43-4a8e-9a55-5d3f1b1b0a11';
 s.env.EDGE_RELAY_LIMIT={limit:async()=>({success:true})};s.env.RELAY={getByName(){throw new TypeError('secret-bearing detail');}};
 const relay=await s.call(`/v1/relay/${id}/rpc`,'POST',{},{Authorization:'Bearer '+'z'.repeat(43)});
 assert.equal(relay.status,503);const relayBody=await relay.text();assert.doesNotMatch(relayBody,/Sign-in|secret-bearing/);
 const prepare=s.DB.prepare;s.DB.prepare=()=>{throw new RangeError('owner@example.com credential');};
 try{const start=await s.call('/v1/auth/start','POST',{});assert.equal(start.status,503);assert.match(await start.text(),/Sign-in is temporarily unavailable/);}finally{s.DB.prepare=prepare;}
 assert.deepEqual(logs,[['portal_request_failed','/v1/relay/:id/rpc','TypeError'],['portal_request_failed','/v1/auth/start','RangeError']]);
 assert.doesNotMatch(JSON.stringify(logs),new RegExp(`${id}|owner@|credential|secret|zzzz`));
 }finally{s.DB.close();}
});
