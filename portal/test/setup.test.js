import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {handleSetup} from '../src/setup.js';
const origin='https://remote.example.com';
test('setup and source offers work without account tokens and installer verifies companion checksum',async()=>{
 const env={PORTAL_ORIGIN:origin};
 const page=await handleSetup(new Request(origin+'/setup'),env);
 assert.equal(page.status,200);const pageText=await page.text();assert.match(pageText,/Scan the QR/);
 assert.match(pageText,/curl --proto '=https' --tlsv1\.2 -fsSL https:\/\/remote\.example\.com\/install\.sh \| bash/);
 assert.match(pageText,/Choose this server or enter another server URL/);
 const source=await handleSetup(new Request(origin+'/source'),env);assert.match(await source.text(),/AGPL-3.0-or-later/);
 const script=await handleSetup(new Request(origin+'/install.sh'),env);const text=await script.text();assert.match(text,/sha256sum --check --strict/);assert.match(text,/trap 'rm -rf/);assert.ok(text.indexOf('sha256sum --check')<text.indexOf('bash "$work/herdr-remote/install.sh"'));
 assert.match(text,/read -r -p 'Choose 1 or 2 \[1\]: ' choice <\/dev\/tty/);
 assert.match(text,/2\) Another self-hosted server/);
 assert.match(text,/bash "\$work\/herdr-remote\/install\.sh" --portal "\$portal"/);
 const syntax=spawnSync('bash',['-n'],{input:text,encoding:'utf8'});assert.equal(syntax.status,0,syntax.stderr);
});
test('distribution routes strip credentials, reject methods/query and fail missing assets clearly',async()=>{
 let seen;
 const env={PORTAL_ORIGIN:origin,ASSETS:{fetch:async request=>{seen=request;return new Response('archive',{status:200});}}};
 for(const [route,asset] of [['/v1/companion/archive','/herdr-remote-companion.tar.gz'],['/v1/companion/manifest','/companion-release.json'],['/v1/companion/signature','/companion-release.sig'],['/v1/companion/public-key','/companion-release-key.pem'],['/v1/release-manifest','/release-manifest.json']]){
  const response=await handleSetup(new Request(origin+route,{headers:{Authorization:'Bearer secret',Cookie:'private'}}),env);
  assert.equal(await response.text(),'archive');assert.deepEqual([...seen.headers],[]);assert.equal(new URL(seen.url).pathname,asset);
 }
 assert.equal((await handleSetup(new Request(origin+'/setup?token=secret'),env)).status,400);
 assert.equal((await handleSetup(new Request(origin+'/v1/release-manifest?x=1'),env)).status,400);
 assert.equal((await handleSetup(new Request(origin+'/install.sh',{method:'POST'}),env)).status,400);
 env.ASSETS.fetch=async()=>new Response(null,{status:404});assert.equal((await handleSetup(new Request(origin+'/v1/source/archive'),env)).status,503);
 assert.equal(await handleSetup(new Request(origin+'/unrelated'),env),null);
});
test('neutral local development renders setup while production still requires HTTPS',async()=>{
  const r=await handleSetup(new Request('http://localhost:8787/setup'),{PORTAL_ORIGIN:'http://localhost:8787'});assert.equal(r.status,200);
  const script=await handleSetup(new Request('http://localhost:8787/install.sh'),{PORTAL_ORIGIN:'http://localhost:8787'});const text=await script.text();assert.match(text,/--proto '=http'/);assert.match(text,/portal='http:\/\/localhost:8787'/);
  await assert.rejects(handleSetup(new Request('http://untrusted.example/setup'),{PORTAL_ORIGIN:'http://untrusted.example'}),/Invalid setup origin/);
});
test('self-hosted setup defaults its installer to its own HTTPS relay',async()=>{
 const origin='https://selfhost.example';const env={PORTAL_ORIGIN:origin};
 const page=await handleSetup(new Request(origin+'/setup'),env);assert.match(await page.text(),/Choose this server or enter another server URL/);
 const script=await handleSetup(new Request(origin+'/install.sh'),env);const body=await script.text();
 assert.match(body,/1\) This server \(recommended\)/);assert.match(body,/portal='https:\/\/selfhost\.example'/);
 assert.match(body,/https:\/\/selfhost\.example\/v1\/companion\/archive/);
});
