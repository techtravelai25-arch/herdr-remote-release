import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {execFileSync,execFile} from 'node:child_process';
import {generateIdentity} from './relay.js';
import {normalizeHttpsOrigin,renderPairingQr} from './pairing.js';
import {Store} from './store.js';
import {Herdr} from './herdr.js';
import {defaultSessionOwner,assertPortAvailable} from './lifecycle.js';
import {routingCapabilities} from './routing-capabilities.js';
import {DEFAULT_PORT,MANAGED_PORT} from './configuration.js';
export const DEFAULT_PORTAL='';
export const companionConfigPath=()=>path.join(os.homedir(),'.config/herdr-remote/config.json');
const writePrivate=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.chmodSync(tmp,0o600);fs.renameSync(tmp,file);};
const unitQuote=s=>'"'+s.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%')+'"';
export async function socketIsLive(file){return new Promise(resolve=>{const socket=net.connect(file);const done=value=>{socket.destroy();resolve(value);};socket.once('connect',()=>done(true));socket.once('error',()=>done(false));socket.setTimeout(500,()=>done(false));});}
export async function detectHerdrSocket({home=os.homedir(),explicit=process.env.HERDR_SOCKET}={}){
  if(explicit){if(!path.isAbsolute(explicit))throw Error('HERDR_SOCKET must be an absolute path');return explicit;}
  const root=path.join(home,'.config/herdr'),candidates=[path.join(root,'herdr.sock')];
  try{for(const name of fs.readdirSync(path.join(root,'sessions')))candidates.push(path.join(root,'sessions',name,'herdr.sock'));}catch{}
  const live=[];for(const file of candidates){if(!fs.existsSync(file))continue;const ready=await socketIsLive(file);if(ready)live.push(file);}
  if(live.length>1)throw Error('Several Herdr sessions are running. Choose one with HERDR_SOCKET=/absolute/session/herdr.sock herdr-remote setup.');
  return live[0]||candidates[0];
}
export async function verifyHerdrProtocol(socketPath,{client=new Herdr(socketPath),timeoutMs=15000,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  const deadline=Date.now()+timeoutMs;let lastError;
  do{try{const result=await client.call('session.snapshot',{},1500);if(result.snapshot?.protocol!==22)throw Error(`Herdr session protocol ${result.snapshot?.protocol??'unknown'} is unsupported. Herdr Remote requires protocol 22 (Herdr 0.9.0). Update Herdr if needed, save your work, and restart that Herdr session yourself before retrying setup.`);return;}catch(error){if(!['herdr_offline','herdr_timeout','herdr_disconnected'].includes(error.code))throw error;lastError=error;}await sleep(250);}while(Date.now()<deadline);
  throw Error(`Herdr did not become ready. Check the selected session and rerun setup. ${lastError?.message||''}`);
}
export async function setupCompanion(args,{configPath=companionConfigPath(),fetchImpl=fetch,home=os.homedir(),exec=execFileSync,pair=pairCompanion,checkSocket=socketIsLive,detectSocket=detectHerdrSocket,verifyHerdr=verifyHerdrProtocol,sessionOwner=()=>defaultSessionOwner(exec),checkPort=assertPortAvailable}={}){
  let portal=process.env.HERDR_REMOTE_PORTAL_ORIGIN||DEFAULT_PORTAL,portalExplicit=false,foreground=false,noPair=false;for(let i=0;i<args.length;i++){if(args[i]==='--portal'){portal=normalizeHttpsOrigin(args[++i]);portalExplicit=true;}else if(args[i]==='--foreground')foreground=true;else if(args[i]==='--no-pair')noPair=true;else throw Error(`Unknown setup option: ${args[i]}`);}
  if(process.platform!=='linux'&&!foreground)throw Error('Automatic startup currently supports Linux. Use setup --foreground on other systems.');
  let config;if(fs.existsSync(configPath))config=JSON.parse(fs.readFileSync(configPath));
  else config={port:MANAGED_PORT,socketPath:await detectSocket({home}),stateDir:path.join(home,'.local/share/herdr-remote'),projects:[{id:'home',label:'Home',path:home}],allowTerminalInput:false,allowHerdrStart:false};
  if(process.env.HERDR_SOCKET)config.socketPath=await detectSocket({home,explicit:process.env.HERDR_SOCKET});
  if(!path.isAbsolute(config.socketPath||''))throw Error('The configured Herdr socket must be an absolute path.');
  // A config without a port is served on the CLI default; check that port.
  config.port??=DEFAULT_PORT;
  config.stateDir=path.resolve(path.dirname(configPath),config.stateDir||'.state');const store=new Store(config.stateDir);
  // Allow the already-running companion to keep its port during an upgrade.
  const active=store.read('bridge-status.json',null);let ownPort=false;
  if(active?.ready&&active.port===config.port&&active.pid)try{process.kill(active.pid,0);ownPort=true;}catch{}
  if(!ownPort)await checkPort(config.port);
  let identity=store.read('relay-identity.json',null);
  if(!portal)portal=identity?.url;
  if(!portal)throw Error('Relay setup requires --portal HTTPS_ORIGIN. For direct HTTPS pairing, run ops/setup.py and then herdr-remote pair.');
  portal=normalizeHttpsOrigin(portal);
  if(identity&&portalExplicit&&normalizeHttpsOrigin(identity.url)!==portal)
    throw Error(`This laptop is already registered with ${identity.url}. Reinstall using that server to keep its pairing; switching servers requires a new companion identity and fresh phone pairing.`);
  if(!identity){
    console.log('Registering this laptop securely…');
    const keys=store.read('relay-key.json',null)||generateIdentity();store.write('relay-key.json',keys);
    const res=await fetchImpl(`${portal}/v1/laptops/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label:os.hostname(),publicKey:keys.publicKey}),redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!res.ok)throw Error(`Laptop registration failed (${res.status}). Please retry setup.`);
    const data=await res.json();if(typeof data.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(data.id)||typeof data.relayToken!=='string'||typeof data.claimToken!=='string'||normalizeHttpsOrigin(data.url)!==portal)throw Error('Invalid registration response');
    identity={...keys,id:data.id,relayToken:data.relayToken,claimToken:data.claimToken,url:portal};store.write('relay-identity.json',identity);
  }
  // Push is an operator choice; setup preserves explicit push configuration.
  config.relay=true;writePrivate(configPath,config);
  if(foreground){if(await checkSocket(config.socketPath))await verifyHerdr(config.socketPath);return {config,store,foreground:true};}
  const unitDir=path.join(home,'.config/systemd/user');fs.mkdirSync(unitDir,{recursive:true});
  const servicePath=[path.join(home,'.local/bin'),path.join(home,'.opencode/bin'),process.env.PATH||'/usr/local/bin:/usr/bin:/bin'].join(path.delimiter);
  const installRoot=process.env.HERDR_REMOTE_INSTALL_ROOT;
  const cli=installRoot?path.join(installRoot,'current/bridge/src/cli.js'):path.join(path.dirname(fileURLToPath(import.meta.url)),'cli.js');
  // Record ownership independently from liveness. A live manual default session
  // needs startup at the next login, but must never be restarted during setup.
  if(config.socketPath===path.join(home,'.config/herdr/herdr.sock')){
    const owner=sessionOwner();config.sessionOwnership=owner;
    if(owner.kind==='unknown')throw Error('Could not inspect Herdr startup ownership. Check the systemd user session and retry.');
    if(owner.kind!=='external'){
      const herdr=servicePath.split(path.delimiter).map(dir=>path.join(dir,'herdr')).find(file=>{try{fs.accessSync(file,fs.constants.X_OK);return fs.statSync(file).isFile();}catch{return false;}});if(!herdr)throw Error('Herdr is missing. Run the companion installer first.');
      const herdrUnit=`[Unit]\nDescription=Herdr companion session\n\n[Service]\nExecStart=${unitQuote(herdr)} server\nEnvironment=${unitQuote('PATH='+servicePath)}\nWorkingDirectory=${unitQuote(home)}\nRestart=on-failure\nRestartSec=3\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
      fs.writeFileSync(path.join(unitDir,'herdr-remote-session.service'),herdrUnit,{mode:0o600});
      exec('systemctl',['--user','daemon-reload'],{stdio:'inherit'});
      const live=await checkSocket(config.socketPath);
      exec('systemctl',['--user','enable',...(!live?['--now']:[]),'herdr-remote-session.service'],{stdio:'inherit'});
      config.sessionOwnership={kind:'companion',unit:'herdr-remote-session.service'};
    }
  }else{config.sessionOwnership={kind:'manual-custom'};console.log('Your custom Herdr session keeps its existing startup configuration. It must be running to use the phone.');}
  writePrivate(configPath,config);
  await verifyHerdr(config.socketPath);
  const content=`[Unit]\nDescription=Herdr Remote encrypted companion\nAfter=network-online.target\n\n[Service]\nExecStart=${unitQuote(process.execPath)} ${unitQuote(cli)} serve\nEnvironment=${unitQuote('HERDR_REMOTE_CONFIG='+configPath)}\nEnvironment=${unitQuote('PATH='+servicePath)}\nRestart=on-failure\nRestartSec=3\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  fs.writeFileSync(path.join(unitDir,'herdr-remote-companion.service'),content,{mode:0o600});
  exec('systemctl',['--user','daemon-reload'],{stdio:'inherit'});exec('systemctl',['--user','enable','herdr-remote-companion.service'],{stdio:'inherit'});
  store.write('relay-status.json',{connected:false,updatedAt:Date.now()});
  exec('systemctl',['--user','restart','herdr-remote-companion.service'],{stdio:'inherit'});
  if(!noPair)await pair(config,store);
  return {config,store,foreground:false};
}
export async function pairCompanion(config,store){
  const identity=store.read('relay-identity.json',null);if(!identity)throw Error('Run herdr-remote setup first.');
  const deadline=Date.now()+35000;let ready=false;
  while(Date.now()<deadline){const status=store.read('relay-status.json',null);if(status?.connected&&Date.now()-status.updatedAt<15000){ready=true;break;}await new Promise(r=>setTimeout(r,300));}
  if(!ready)throw Error('The companion is not connected yet. Check systemctl --user status herdr-remote-companion, then run herdr-remote pair.');
  const details=store.pairCodeDetails(),routing=routingCapabilities(store),bootstrap=routing.create('bootstrap',{expires:details.expires});
  await routing.acknowledged(bootstrap.capability.id);
  const payload=JSON.stringify({type:'herdr-remote',version:3,url:identity.url,laptopId:identity.id,publicKey:identity.publicKey,...details,routingToken:bootstrap.token,routingExpires:details.expires});
  const rendered=await renderPairingQr(payload);
  console.log('\nOpen Herdr Remote on your phone and scan this QR. It expires in 5 minutes.\n');
  if(rendered.qr)console.log(rendered.qr);else {const file=path.join(config.stateDir,'pairing-qr.svg');const {default:QRCode}=await import('qrcode');fs.writeFileSync(file,await QRCode.toString(payload,{type:'svg',margin:4}),{mode:0o600});console.log(`Your terminal is too narrow. Open the private QR image: ${file}`);if(process.platform==='linux'&&(process.env.DISPLAY||process.env.WAYLAND_DISPLAY))execFile('xdg-open',[file],()=>{});}
  if(!fs.existsSync(config.socketPath))console.log('Connection ready. Start Herdr on this laptop to see your sessions.');
}
