import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {rollbackCompatible} from './upgrade-guard.js';
import {execFileSync} from 'node:child_process';
export async function assertPortAvailable(port,{host='127.0.0.1'}={}){
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Configure a bridge port between 1024 and 65535.');
  await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',()=>reject(Error(`Port ${port} is already in use. Choose a different companion port; the existing service was left running.`)));server.listen(port,host,()=>server.close(resolve));});
}
export function localReadiness(config,store,{releaseRoot}={}){
  const status=store.read('bridge-status.json',null);let alive=false;if(status?.pid)try{process.kill(status.pid,0);alive=true;}catch{}
  const rootMatches=!releaseRoot||status?.releaseRoot===fs.realpathSync(releaseRoot);
  const ownership=config.sessionOwnership?.kind;
  const sessionOwnership=['herdr-core','companion','external','manual','manual-custom'].includes(ownership)?ownership:'unknown';
  return {localReady:!!(status?.ready&&alive&&rootMatches&&status.port===(config.port??8787)),relayConnected:!!(store.read('relay-status.json',null)?.connected&&Date.now()-store.read('relay-status.json',{}).updatedAt<15000),sessionOwnership};
}
export async function doctor(config,store,{releaseRoot,wait=false}={}){
  const deadline=Date.now()+(wait?15000:0);let status;
  do{status=localReadiness(config,store,{releaseRoot});if(status.localReady||!wait)break;await new Promise(r=>setTimeout(r,250));}while(Date.now()<deadline);
  return status;
}
export function rollbackInstallation(base,{exec=execFileSync,configPath=process.env.HERDR_REMOTE_CONFIG}={}){
  const previous=fs.readFileSync(path.join(base,'previous'),'utf8').trim(),canonical=fs.realpathSync(previous),root=fs.realpathSync(base);
  if(!canonical.startsWith(root+'/releases/')&&canonical!==root)throw Error('The previous installation is not a managed release.');
  if(!fs.existsSync(path.join(canonical,'bridge/src/cli.js')))throw Error('The previous release is unavailable.');
  if(configPath&&!rollbackCompatible(configPath,canonical))throw Error('Rollback would remove required relay capability checks. Keep the relay offline and reinstall a capability-aware companion; keys and Herdr sessions are preserved.');
  const current=path.join(base,'current'),old=fs.realpathSync(current),tmp=current+'.rollback';fs.rmSync(tmp,{force:true});fs.symlinkSync(canonical,tmp);fs.renameSync(tmp,current);
  fs.writeFileSync(path.join(base,'previous'),old,{mode:0o600});exec('systemctl',['--user','restart','herdr-remote-companion.service'],{stdio:'inherit'});
}
