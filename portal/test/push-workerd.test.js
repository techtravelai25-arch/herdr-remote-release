import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';

// Detailed isolation/race behavior belongs to push.test.js. This fixture proves
// the new auth/routing SQL and crypto execute with actual workerd/D1 bindings.
test('workerd routes registered-PC push through real D1 claims without legacy credentials',async t=>{
  const origin='https://remote.example.com',relayToken='r'.repeat(43);
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const compiled=await build({stdin:{contents:`
    import {createPortal} from './src/index.js';
    export default createPortal({pushSender:async(env,token,event)=>{
      await env.DB.prepare('INSERT INTO synthetic_sends(token,event) VALUES (?,?)')
        .bind(token,JSON.stringify(event)).run();
      return {invalidToken:false};
    }});`,resolveDir:new URL('..',import.meta.url).pathname},
    bundle:true,write:false,format:'esm',platform:'neutral',external:['cloudflare:*','node:*'],
    conditions:['workerd','worker','browser']});
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{
    name:'push-runtime-test',modules:true,script:compiled.outputFiles[0].text,
    compatibilityDate:'2026-09-20',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],
    bindings:{PORTAL_ORIGIN:origin,PUBLIC_SIGNUP_ENABLED:'true',DEVICES:'[]',ALLOWED_EMAILS:'[]',
      FIREBASE_ANDROID_CONFIG:JSON.stringify({projectId:'test-project',applicationId:'1:123:android:abcdef',
        senderId:'123',apiKey:'AIza'+'a'.repeat(25)}),FIREBASE_SERVICE_ACCOUNT:'synthetic-sender-only'},
  }],log:new Log(LogLevel.ERROR)}));
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB');
  for(const name of ['0001_auth.sql','0002_push.sql','0003_public.sql','0004_admission.sql']) {
    const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');
    for(const statement of sql.split(';').map(value=>value.trim()).filter(Boolean))
      await db.prepare(statement).run();
  }
  await db.prepare('CREATE TABLE synthetic_sends(token TEXT,event TEXT)').run();
  await db.prepare('INSERT INTO laptops(id,label,relay_token_hash,claim_token_hash,public_key,created_at,owner_email) VALUES (?,?,?,?,?,?,?)')
    .bind('current-pc','Current PC',hash(relayToken),hash('claim'),'synthetic-public-key',1,'owner@example.com').run();
  const call=(path,method,token,payload,extra={})=>mf.dispatchFetch(origin+path,{method,
    headers:{Authorization:'Bearer '+token,...(payload?{'Content-Type':'application/json'}:{}),...extra},
    ...(payload?{body:JSON.stringify(payload)}:{})});
  const expiry=Math.floor(Date.now()/1000)+3600;
  for(const [session,account,email,fcm] of [
    ['current-phone','owner-account','owner@example.com','synthetic-current-fcm-token'],
    ['other-phone','other-account','other@example.com','synthetic-other-fcm-token'],
  ]) {
    await db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').bind(hash(account),session,session,email,expiry).run();
    assert.equal((await call('/v1/push/subscription','PUT',account,{token:fcm})).status,200);
  }
  assert.equal((await (await call('/v1/push/config','GET','owner-account')).json()).available,true);
  const event={eventId:'runtime-current-pc-001',paneId:'w1:p1',kind:'done',createdAt:Math.floor(Date.now()/1000)};
  assert.equal((await call('/v1/push/events','POST','x'.repeat(43),event,{'X-Herdr-Laptop-ID':'current-pc'})).status,401);
  for(let index=0;index<2;index++)
    assert.equal((await call('/v1/push/events','POST',relayToken,event,{'X-Herdr-Laptop-ID':'current-pc'})).status,200);
  const sends=(await db.prepare('SELECT token,event FROM synthetic_sends').all()).results;
  assert.deepEqual(sends.map(({token,event})=>({token,event:JSON.parse(event)})),[{token:'synthetic-current-fcm-token',event:{
    eventId:event.eventId,paneId:event.paneId,kind:'done',deviceId:'current-pc',
  }}]);
  assert.equal((await db.prepare('SELECT sent FROM push_deliveries WHERE device_id=? AND event_id=?')
    .bind('current-pc',event.eventId).first()).sent,1);
  await db.prepare('UPDATE laptops SET revoked_at=1 WHERE id=?').bind('current-pc').run();
  assert.equal((await call('/v1/push/events','POST',relayToken,{...event,eventId:'runtime-revoked-pc-002'},
    {'X-Herdr-Laptop-ID':'current-pc'})).status,401);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM synthetic_sends').first()).n,1);
});
