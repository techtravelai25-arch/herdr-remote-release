import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.js';
import {Operations} from '../src/operations.js';

test('a failed file or directory sync blocks an action before dispatch', async t => {
  for (const failingSync of [1, 2]) {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-durability-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const store=new Store(dir),operations=new Operations(store);
    const original=fs.fsyncSync;
    let syncs=0,dispatched=false;
    fs.fsyncSync=(fd)=>{
      if(++syncs===failingSync)throw new Error('simulated storage failure');
      return original(fd);
    };
    try {
      await assert.rejects(operations.run('device','durable-action-1','pane.input',{},async()=>{
        dispatched=true;
      }),/simulated storage failure/);
    } finally {fs.fsyncSync=original;}
    assert.equal(dispatched,false);
    assert.deepEqual(fs.readdirSync(dir).filter(name=>name.includes('operations.json.')),[]);
    if(failingSync===2) {
      const recovered=new Operations(new Store(dir));
      assert.equal(recovered.status('device','durable-action-1').status,'uncertain');
    }
  }
});

test('a pairing code stays consumed across credential publication failures', t => {
 for (const published of [false, true]) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-pairing-durability-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),code=store.pairCode(),write=store.write.bind(store);
  store.write=(name,value)=>{
    if(name==='devices.json') {
      if(published)write(name,value);
      throw new Error('simulated crash during credential publication');
    }
    return write(name,value);
  };
  assert.throws(()=>store.pair(code,'Phone'),/simulated crash/);
  const recovered=new Store(dir);
  assert.throws(()=>recovered.pair(code,'Another phone'),error=>error.code==='pairing_closed');
  assert.equal(recovered.read('devices.json',[]).length,published?1:0);
 }
});
