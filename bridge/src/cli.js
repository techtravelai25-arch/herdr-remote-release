#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createBridge} from './server.js';
import {Store} from './store.js';
import {doctor,rollbackInstallation} from './lifecycle.js';
import {configurationPath} from './configuration.js';
import {setupCompanion,companionConfigPath,pairCompanion} from './companion.js';
import {startRelay} from './relay.js';
import {accessState,setRemoteEnabled,setDeviceMode,setAccountMode} from './access.js';
import {
  buildPairingPayload,
  normalizeHttpsOrigin,
  pairingInstructions,
  preparePairing,
  renderPairingQr,
} from './pairing.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = configurationPath({root});

function readConfig() {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    throw new Error('Create bridge/config.json from config.example.json or set HERDR_REMOTE_CONFIG.');
  }
  config.stateDir = path.resolve(path.dirname(configPath), config.stateDir || '.state');
  if (
    !path.isAbsolute(config.socketPath || '') ||
    !Array.isArray(config.projects) ||
    config.projects.some(project => typeof project.id !== 'string' || typeof project.label !== 'string' || !path.isAbsolute(project.path || '')) ||
    new Set(config.projects.map(project => project.id)).size !== config.projects.length
  ) {
    throw new Error('Invalid local bridge configuration.');
  }
  return config;
}

function parsePairArgs(args) {
  let url;
  let manual = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--manual') {
      manual = true;
    } else if (arg === '--url') {
      url = args[++index];
      if (!url) throw new Error('--url requires an HTTPS origin.');
    } else {
      throw new Error(`Unknown pair option: ${arg}`);
    }
  }
  return {url, manual};
}

async function pair(config, store, args) {
  const options = parsePairArgs(args);
  // Validate explicit/configured origins before starting a local unit.
  if (options.url !== undefined) normalizeHttpsOrigin(options.url);
  if (options.url === undefined && config.publicUrl !== undefined && String(config.publicUrl).trim() !== '') {
    normalizeHttpsOrigin(String(config.publicUrl));
  }
  const origin = await preparePairing(config, {
    url: options.url,
    onProgress: message => process.stderr.write(`Herdr Remote: ${message}\n`),
  });

  // Generate the one-use code only after the local bridge and selected public
  // endpoint are ready, so a failed readiness check never advertises a code.
  const details = store.pairCodeDetails();
  const payload = buildPairingPayload(origin, details.code, details.expires);
  const rendered = await renderPairingQr(payload, {manual: options.manual});

  process.stdout.write('\nHerdr Remote pairing\n\n');
  if (rendered.qr) {
    // Preserve trailing quiet-zone spaces so the terminal renderer does not
    // collapse the right edge of the QR code.
    process.stdout.write(`${rendered.qr}\n\n`);
  }
  process.stdout.write(`${pairingInstructions({origin, code: details.code, expires: details.expires, manual: rendered.manual})}\n`);
  if (rendered.qr) process.stdout.write('Keep the full QR visible and the terminal wide enough to avoid wrapping; enlarge it if needed. Run herdr-remote pair again for a fresh code.\n');
}

