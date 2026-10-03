import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair, exportJWK, SignJWT} from 'jose';
import {createAuthenticator} from '../src/auth.js';

const {publicKey, privateKey} = await generateKeyPair('EdDSA');
const jwk = {...await exportJWK(publicKey), kid:'test'};
const config = {issuer:'https://remote.example.com',audience:'laptop-one',jwks:{keys:[jwk]}};
const store = {authenticate: token => token === 'legacy' ? {deviceId:'paired'} : null};
const authenticate = createAuthenticator(store,config);
const sid = 'session_1234567890123456';
async function grant(overrides={}, header={}, key=privateKey) {
 const now=Math.floor(Date.now()/1000);
 return new SignJWT({iss:config.issuer,aud:config.audience,sub:'owner@example.com',sid,iat:now,exp:now+300,...overrides})
  .setProtectedHeader({alg:'EdDSA',kid:'test',typ:'herdr-grant+jwt',...header}).sign(key);
}
test('legacy pairing works with account auth disabled or enabled',async()=>{
 assert.deepEqual(await authenticate('legacy'),{deviceId:'paired'});
 const disabled=createAuthenticator(store);
 assert.deepEqual(await disabled('legacy'),{deviceId:'paired'});
 assert.equal(await disabled(await grant()),null);
});
test('signed account grant uses stable session identity across refreshes',async()=>{
 const expected={deviceId:`account:${sid}`,deviceName:'owner@example.com',email:'owner@example.com'};
 assert.deepEqual(await authenticate(await grant()),expected);
 assert.deepEqual(await authenticate(await grant({exp:Math.floor(Date.now()/1000)+240})),expected);
});
test('rejects wrong issuer, audience, expired, overlong and incomplete grants',async()=>{
 const now=Math.floor(Date.now()/1000);
 for (const change of [
  {iss:'https://evil.example.com'}, {aud:'other-laptop'}, {exp:now-1},
  {iat:now,exp:now+301}, {iat:now+10}, {iat:undefined}, {exp:undefined},
  {sid:undefined}, {sid:'short'}, {sub:'not-an-email'},
 ]) assert.equal(await authenticate(await grant(change)),null,JSON.stringify(change));
 assert.equal(await authenticate(await grant({}, {typ:'JWT'})),null);
 assert.equal(await authenticate('bad.token'),null);
 assert.equal(await authenticate('x'.repeat(8193)),null);
});
test('rejects forged signatures and unsafe trust configuration',async()=>{
 const other=await generateKeyPair('EdDSA');
 assert.equal(await authenticate(await grant({}, {}, other.privateKey)),null);
 for(const change of [{issuer:'http://remote.example.com'}, {issuer:'https://remote.example.com/path'}, {audience:''}, {jwks:{keys:[]}}, {jwks:{keys:[{...jwk,d:'private'}]}}])
  assert.throws(()=>createAuthenticator(store,{...config,...change}));
});
