import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {readFile} from 'node:fs/promises';

const hosted='https://remote.example.com';
const legacy='https://legacy.example.com';
let mf;

before(async()=>{
  const bundle=await build({entryPoints:[new URL('../src/worker.js',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'neutral',external:['cloudflare:*','node:*'],conditions:['workerd','worker','browser']});
  mf=new Miniflare(convertV4MiniflareOptions({workers:[{
    name:'hosted-domain-test',modules:true,script:bundle.outputFiles[0].text,
    compatibilityDate:'2026-09-20',compatibilityFlags:['nodejs_compat'],
    bindings:{PORTAL_ORIGIN:hosted,LEGACY_PORTAL_ORIGIN:legacy,ACCESS_TEAM_DOMAIN:'test.cloudflareaccess.com',ACCESS_AUD:'aud',ALLOWED_EMAILS:'["owner@example.com"]',DEVICES:'[]',GRANT_SIGNING_JWK:'configured'},
    d1Databases:['DB'],serviceBindings:{ASSETS:'assets-test'}
  },{
    name:'assets-test',modules:true,
    script:"export default {fetch(request){return Response.json({versionCode:12,apkPath:'/v1/app-update/apk',assetRequestOrigin:new URL(request.url).origin,assetHeaders:[...request.headers]});}};"
  }],log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');
  const sql=await readFile(new URL('../migrations/0001_auth.sql',import.meta.url),'utf8');
  for(const statement of sql.split(';').map(value=>value.trim()).filter(Boolean))await db.prepare(statement).run();
});
after(async()=>{await mf?.dispose();});

test('configured portal pages stay live and legacy public links redirect without carrying queries',async()=>{
  const landing=await mf.dispatchFetch(hosted+'/download');
  assert.equal(landing.status,200,await landing.clone().text());
  assert.match(await landing.text(),/Download Herdr Remote for Android/);

  for(const path of ['/','/download','/setup','/source','/install.sh']){
    for(const method of ['GET','HEAD']){
      const response=await mf.dispatchFetch(legacy+path,{method,redirect:'manual'});
      assert.equal(response.status,308,`${method} ${path}`);
      assert.equal(response.headers.get('location'),hosted+path);
      assert.equal(await response.text(),'');
    }
  }
  const queried=await mf.dispatchFetch(legacy+'/download?next=https://attacker.example');
  assert.equal(queried.status,200);
  assert.equal(queried.headers.get('location'),null);
  const posted=await mf.dispatchFetch(legacy+'/download',{method:'POST'});
  assert.notEqual(posted.status,308);
});

test('legacy update and sign-in API retain old-host URLs',async()=>{
  const update=await mf.dispatchFetch(legacy+'/v1/app-update',{headers:{Cookie:'private=secret',Authorization:'Bearer private'}});
  assert.equal(update.status,200);
  const metadata=await update.json();
  assert.equal(metadata.apkPath,'/v1/app-update/apk');
  assert.equal(metadata.assetRequestOrigin,legacy);
  assert.deepEqual(metadata.assetHeaders,[]);
  const updateWithQuery=await mf.dispatchFetch(legacy+'/v1/app-update?next=https://attacker.example');
  assert.equal(updateWithQuery.status,400);
  assert.equal(updateWithQuery.headers.get('location'),null);

  const start=await mf.dispatchFetch(legacy+'/v1/auth/start',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(start.status,200);
  const challenge=await start.json();
  assert.equal(new URL(challenge.verificationUrl).origin,legacy);
  assert.match(challenge.verificationUrl,/\/login\?code=[A-F0-9]{4}-[A-F0-9]{4}$/);
  const invalid=await mf.dispatchFetch(legacy+'/v1/auth/start',{method:'POST',headers:{Origin:hosted,'Content-Type':'application/json'},body:'{}'});
  assert.equal(invalid.status,403);
});

test('only the exact legacy HTTPS host is accepted by a configured alias',async()=>{
  for(const origin of ['http://legacy.example.com','https://legacy.example.com:8443','https://legacy.example.com.attacker.example','https://remote.example.com.attacker.example']){
    const response=await mf.dispatchFetch(origin+'/download');
    assert.equal(response.status,421,origin);
    assert.equal(response.headers.get('location'),null);
  }
});
