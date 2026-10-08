import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const schema=JSON.parse(fs.readFileSync(new URL('../../discovery/herdr-api-schema.json',import.meta.url)));
test('all bridge raw method strings exist in the saved installed Herdr schema',()=>{
 const files=fs.readdirSync(new URL('../src/',import.meta.url)).filter(name=>name.endsWith('.js'));
 const source=files.map(name=>fs.readFileSync(new URL('../src/'+name,import.meta.url),'utf8')).join('\n');
 const names=[...source.matchAll(/herdr\.call\('([^']+)'/g)].map(m=>m[1]);
 const methods=new Set(schema.schemas.request.oneOf.map(r=>r.properties.method.const));
 assert.ok(names.includes('session.snapshot')&&names.includes('agent.start')&&names.includes('pane.send_keys'));
 for(const name of names)assert.ok(methods.has(name),`Not in installed schema: ${name}`);
 assert.equal(schema.protocol,22);
 const read=schema.schemas.request.$defs.ReadSource.enum;assert.ok(read.includes('recent_unwrapped'));
});
