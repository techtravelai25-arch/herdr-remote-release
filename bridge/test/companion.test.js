import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setupCompanion,verifyHerdrProtocol} from '../src/companion.js';
import {spawnSync} from 'node:child_process';
function homeFixture(t){const home=fs.mkdtempSync(path.join(os.tmpdir(),'setup-test-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));return home;}
test('setup registers once, keeps private identity, reuses config and restarts only companion on upgrade',async t=>{
 const home=homeFixture(t),configPath=path.join(home,'config/config.json'),calls=[];let registrations=0,pairs=0,verified=0;
 const deps={home,configPath,detectSocket:async()=>'/custom/herdr.sock',checkSocket:async()=>true,checkPort:async()=>{},exec:(command,args)=>calls.push([command,...args]),pair:async()=>{pairs++;},verifyHerdr:async socket=>{verified++;assert.equal(socket,'/custom/herdr.sock');},fetchImpl:async()=>{registrations++;return new Response(JSON.stringify({id:'test-laptop',relayToken:'relay',claimToken:'claim',url:'https://remote.example.com'}));}};
 const first=await setupCompanion(['--portal','https://remote.example.com'],deps),identity=first.store.read('relay-identity.json');assert.equal(registrations,1);assert.equal(pairs,1);assert.equal(fs.statSync(path.join(first.config.stateDir,'relay-identity.json')).mode&0o777,0o600);
 assert.equal(first.config.cloudPush,undefined);
 const config=JSON.parse(fs.readFileSync(configPath));config.projects=[{id:'project',label:'Existing',path:home}];fs.writeFileSync(configPath,JSON.stringify(config));
 const second=await setupCompanion([],deps);assert.equal(registrations,1);assert.equal(pairs,2);assert.equal(verified,2);assert.deepEqual(second.store.read('relay-identity.json'),identity);assert.equal(second.config.projects[0].id,'project');assert.equal(second.config.cloudPush,undefined);
 assert.equal(calls.filter(c=>c.includes('restart')&&c.includes('herdr-remote-companion.service')).length,2);assert.equal(calls.filter(c=>c.some(v=>v==='herdr-remote-session.service')).length,0);
 const unit=fs.readFileSync(path.join(home,'.config/systemd/user/herdr-remote-companion.service'),'utf8');assert.ok(unit.includes(path.join(home,'.local/bin')));assert.ok(unit.includes(path.join(home,'.opencode/bin')));
});
test('explicit server choice cannot silently replace an existing relay identity',async t=>{
 const home=homeFixture(t),configPath=path.join(home,'config/config.json'),calls=[];let registrations=0;
 const deps={home,configPath,detectSocket:async()=>'/custom/herdr.sock',checkSocket:async()=>true,checkPort:async()=>{},exec:(_command,args)=>calls.push(args),pair:async()=>{},verifyHerdr:async()=>{},fetchImpl:async()=>{registrations++;return new Response(JSON.stringify({id:'self-hosted-laptop',relayToken:'relay',claimToken:'claim',url:'https://my-relay.example'}));}};
 const first=await setupCompanion(['--portal','https://my-relay.example'],deps);
 assert.equal(first.config.cloudPush,undefined,'self-hosted setup does not enable push implicitly');
 const identity=first.store.read('relay-identity.json'),config=fs.readFileSync(configPath,'utf8'),service=fs.readFileSync(path.join(home,'.config/systemd/user/herdr-remote-companion.service'),'utf8'),callCount=calls.length;
 await assert.rejects(setupCompanion(['--portal','https://remote.example.com'],deps),/already registered with https:\/\/my-relay\.example/);
 assert.deepEqual(first.store.read('relay-identity.json'),identity);assert.equal(fs.readFileSync(configPath,'utf8'),config);
 assert.equal(fs.readFileSync(path.join(home,'.config/systemd/user/herdr-remote-companion.service'),'utf8'),service);
 assert.equal(calls.length,callCount);assert.equal(registrations,1);
 await setupCompanion([],deps);assert.equal(registrations,1,'an update without an explicit server keeps its existing identity');
});
test('self-hosted setup preserves explicit cloud push opt-out and existing sender config',async t=>{
 const home=homeFixture(t),configPath=path.join(home,'config.json');
 const base={port:8788,socketPath:'/custom/herdr.sock',stateDir:path.join(home,'state'),projects:[],allowTerminalInput:false};
 const deps={home,configPath,checkSocket:async()=>true,checkPort:async()=>{},verifyHerdr:async()=>{},
  fetchImpl:async()=>new Response(JSON.stringify({id:'test-laptop',relayToken:'r'.repeat(43),claimToken:'c'.repeat(43),url:'https://remote.example.com'}))};
 fs.writeFileSync(configPath,JSON.stringify({...base,cloudPush:false}));
 const disabled=await setupCompanion(['--portal','https://remote.example.com','--foreground','--no-pair'],deps);
 assert.equal(disabled.config.cloudPush,false);
 const legacy={portalOrigin:'https://remote.example.com',deviceId:'legacy',tokenFile:'/private/legacy-token'};
 fs.writeFileSync(configPath,JSON.stringify({...disabled.config,cloudPush:legacy}));
 const upgraded=await setupCompanion(['--portal','https://remote.example.com','--foreground','--no-pair'],deps);
 assert.deepEqual(upgraded.config.cloudPush,legacy);
});
test('setup starts a missing default session and verifies protocol before presenting QR',async t=>{
 const home=homeFixture(t),bin=path.join(home,'.local/bin');fs.mkdirSync(bin,{recursive:true});fs.writeFileSync(path.join(bin,'herdr'),'#!/bin/sh\n',{mode:0o755});const calls=[];
 await setupCompanion(['--portal','https://remote.example.com'],{home,configPath:path.join(home,'config.json'),detectSocket:async()=>path.join(home,'.config/herdr/herdr.sock'),checkSocket:async()=>false,checkPort:async()=>{},sessionOwner:()=>({kind:'manual'}),exec:(_command,args)=>calls.push(args),pair:async()=>calls.push(['pair']),verifyHerdr:async()=>calls.push(['verify']),fetchImpl:async()=>new Response(JSON.stringify({id:'new',relayToken:'relay',claimToken:'claim',url:'https://remote.example.com'}))});
 assert.ok(calls.some(c=>c.includes('--now')&&c.includes('herdr-remote-session.service')));assert.ok(calls.findIndex(c=>c[0]==='verify')<calls.findIndex(c=>c[0]==='pair'));
});
test('protocol verification reports actionable incompatibility and retries only unavailable sessions',async()=>{
 await assert.rejects(verifyHerdrProtocol('/unused',{client:{call:async()=>({snapshot:{protocol:21}})}}),/requires protocol 22.*restart/);
 let count=0;await verifyHerdrProtocol('/unused',{client:{call:async()=>{if(count++===0)throw Object.assign(Error('starting'),{code:'herdr_offline'});return {snapshot:{protocol:22}};}},sleep:async()=>{}});assert.equal(count,2);
});
test('installer mocked execution copies source, locks dependencies, creates launcher and invokes setup',t=>{
 const home=homeFixture(t),bin=path.join(home,'mock-bin'),log=path.join(home,'calls');fs.mkdirSync(bin);
 const mock=(name,body)=>{fs.writeFileSync(path.join(bin,name),'#!/usr/bin/env bash\nset -eu\n'+body,{mode:0o755});};
 mock('systemctl','printf "systemctl %s\\n" "$*" >> "$MOCK_LOG"\n');
 mock('node','if [ "${1:-}" = -e ]; then exit 0; fi\nprintf "node %s\\n" "$*" >> "$MOCK_LOG"\n');
 mock('npm','printf "npm %s\\n" "$*" >> "$MOCK_LOG"\n');mock('herdr','printf "herdr 0.9.0\\n"\n');
 const target=path.join(home,'existing-checkout-launcher');fs.writeFileSync(target,'keep this source');fs.mkdirSync(path.join(home,'.local/bin'),{recursive:true});fs.symlinkSync(target,path.join(home,'.local/bin/herdr-remote'));
 const result=spawnSync('bash',[path.resolve('../ops/install-companion.sh'),'--portal','https://selfhost.example'],{encoding:'utf8',env:{...process.env,HOME:home,PATH:bin+':'+process.env.PATH,MOCK_LOG:log}});assert.equal(fs.readFileSync(target,'utf8'),'keep this source');assert.equal(fs.lstatSync(path.join(home,'.local/bin/herdr-remote')).isSymbolicLink(),false);assert.equal(result.status,0,result.stderr);
 const calls=fs.readFileSync(log,'utf8');assert.match(calls,/systemctl --user show-environment/);assert.match(calls,/npm ci --omit=dev --ignore-scripts/);assert.match(calls,/cli.js setup --no-pair --portal https:\/\/selfhost\.example/);assert.ok(fs.existsSync(path.join(home,'.local/share/herdr-remote-companion/current/bridge/src/relay.js')));
 const launcher=fs.readFileSync(path.join(home,'.local/bin/herdr-remote'),'utf8');assert.ok(launcher.includes(path.join(home,'.local/bin')));assert.ok(launcher.includes(path.join(bin,'node')));
});
test('installer automatically installs missing runtime and Herdr with verified archive in mocked home',t=>{
 const home=homeFixture(t),bin=path.join(home,'mock-bin'),log=path.join(home,'calls'),release=path.join(home,'release'),archive='node-v22.99.0-linux-x64.tar.xz';fs.mkdirSync(bin);fs.mkdirSync(path.join(release,'node/bin'),{recursive:true});
 const script=(file,body)=>fs.writeFileSync(file,'#!/usr/bin/env bash\nset -eu\n'+body,{mode:0o755});
 script(path.join(bin,'systemctl'),'exit 0\n');script(path.join(bin,'node'),'exit 1\n');script(path.join(bin,'uname'),'if [ "$1" = -s ]; then echo Linux; else echo x86_64; fi\n');
 script(path.join(release,'node/bin/node'),'if [ "${1:-}" = -e ]; then exit 0; fi\nprintf "new-node %s\\n" "$*" >> "$MOCK_LOG"\n');script(path.join(release,'node/bin/npm'),'printf "new-npm %s\\n" "$*" >> "$MOCK_LOG"\n');script(path.join(release,'node/bin/npx'),'exit 0\n');
 assert.equal(spawnSync('tar',['-cJf',path.join(release,archive),'-C',release,'node']).status,0);
 const sum=spawnSync('sha256sum',[path.join(release,archive)],{encoding:'utf8'}).stdout.split(' ')[0];fs.writeFileSync(path.join(release,'SHASUMS256.txt'),`${sum}  ${archive}\n`);
 script(path.join(release,'herdr-install.sh'),'mkdir -p "$HERDR_INSTALL_DIR"\nprintf "#!/bin/sh\\necho herdr 0.9.0\\n" > "$HERDR_INSTALL_DIR/herdr"\nchmod +x "$HERDR_INSTALL_DIR/herdr"\nprintf "installed-herdr\\n" >> "$MOCK_LOG"\n');
 script(path.join(bin,'curl'),'url=""; out=""; while [ "$#" -gt 0 ]; do case "$1" in https://*) url="$1";; -o) shift; out="$1";; esac; shift; done\ncase "$url" in https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt) cp "$MOCK_RELEASE/SHASUMS256.txt" "$out";; https://nodejs.org/dist/latest-v22.x/node-*.tar.xz) cp "$MOCK_RELEASE/${url##*/}" "$out";; https://herdr.dev/install.sh) cp "$MOCK_RELEASE/herdr-install.sh" "$out";; *) exit 8;; esac\n');
 const result=spawnSync('bash',[path.resolve('../ops/install-companion.sh')],{encoding:'utf8',env:{...process.env,HOME:home,PATH:bin+':/usr/bin:/bin',MOCK_LOG:log,MOCK_RELEASE:release}});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/OK/);const calls=fs.readFileSync(log,'utf8');assert.match(calls,/installed-herdr/);assert.match(calls,/new-npm ci --omit=dev --ignore-scripts/);assert.match(calls,/new-node .*cli.js setup/);assert.ok(fs.existsSync(path.join(home,'.local/bin/herdr')));
});
test('installer stops before installing when systemd user session is unavailable',t=>{
 const home=homeFixture(t),bin=path.join(home,'mock-bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'systemctl'),'#!/bin/sh\nexit 1\n',{mode:0o755});
 const result=spawnSync('bash',[path.resolve('../ops/install-companion.sh')],{encoding:'utf8',env:{...process.env,HOME:home,PATH:bin+':/usr/bin:/bin'}});assert.equal(result.status,1);assert.match(result.stderr,/systemd user session/);assert.equal(fs.existsSync(path.join(home,'.local/share/herdr-remote-companion')),false);
});
function upgradeFixture(t,installer=path.resolve('../ops/install-companion.sh')){
 const home=homeFixture(t),bin=path.join(home,'mock-bin'),base=path.join(home,'.local/share/herdr-remote-companion'),old=path.join(base,'releases/old'),log=path.join(home,'calls');fs.mkdirSync(bin);fs.mkdirSync(path.join(old,'bridge/src'),{recursive:true});fs.writeFileSync(path.join(old,'bridge/src/cli.js'),'old-release');fs.symlinkSync(old,path.join(base,'current'));fs.mkdirSync(path.join(home,'.local/share/herdr-remote'),{recursive:true});fs.writeFileSync(path.join(home,'.local/share/herdr-remote/keys'),'preserve');
 const mock=(name,body)=>fs.writeFileSync(path.join(bin,name),'#!/usr/bin/env bash\nset -eu\n'+body,{mode:0o755});mock('systemctl','printf "systemctl %s\\n" "$*" >> "$MOCK_LOG"\n');mock('herdr','exit 0\n');mock('node','if [ "${2:-}" = doctor ] && [ "${FAIL_DOCTOR:-}" = yes ]; then exit 7; fi\nexit 0\n');mock('npm','if [ "${FAIL_NPM:-}" = yes ]; then exit 8; fi\nexit 0\n');
 const run=extra=>spawnSync('bash',[installer],{encoding:'utf8',env:{...process.env,HOME:home,PATH:bin+':/usr/bin:/bin',MOCK_LOG:log,...extra}});return {home,base,old,log,run};
}
function installerWorktree(t){
 const area=homeFixture(t),repo=path.join(area,'repo'),worktree=path.join(area,'worktree');
 const git=args=>{const result=spawnSync('git',args,{encoding:'utf8'});assert.equal(result.status,0,result.stderr);};
 git(['init','--quiet',repo]);
 git(['-C',repo,'-c','user.name=Installer Test','-c','user.email=installer@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','--quiet','--allow-empty','-m','Fixture']);
 git(['-C',repo,'worktree','add','--quiet','--detach',worktree]);
 assert.equal(fs.lstatSync(path.join(worktree,'.git')).isFile(),true);
 fs.mkdirSync(path.join(worktree,'bridge'));fs.mkdirSync(path.join(worktree,'ops'));
 for(const name of ['src','package.json','package-lock.json'])fs.cpSync(path.resolve(name),path.join(worktree,'bridge',name),{recursive:true});
 for(const name of ['install-companion.sh','companion-version.json','companion-release-key.pem','verify-companion.mjs','update-companion.sh'])fs.copyFileSync(path.resolve('../ops',name),path.join(worktree,'ops',name));
 return worktree;
}
test('installer accepts a verified Git worktree and uses its source release and trust files',t=>{
 const worktree=installerWorktree(t),f=upgradeFixture(t,path.join(worktree,'ops/install-companion.sh')),result=f.run({});
 assert.equal(result.status,0,result.stderr);
 const current=fs.realpathSync(path.join(f.base,'current'));assert.notEqual(current,f.old);
 for(const [installed,source] of [['companion-version.json','companion-version.json'],['verify-companion.mjs','verify-companion.mjs'],['update.sh','update-companion.sh']])assert.deepEqual(fs.readFileSync(path.join(current,installed)),fs.readFileSync(path.join(worktree,'ops',source)));
 assert.deepEqual(fs.readFileSync(path.join(f.base,'trusted-release-key.pem')),fs.readFileSync(path.join(worktree,'ops/companion-release-key.pem')));
});
test('unverified Git markers cannot bypass the archive checksum requirement',t=>{
 for(const marker of ['file','directory']){
  const worktree=installerWorktree(t);fs.unlinkSync(path.join(worktree,'.git'));
  if(marker==='file')fs.writeFileSync(path.join(worktree,'.git'),'gitdir: /nonexistent-installer-fixture\n');else fs.mkdirSync(path.join(worktree,'.git'));
  const f=upgradeFixture(t,path.join(worktree,'ops/install-companion.sh')),result=f.run({});
  assert.equal(result.status,1);assert.match(result.stderr,/checksum manifest is missing/);assert.equal(fs.realpathSync(path.join(f.base,'current')),f.old);
 }
});
test('failed dependency installation never switches or damages the old release',t=>{
 const f=upgradeFixture(t),result=f.run({FAIL_NPM:'yes'});assert.equal(result.status,8);assert.equal(fs.realpathSync(path.join(f.base,'current')),f.old);assert.equal(fs.readFileSync(path.join(f.old,'bridge/src/cli.js'),'utf8'),'old-release');assert.equal(fs.readFileSync(path.join(f.home,'.local/share/herdr-remote/keys'),'utf8'),'preserve');assert.doesNotMatch(fs.readFileSync(f.log,'utf8'),/restart/);
});
test('failed local readiness rolls back only companion and keeps device state',t=>{
 const f=upgradeFixture(t),result=f.run({FAIL_DOCTOR:'yes'});assert.equal(result.status,7);assert.equal(fs.realpathSync(path.join(f.base,'current')),f.old);assert.match(result.stderr,/previous companion was restored/);const calls=fs.readFileSync(f.log,'utf8');assert.match(calls,/restart herdr-remote-companion.service/);assert.doesNotMatch(calls,/restart herdr-remote-session/);assert.equal(fs.readFileSync(path.join(f.home,'.local/share/herdr-remote/keys'),'utf8'),'preserve');assert.equal(fs.existsSync(path.join(f.base,'pending-previous')),false);
});
test('next install recovers an interrupted switch before trying dependencies',t=>{
 const f=upgradeFixture(t),broken=path.join(f.base,'releases/interrupted');fs.mkdirSync(broken);fs.unlinkSync(path.join(f.base,'current'));fs.symlinkSync(broken,path.join(f.base,'current'));fs.writeFileSync(path.join(f.base,'pending-previous'),f.old);
 const result=f.run({FAIL_NPM:'yes'});assert.equal(result.status,8);assert.equal(fs.realpathSync(path.join(f.base,'current')),f.old);assert.equal(fs.existsSync(path.join(f.base,'pending-previous')),false);
});
test('a concurrent installer fails before modifying the active release',async t=>{
 const {spawn}=await import('node:child_process'),{once}=await import('node:events'),f=upgradeFixture(t);const holder=spawn('flock',[path.join(f.base,'install.lock'),'sh','-c','echo locked; sleep 1'],{stdio:['ignore','pipe','ignore']});await once(holder.stdout,'data');
 const result=f.run({});assert.equal(result.status,1);assert.match(result.stderr,/Another companion installation/);assert.equal(fs.realpathSync(path.join(f.base,'current')),f.old);await once(holder,'exit');
});
test('setup checks the port it will serve: 8788 for a new config, the serve default when a config omits it',async t=>{
 const home=homeFixture(t),configPath=path.join(home,'config.json'),checked=[];
 const deps={home,configPath,detectSocket:async()=>'/custom/herdr.sock',checkSocket:async()=>true,checkPort:async port=>{checked.push(port);},verifyHerdr:async()=>{},
  fetchImpl:async()=>new Response(JSON.stringify({id:'test-laptop',relayToken:'r'.repeat(43),claimToken:'c'.repeat(43),url:'https://remote.example.com'}))};
 const fresh=await setupCompanion(['--portal','https://remote.example.com','--foreground','--no-pair'],deps);
 assert.equal(fresh.config.port,8788);
 const {port,...withoutPort}=JSON.parse(fs.readFileSync(configPath,'utf8'));fs.writeFileSync(configPath,JSON.stringify(withoutPort));
 const legacy=await setupCompanion(['--portal','https://remote.example.com','--foreground','--no-pair'],deps);
 assert.equal(legacy.config.port,8787);assert.deepEqual(checked,[8788,8787]);
});