async function main() {
  const [command = 'serve', ...args] = process.argv.slice(2);
  let setup;
  if(command==='setup'){setup=await setupCompanion(args,{configPath:process.env.HERDR_REMOTE_CONFIG||companionConfigPath()});if(!setup.foreground)return;}
  if(command==='rollback'){const base=process.env.HERDR_REMOTE_INSTALL_ROOT;if(!base)throw Error('Rollback is available for managed installations only.');rollbackInstallation(base);console.log('Restored the previous companion. Herdr sessions and device keys were preserved.');return;}
  if(command==='update'){
    if(args.length)throw Error('Usage: herdr-remote update');
    const base=process.env.HERDR_REMOTE_INSTALL_ROOT;
    if(!base||!path.isAbsolute(base))throw Error('Update is available for managed installations only.');
    const script=path.join(base,'current','update.sh');
    if(!fs.existsSync(script))throw Error('The managed update script is unavailable.');
    const result=spawnSync('bash',[script],{stdio:'inherit',env:process.env});
    if(result.error)throw result.error;
    if(result.status!==0)process.exitCode=result.status||1;
    return;
  }
  const config = setup?.config||readConfig();
  const store = setup?.store||new Store(config.stateDir);

  if(command==='access'){
    const [action,deviceId,mode]=args;
    if(action==='disable'&&args.length===1)setRemoteEnabled(store,false);
    else if(action==='enable'&&args.length===1)setRemoteEnabled(store,true);
    else if(action==='account'&&args.length===3)setAccountMode(store,deviceId,mode);
    else if(action==='set'&&args.length===3){
      if(!store.read('devices.json',[]).some(device=>device.deviceId===deviceId))throw Error('Unknown paired device ID.');
      setDeviceMode(store,deviceId,mode);
    }else if(action!=='status'||args.length!==1)throw Error('Usage: herdr-remote access status|disable|enable|set DEVICE_ID MODE|account EMAIL MODE (observer|normal|terminal)');
    const state=accessState(store);
    console.log(JSON.stringify({remoteEnabled:state.enabled,devices:store.read('devices.json',[]).map(({deviceId,deviceName})=>({deviceId,deviceName,mode:state.devices[deviceId]||'normal'})),accounts:state.accounts,terminalInputAllowedByConfig:config.allowTerminalInput===true},null,2));
    return;
  }

  if(command==='doctor'||command==='status'){const status=await doctor(config,store,{releaseRoot:root,wait:args.includes('--wait')});console.log(JSON.stringify(status));if(!status.localReady)process.exitCode=1;return;}
  if(command==='support'){
    if(args.length)throw Error('Usage: herdr-remote support');
    const health=await doctor(config,store,{releaseRoot:root});
    const access=accessState(store);
    const modes=store.read('devices.json',[]).map(device=>access.devices[device.deviceId]||'normal');
    const packageInfo=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
    console.log(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),bridgeVersion:packageInfo.version,localReady:health.localReady,relayConnected:health.relayConnected,sessionOwnership:health.sessionOwnership,remoteEnabled:access.enabled,pairedDeviceCount:modes.length,deviceModes:{observer:modes.filter(mode=>mode==='observer').length,normal:modes.filter(mode=>mode==='normal').length,terminal:modes.filter(mode=>mode==='terminal').length},terminalInputAllowedByConfig:config.allowTerminalInput===true,herdrStartAllowedByConfig:config.allowHerdrStart===true},null,2));
    return;
  }
  if (command === 'pair') {
    if(!accessState(store).enabled)throw Error('Remote control is disabled on this laptop. Run access enable before pairing.');
    if(config.relay)await pairCompanion(config,store);else await pair(config, store, args);
  } else if (command === 'devices') {
    console.log(JSON.stringify(store.read('devices.json', []).map(({deviceId, deviceName, createdAt}) => ({deviceId, deviceName, createdAt})), null, 2));
  } else if (command === 'revoke' && args[0]) {
    store.revoke(args[0]);
    console.log('Device revoked.');
  } else if (command === 'serve'||setup?.foreground) {
    const port = config.port ?? 8787;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
    const app = createBridge(config, {store});
    let relay,connected=false,statusTimer;
    const updateStatus=()=>store.write('relay-status.json',{connected,updatedAt:Date.now()});
    app.server.listen(port, '127.0.0.1', () => {
      store.write('bridge-status.json',{ready:true,pid:process.pid,port,releaseRoot:fs.realpathSync(root)});
      console.log(`Herdr Remote listening on http://127.0.0.1:${port}`);
      if(config.relay){const identity=store.read('relay-identity.json',null);if(!identity)throw Error('Run setup first.');relay=startRelay({identity,port,store,onStatus:value=>{connected=value;updateStatus();}});statusTimer=setInterval(updateStatus,5000);statusTimer.unref();if(setup?.foreground)pairCompanion(config,store).catch(error=>console.error(error.message));}
    });
    app.server.on('error', error => {
      console.error(error.message);
      process.exitCode = 1;
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
      store.write('bridge-status.json',{ready:false,pid:process.pid,port});clearInterval(statusTimer);relay?.stop();await app.close();
      process.exit(0);
    });
  } else {
    throw new Error('Usage: herdr-remote setup [--foreground]|serve|pair [--url HTTPS_ORIGIN] [--manual]|devices|revoke DEVICE_ID|doctor|support|update|access status|disable|enable|set DEVICE_ID observer|normal|terminal');
  }
}

main().catch(error => {
  console.error(`Herdr Remote: ${error.message}`);
  process.exitCode = 1;
});
