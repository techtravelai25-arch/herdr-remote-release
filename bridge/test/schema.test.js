import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const schema=JSON.parse(fs.readFileSync(new URL('../../discovery/herdr-core-schema.json',import.meta.url)));
const read=name=>fs.readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
test('every herdr-core RPC the bridge sends exists in the saved herdr-core schema',()=>{
  const source=read('herdr-core.js')+read('core-events.js');
  const sent=new Set([...source.matchAll(/rpc\('([a-z.]+)'/g),...source.matchAll(/method:'([a-z.]+)'/g)].map(m=>m[1]));
  const methods=new Set(schema.methods.map(m=>m.name));
  assert.ok(sent.has('terminal.list')&&sent.has('terminal.attach')&&sent.has('events.subscribe'));
  for(const name of sent)assert.ok(methods.has(name),`Not in herdr-core schema: ${name}`);
});
test('every bridge-internal Herdr method is implemented by the herdr-core adapter',()=>{
  const files=fs.readdirSync(new URL('../src/',import.meta.url)).filter(name=>name.endsWith('.js')&&name!=='herdr-core.js');
  const called=new Set(files.flatMap(name=>[...read(name).matchAll(/herdr\.call\('([^']+)'/g)].map(m=>m[1])));
  const cases=new Set([...read('herdr-core.js').matchAll(/case '([a-z_.]+)'/g)].map(m=>m[1]));
  assert.ok(called.size>5);
  for(const name of called)assert.ok(cases.has(name),`Not implemented by HerdrCore: ${name}`);
});
