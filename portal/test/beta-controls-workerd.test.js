import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {readFile} from 'node:fs/promises';
import {generateKeyPairSync} from 'node:crypto';

test('real D1 serializes the final beta slot and applies operator stop immediately',async t=>{
  const origin='https://remote.example.com';
  const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'der'}).toString('base64url');
  const bundle=await build({entryPoints:[new URL('../src/worker.js',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'neutral',external:['cloudflare:*','node:*'],conditions:['workerd','worker','browser']});
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'beta-test',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-20',compatibilityFlags:['nodejs_compat'],bindings:{PORTAL_ORIGIN:origin,DEVICES:'[]',PUBLIC_SIGNUP_ENABLED:'true',LAPTOP_REGISTRATION_ENABLED:'true'},d1Databases:['DB'],ratelimits:{EDGE_RELAY_LIMIT:{namespace_id:'31',simple:{limit:12000,period:60}},EDGE_SIGNUP_LIMIT:{namespace_id:'32',simple:{limit:120,period:60}}},durableObjects:{RELAY:{className:'Relay',useSQLite:true}}}],log:new Log(LogLevel.ERROR)}));
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB');
  for(const file of ['0001_auth.sql','0002_push.sql','0003_public.sql','0004_admission.sql','0005_beta_controls.sql','0008_unrestricted_registration.sql']){
    const sql=await readFile(new URL('../migrations/'+file,import.meta.url),'utf8');
    for(const statement of sql.split(';').map(value=>value.trim()).filter(Boolean))await db.prepare(statement).run();
  }
  assert.equal((await db.prepare('SELECT max_laptops FROM beta_controls WHERE id=1').first()).max_laptops,50);
  await db.prepare('UPDATE beta_controls SET max_laptops=1 WHERE id=1').run();
  const register=(label,ip='127.0.0.1')=>mf.dispatchFetch(`${origin}/v1/laptops/register`,{method:'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':ip},body:JSON.stringify({label,publicKey:key})});
  const results=await Promise.all(Array.from({length:8},(_,i)=>register(`Laptop ${i}`)));
  assert.equal(results.filter(response=>response.status===200).length,1);
  assert.equal(results.filter(response=>response.status===503).length,7);
  const winner=await results.find(response=>response.status===200).json();
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM laptops WHERE revoked_at IS NULL').first()).n,1);
  await db.prepare('UPDATE beta_controls SET registration_enabled=0,max_laptops=2 WHERE id=1').run();
  assert.equal((await register('Paused')).status,503);
  // A stopped registration gate must not invalidate a previously admitted laptop.
  const relay=await mf.dispatchFetch(`${origin}/v1/relay/${winner.id}/connect`,{headers:{Upgrade:'websocket',Authorization:`Bearer ${winner.relayToken}`}});
  assert.equal(relay.status,101);relay.webSocket.accept();relay.webSocket.close();
  await db.prepare('UPDATE beta_controls SET registration_enabled=1 WHERE id=1').run();
  assert.equal((await register('Resumed')).status,200);
  // Migration preserves existing settings; unrestricted is an explicit operator action.
  assert.equal((await db.prepare('SELECT registration_unrestricted FROM beta_controls WHERE id=1').first()).registration_unrestricted,0);
  await db.prepare('UPDATE beta_controls SET registration_unrestricted=1 WHERE id=1').run();
  const unrestricted=await Promise.all(Array.from({length:51},(_,i)=>register(`Public ${i}`,`192.0.2.${i+1}`)));
  assert.equal(unrestricted.filter(response=>response.status===200).length,51);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM laptops WHERE revoked_at IS NULL').first()).n,53);
  assert.equal((await db.prepare('SELECT max_laptops FROM beta_controls WHERE id=1').first()).max_laptops,2);
  // Unrestricted count still preserves the ten-per-IP hourly abuse quota.
  for(let i=0;i<10;i++)assert.equal((await register(`IP quota ${i}`,'198.51.100.1')).status,200);
  assert.equal((await register('IP quota rejected','198.51.100.1')).status,429);
  await db.prepare('UPDATE beta_controls SET registration_enabled=0 WHERE id=1').run();
  assert.equal((await register('Unrestricted paused','203.0.113.1')).status,503);
  await db.prepare('UPDATE beta_controls SET registration_enabled=1,registration_unrestricted=0 WHERE id=1').run();
  assert.equal((await register('Finite cap restored','203.0.113.2')).status,503);
});
