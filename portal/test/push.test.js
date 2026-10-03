import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createPortal} from '../src/index.js';
import {sendFCM,handlePush} from '../src/push.js';
import {generateKeyPair,exportPKCS8} from 'jose';

const hash=value=>createHash('sha256').update(value).digest('hex');
const bridgeToken='b'.repeat(43), phoneToken='f'.repeat(40);
function setup(t,sender=async()=>({invalidToken:false})) {
  const sqlite=new DatabaseSync(':memory:'); t.after(()=>sqlite.close());
  for(const name of ['0001_auth.sql','0002_push.sql','0003_public.sql','0004_admission.sql'])sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const statement=(sql,args=[])=>({sql,args,bind:(...values)=>statement(sql,values),async first(){return sqlite.prepare(sql).get(...args)||null;},async run(){return sqlite.prepare(sql).run(...args);},async all(){return {results:sqlite.prepare(sql).all(...args)};}});
  const DB={prepare:statement,async batch(statements){sqlite.exec('BEGIN');try{const result=statements.map(s=>({results:sqlite.prepare(s.sql).all(...s.args)}));sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  const env={DB,PORTAL_ORIGIN:'https://remote.example.com',ACCESS_TEAM_DOMAIN:'test.cloudflareaccess.com',ACCESS_AUD:'test',GRANT_SIGNING_JWK:'{}',ALLOWED_EMAILS:'["owner@example.com"]',DEVICES:'[{"id":"laptop","ownerEmail":"owner@example.com","label":"Laptop","url":"https://laptop.example.com"}]',FIREBASE_ANDROID_CONFIG:JSON.stringify({projectId:'test-project',applicationId:'1:123:android:abcdef',senderId:'123',apiKey:'AIza'+'a'.repeat(25)}),FIREBASE_SERVICE_ACCOUNT:'private-test-material',PUSH_BRIDGE_TOKEN_HASHES:JSON.stringify({laptop:hash(bridgeToken)})};
  const app=createPortal({pushSender:sender});
  const call=(path,method='GET',payload,token='account',extra={})=>app.fetch(new Request(env.PORTAL_ORIGIN+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(payload===undefined?{}:{'Content-Type':'application/json'}),...extra},...(payload===undefined?{}:{body:JSON.stringify(payload)})}),env);
  const add=(token,id,email='owner@example.com',expiry=Math.floor(Date.now()/1000)+3600)=>sqlite.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(hash(token),id,id,email,expiry);
  add('account','session-one');
  const event=(id='event-one',overrides={})=>call('/v1/push/events','POST',{eventId:id,paneId:'w1:p1',kind:'done',createdAt:Math.floor(Date.now()/1000),...overrides},bridgeToken);
  const register=(token=phoneToken,account='account')=>call('/v1/push/subscription','PUT',{token},account);
  return {sqlite,env,call,add,event,register};
}
test('push routes enforce account/bridge auth and native origin/query guards',async t=>{
  const s=setup(t);
  assert.equal((await s.call('/v1/push/config','GET',undefined,null)).status,401);
  assert.equal((await s.call('/v1/push/config','GET',undefined,bridgeToken)).status,401);
  assert.equal((await s.call('/v1/push/events','POST',{},'account')).status,401);
  for(const path of ['/v1/push/config','/v1/push/events']) {
    const method=path.endsWith('events')?'POST':'GET', body=method==='POST'?{}:undefined;
    assert.equal((await s.call(path,method,body,bridgeToken,{Origin:s.env.PORTAL_ORIGIN})).status,403);
    assert.equal((await s.call(path+'?x=1',method,body,bridgeToken)).status,400);
  }
  const c=await(await s.call('/v1/push/config')).json();assert.equal(c.available,true);assert.equal(JSON.stringify(c).includes('private-test-material'),false);
});
test('token registration moves between sessions, replaces old token, and supports deletion',async t=>{
  const s=setup(t);s.add('second','session-two');
  assert.equal((await s.register()).status,200);assert.equal((await s.register(phoneToken,'second')).status,200);
  assert.deepEqual(s.sqlite.prepare('SELECT session_id,token FROM push_subscriptions').all().map(r=>({...r})),[{session_id:'session-two',token:phoneToken}]);
  assert.equal((await s.register('g'.repeat(40),'second')).status,200);
  assert.equal(s.sqlite.prepare('SELECT token FROM push_subscriptions').get().token,'g'.repeat(40));
  assert.equal((await s.call('/v1/push/subscription','DELETE',undefined,'second')).status,200);
  assert.equal(s.sqlite.prepare('SELECT count(*) AS n FROM push_subscriptions').get().n,0);
});
test('a push registration authenticated before account deletion cannot restore its token afterward',async t=>{
  const s=setup(t);s.sqlite.prepare('DELETE FROM sessions WHERE id=?').run('session-one');
  await assert.rejects(handlePush(new Request(s.env.PORTAL_ORIGIN+'/v1/push/subscription',{method:'PUT'}),s.env,{body:async()=>({token:phoneToken}),session:async()=>({id:'session-one',email:'owner@example.com'}),rate:async()=>{},registry:()=>[],allowed:()=>true,fail:(_status,code)=>{throw Error(code);},json:Response.json}),/unauthorized/);
  assert.equal(s.sqlite.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n,0);
});
test('revoked, expired and disallowed sessions never receive push',async t=>{
  let sent=0;const s=setup(t,async()=>{sent++;return {invalidToken:false};});await s.register();
  s.env.ALLOWED_EMAILS='["other@example.com"]';assert.equal((await s.event()).status,200);assert.equal(sent,0);assert.equal((await s.register()).status,403);
  s.env.ALLOWED_EMAILS='["owner@example.com"]';s.sqlite.prepare('UPDATE sessions SET expires_at=0').run();assert.equal((await s.event('expired')).status,200);assert.equal(sent,0);assert.equal((await s.register()).status,401);
  s.add('second','session-two');await s.register(phoneToken,'second');await s.call('/v1/auth/session','DELETE',undefined,'second');assert.equal((await s.event('revoked')).status,200);assert.equal(sent,0);
});
test('delivery deduplicates per event and session, retries only failed recipients, and removes invalid tokens',async t=>{
  const calls=[];let rejectSecond=true;const s=setup(t,async(_env,token,event)=>{calls.push({token,event});if(token.startsWith('g')&&rejectSecond)throw Error('offline');return {invalidToken:token.startsWith('g')};});
  await s.register();s.add('second','session-two');await s.register('g'.repeat(40),'second');
  assert.equal((await s.event()).status,503);assert.equal(calls.length,2);rejectSecond=false;
  assert.equal((await s.event()).status,200);assert.equal(calls.length,3);assert.equal(calls.filter(x=>x.token===phoneToken).length,1);
  assert.equal((await s.event()).status,200);assert.equal(calls.length,3);
  assert.deepEqual(Object.keys(calls[0].event).sort(),['deviceId','eventId','kind','paneId']);
  assert.equal(s.sqlite.prepare('SELECT count(*) AS n FROM push_subscriptions').get().n,1);
});
test('event validation rejects content, forged device IDs, old events and malformed pane IDs',async t=>{
  let sent=0;const s=setup(t,async()=>{sent++;return {invalidToken:false};});await s.register();
  for(const override of [{text:'private terminal content'},{deviceId:'other'},{createdAt:1},{paneId:'bad\n'},{kind:'working'}])assert.equal((await s.event('bad',override)).status,400);
  assert.equal(sent,0);
});
test('clear events retain the target completion and authenticated laptop scope, with idempotent delivery',async t=>{
  const sent=[];const s=setup(t,async(_env,token,event)=>{sent.push({token,event});return {invalidToken:false};});
  await s.register();
  s.env.PUBLIC_SIGNUP_ENABLED='true';s.add('other','other-session','other@example.com');
  await s.register('o'.repeat(40),'other');
  assert.equal((await s.event('clear-one',{kind:'clear',targetEventId:'completion-one'})).status,200);
  assert.equal((await s.event('clear-one',{kind:'clear',targetEventId:'completion-one'})).status,200);
  assert.deepEqual(sent,[{token:phoneToken,event:{eventId:'clear-one',deviceId:'laptop',paneId:'w1:p1',kind:'clear',targetEventId:'completion-one'}}]);
});
test('clear validation rejects missing, malformed, self-targeting and extraneous fields',async t=>{
  let sent=0;const s=setup(t,async()=>{sent++;return {invalidToken:false};});await s.register();
  for(const override of [
    {kind:'clear'}, {kind:'clear',targetEventId:''}, {kind:'clear',targetEventId:'bad\n'},
    {kind:'clear',targetEventId:'x'.repeat(81)}, {kind:'clear',targetEventId:'bad'},
    {kind:'clear',targetEventId:'completion',deviceId:'forged'},
    {kind:'clear',targetEventId:'completion',text:'private'},
    {kind:'done',targetEventId:'completion'},
  ])assert.equal((await s.event('bad',override)).status,400);
  assert.equal(sent,0);
});
test('concurrent delivery claim prevents a second sender until first completes',async t=>{
  let release,started;const entered=new Promise(r=>{started=r;});let calls=0;
  const s=setup(t,async()=>{calls++;started();await new Promise(r=>{release=r;});return {invalidToken:false};});await s.register();
  const first=s.event();await entered;assert.equal((await s.event()).status,503);assert.equal(calls,1);release();assert.equal((await first).status,200);assert.equal((await s.event()).status,200);
});
test('FCM sends opaque completion and clear payloads through fixed endpoints and rejects redirects',async t=>{
  const s=setup(t);const {privateKey}=await generateKeyPair('RS256',{extractable:true});
  s.env.FIREBASE_SERVICE_ACCOUNT=JSON.stringify({project_id:'test-project',client_email:'test@test-project.iam.gserviceaccount.com',private_key:await exportPKCS8(privateKey)});
  const calls=[];const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;});
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return Response.json(url.includes('oauth2.googleapis.com')?{access_token:'test-oauth-token'}:{name:'sent'});};
  assert.deepEqual(await sendFCM(s.env,phoneToken,{eventId:'event',deviceId:'laptop',paneId:'pane',kind:'done',text:'private terminal output'}),{invalidToken:false});
  await sendFCM(s.env,phoneToken,{eventId:'clear',deviceId:'laptop',paneId:'pane',kind:'clear',targetEventId:'completion',text:'private'});
  assert.deepEqual(calls.map(c=>c.url),['https://oauth2.googleapis.com/token','https://fcm.googleapis.com/v1/projects/test-project/messages:send','https://oauth2.googleapis.com/token','https://fcm.googleapis.com/v1/projects/test-project/messages:send']);
  assert.ok(calls.every(c=>c.options.redirect==='manual'));
  const event={eventId:'event',deviceId:'laptop',paneId:'pane',kind:'done'};
  let attempts=0;
  globalThis.fetch=async()=>{attempts++;return new Response(null,{status:302,headers:{Location:'https://untrusted.example'}});};
  await assert.rejects(sendFCM(s.env,phoneToken,event),/push_authentication/);
  assert.equal(attempts,1);
  attempts=0;
  globalThis.fetch=async()=>++attempts===1?Response.json({access_token:'test-token'}):new Response(null,{status:307,headers:{Location:'https://untrusted.example'}});
  await assert.rejects(sendFCM(s.env,phoneToken,event),/push_delivery/);
  assert.equal(attempts,2);
  const message=JSON.parse(calls[1].options.body).message;
  assert.deepEqual(message.data,{eventId:'event',deviceId:'laptop',paneId:'pane',kind:'done'});
  assert.deepEqual(Object.keys(message).sort(),['android','data','token']);assert.equal(JSON.stringify(message).includes('private terminal'),false);
  const clear=JSON.parse(calls[3].options.body).message;
  assert.deepEqual(clear.data,{eventId:'clear',deviceId:'laptop',paneId:'pane',kind:'clear',targetEventId:'completion'});
  assert.deepEqual(Object.keys(clear).sort(),['android','data','token']);
  assert.equal(clear.android.ttl,'86400s');assert.equal(clear.android.priority,'NORMAL');
});
test('public accounts cannot receive another owner’s laptop notifications',async t=>{
 const delivered=[];const s=setup(t,async(_env,token)=>{delivered.push(token);return {invalidToken:false};});
 s.env.PUBLIC_SIGNUP_ENABLED='true';s.add('other-account','other-session','other@example.com');
 await s.register();await s.register('o'.repeat(40),'other-account');
 assert.equal((await s.event()).status,200);assert.deepEqual(delivered,[phoneToken]);
 s.env.DEVICES=JSON.stringify([{id:'laptop',label:'Laptop',url:'https://laptop.example.com'}]);
 assert.equal((await s.event('unowned')).status,200);assert.deepEqual(delivered,[phoneToken]);
});
test('claimed relay laptop delivers only to its current owner without legacy hash config',async t=>{
 const delivered=[];const s=setup(t,async(_env,token,event)=>{delivered.push({token,event});return {invalidToken:false};});
 s.env.DEVICES='[]';delete s.env.PUSH_BRIDGE_TOKEN_HASHES;s.env.PUBLIC_SIGNUP_ENABLED='true';
 const laptopId='dynamic-laptop',relayToken='d'.repeat(43);
 s.sqlite.prepare('INSERT INTO laptops(id,label,relay_token_hash,claim_token_hash,public_key,created_at,owner_email) VALUES (?,?,?,?,?,?,?)').run(laptopId,'Dynamic',hash(relayToken),hash('claim'),'public',1,'owner@example.com');
 s.sqlite.prepare('INSERT INTO laptops(id,label,relay_token_hash,claim_token_hash,public_key,created_at) VALUES (?,?,?,?,?,?)').run('unclaimed','Unclaimed',hash('u'.repeat(43)),hash('claim'),'public',1);
 s.add('other-account','other-session','other@example.com');
 assert.equal((await s.register()).status,200);assert.equal((await s.register('o'.repeat(40),'other-account')).status,200);
 assert.deepEqual(await(await s.call('/v1/push/config')).json(),{available:true,projectId:'test-project',applicationId:'1:123:android:abcdef',senderId:'123',apiKey:'AIza'+'a'.repeat(25)});
 const send=(id,token,eventId)=>s.call('/v1/push/events','POST',{eventId,paneId:'w1:p1',kind:'done',createdAt:Math.floor(Date.now()/1000)},token,{'X-Herdr-Laptop-ID':id});
 assert.equal((await send(laptopId,relayToken,'dynamic-one')).status,200);
 assert.deepEqual(delivered,[{token:phoneToken,event:{eventId:'dynamic-one',paneId:'w1:p1',kind:'done',deviceId:laptopId}}]);
 for(const [id,token] of [[laptopId,'x'.repeat(43)],['wrong-id',relayToken],['unclaimed','u'.repeat(43)]])assert.equal((await send(id,token,'invalid-'+id)).status,401);
 s.env.DEVICES='[{"id":"laptop","ownerEmail":"owner@example.com","label":"Legacy","url":"https://laptop.example.com"}]';
 s.env.PUSH_BRIDGE_TOKEN_HASHES=JSON.stringify({laptop:hash(bridgeToken)});
 assert.equal((await send('laptop',bridgeToken,'no-static-fallback')).status,401);
 s.sqlite.prepare('UPDATE laptops SET revoked_at=? WHERE id=?').run(Math.floor(Date.now()/1000),laptopId);
 assert.equal((await send(laptopId,relayToken,'revoked')).status,401);
 assert.equal(delivered.length,1);
});
test('relay push rechecks laptop ownership and recipient after claiming each delivery',async t=>{
 const sent=[];const s=setup(t,async(_env,token,event)=>{sent.push({token,event});return {invalidToken:false};});
 s.env.DEVICES='[]';delete s.env.PUSH_BRIDGE_TOKEN_HASHES;s.env.PUBLIC_SIGNUP_ENABLED='true';
 const laptopId='race-laptop',relayToken='r'.repeat(43);
 s.sqlite.prepare('INSERT INTO laptops(id,label,relay_token_hash,claim_token_hash,public_key,created_at,owner_email) VALUES (?,?,?,?,?,?,?)').run(laptopId,'Race',hash(relayToken),hash('claim'),'public',1,'owner@example.com');
 s.add('second-owner','session-two');s.add('other-account','other-session','other@example.com');
 await s.register();await s.register('g'.repeat(40),'second-owner');await s.register('o'.repeat(40),'other-account');
 const send=id=>s.call('/v1/push/events','POST',{eventId:id,paneId:'w1:p1',kind:'clear',targetEventId:'completion-one',createdAt:Math.floor(Date.now()/1000)},relayToken,{'X-Herdr-Laptop-ID':laptopId});
 s.sqlite.exec("CREATE TRIGGER owner_race AFTER INSERT ON push_deliveries WHEN NEW.event_id='owner-race' BEGIN UPDATE laptops SET owner_email='other@example.com' WHERE id='race-laptop'; END");
 assert.equal((await send('owner-race')).status,200);assert.equal(sent.length,0);
 s.sqlite.prepare('UPDATE laptops SET owner_email=? WHERE id=?').run('owner@example.com',laptopId);
 s.sqlite.exec("CREATE TRIGGER recipient_race AFTER INSERT ON push_deliveries WHEN NEW.event_id='recipient-race' AND NEW.session_id='session-one' BEGIN DELETE FROM push_subscriptions WHERE session_id='session-one'; END");
 assert.equal((await send('recipient-race')).status,200);
 assert.deepEqual(sent.map(x=>x.token),['g'.repeat(40)]);
 assert.deepEqual(sent[0].event,{eventId:'recipient-race',paneId:'w1:p1',kind:'clear',targetEventId:'completion-one',deviceId:laptopId});
 await s.register();
 s.sqlite.exec("CREATE TRIGGER session_race AFTER INSERT ON push_deliveries WHEN NEW.event_id='session-race' AND NEW.session_id='session-one' BEGIN UPDATE sessions SET expires_at=0 WHERE id='session-one'; END");
 assert.equal((await send('session-race')).status,200);assert.deepEqual(sent.map(x=>x.token),['g'.repeat(40),'g'.repeat(40)]);
 s.sqlite.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(Math.floor(Date.now()/1000)+3600,'session-one');
 s.sqlite.exec(`CREATE TRIGGER rotation_race AFTER INSERT ON push_deliveries WHEN NEW.event_id='rotation-race' BEGIN UPDATE laptops SET relay_token_hash='${hash('rotated')}' WHERE id='race-laptop'; END`);
 assert.equal((await send('rotation-race')).status,200);assert.equal(sent.length,2);
 s.sqlite.prepare('UPDATE laptops SET relay_token_hash=? WHERE id=?').run(hash(relayToken),laptopId);
 s.sqlite.exec("CREATE TRIGGER revocation_race AFTER INSERT ON push_deliveries WHEN NEW.event_id='revocation-race' BEGIN UPDATE laptops SET revoked_at=1 WHERE id='race-laptop'; END");
 assert.equal((await send('revocation-race')).status,200);assert.equal(sent.length,2);
});
