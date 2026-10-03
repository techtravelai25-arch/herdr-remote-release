import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,existsSync,rmSync,openSync,ftruncateSync,closeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('cloud publisher rejects metadata mismatch without replacing previous staged release',()=>{
 const root=mkdtempSync(join(tmpdir(),'herdr-publish-test-'));
 try {
  for(const directory of ['ops','artifacts','portal/release-assets'])mkdirSync(join(root,directory),{recursive:true});
  copyFileSync(new URL('../../ops/publish-cloud-apk.sh',import.meta.url),join(root,'ops/publish-cloud-apk.sh'));
  writeFileSync(join(root,'portal/release-assets/existing'),'previous release');
  writeFileSync(join(root,'artifacts/herdr-remote.apk'),'unverified APK');
  writeFileSync(join(root,'artifacts/app-update.json'),JSON.stringify({versionCode:1,versionName:'test',size:14,sha256:'0'.repeat(64),apkPath:'/v1/app-update/apk'}));
  const result=spawnSync('bash',[join(root,'ops/publish-cloud-apk.sh'),'--stage-only'],{encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/size\/hash\/path does not match/);
  assert.equal(readFileSync(join(root,'portal/release-assets/existing'),'utf8'),'previous release');
  assert.equal(existsSync(join(root,'portal/release-assets/herdr-remote.apk')),false);
  const fd=openSync(join(root,'artifacts/herdr-remote.apk'),'w');ftruncateSync(fd,26*1024*1024);closeSync(fd);
  const oversized=spawnSync('bash',[join(root,'ops/publish-cloud-apk.sh'),'--stage-only'],{encoding:'utf8'});
  assert.notEqual(oversized.status,0);assert.match(oversized.stderr,/25 MiB/);
 } finally {rmSync(root,{recursive:true,force:true});}
});
