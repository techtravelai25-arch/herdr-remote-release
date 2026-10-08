import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {Herdr, BridgeError} from './herdr.js';
import {Store} from './store.js';
import {Attachments} from './attachments.js';
import {createUpdateSource} from './updates.js';
import {modelSelectionAgents} from './agent-model.js';
import {PaneAttachments} from './pane-attachment.js';
import {createAuthenticator} from './auth.js';
import {requireAccess} from './access.js';
import {Operations} from './operations.js';
import {createPushMonitor} from './push.js';
import {createHtmlPreview} from './html-preview.js';
import {createStatusEvents} from './status-events.js';
import {createUsageSource} from './usage.js';
import {Directories} from './directories.js';
import {createHistory} from './history.js';
import {Timeline} from './timeline.js';
import {PaneActivity} from './pane-activity.js';
import {associatedProject as projectFor} from './projects.js';
import {createPaneMenus} from './pane-menus.js';
import {createLauncher} from './agent-launch.js';
import {createSocketFanout} from './socket-fanout.js';
import {createRequestHandler} from './routes.js';
import {createPaneRoutes} from './pane-routes.js';
import {reject,createRateLimiter} from './http-util.js';

export function createBridge(config, dependencies={}) {
  config={...config,homeDirectory:dependencies.homeDirectory??os.homedir()};
  const herdr=dependencies.herdr ?? new Herdr(config.socketPath);
  const store=dependencies.store ?? new Store(config.stateDir);
  const history=createHistory(config);
  const timeline=config.activityTimeline===false?null:new Timeline(store);
  const directories=new Directories(config.homeDirectory,store);
  const authenticate=createAuthenticator(store,config.portalAuth);
  const attachments=new Attachments(config,store);
  const operations=new Operations(store);
  const push=dependencies.push ?? createPushMonitor(config,store);
  // Fake Herdr fixtures must not spawn the user's real Codex CLI.
  const usage=dependencies.usage ?? createUsageSource(dependencies.herdr
    ?{read:()=>({promise:Promise.reject(new Error('Test fixture'))}),homeDirectory:dependencies.homeDirectory??path.join(os.tmpdir(),'herdr-no-claude-home')}
    :{homeDirectory:config.homeDirectory});
  const activity=new PaneActivity(store); const paneAttachments=new PaneAttachments(); const locks=new Set();
  const htmlPreview=createHtmlPreview({config,bridgePort:()=>server.address()?.port||config.port||0,
    fetchImpl:dependencies.previewFetch||fetch});
  const menus=createPaneMenus({herdr,store});
  const launcher=createLauncher({herdr,directories});
  const loadUpdate=createUpdateSource(dependencies.updateDir);
  let snapshotFlight;let snapshotInputDuringFlight=null;let snapshotStartedAtSequence=0;let statusSequence=0;let lastGoodSnapshot=null;
  const statusOverrides=new Map();
  function acceptedInput(pane) {
    activity.acceptedInput(pane);
    snapshotInputDuringFlight?.add(pane.pane_id);
  }
  const associatedProject=cwd=>projectFor(config,cwd);
  function baseSnapshot() {
    return {structuredHistoryEnabled:config.structuredHistory!==false,activityTimelineEnabled:timeline!==null,
      agentModelSelectionEnabled:true,modelSelectionAgents:[...modelSelectionAgents],codexModelSelectionEnabled:modelSelectionAgents.includes('codex'),
      questionSelectionEnabled:true,htmlPreviewEnabled:true,terminalSnapshotSource:'recent_unwrapped',terminalInputEnabled:true,
      terminalCreationEnabled:true,directoryBrowsingEnabled:directories.home!==null,usage:usage.get(),attachmentsEnabled:true,
      reviewEnabled:true,operationReceiptsEnabled:true,attachmentManagementEnabled:true,sessionRenameEnabled:true,
      desktopHandoffEnabled:true,sessionResumeSupported:false,hostname:os.hostname(),projects:config.projects.map(({id,label})=>({id,label})),
      allowTerminalInput:config.allowTerminalInput===true,canStartHerdr:config.allowHerdrStart===true,lastUpdatedAt:null,stale:false};
  }
  function snapshotPane(p,agents) {
    const lastActivity=activity.lastActivity(p);
    const cwd=p.foreground_cwd||p.cwd||'';
    const project=associatedProject(cwd);
    const title=p.label||agents.get(p.pane_id)?.name||p.title||p.terminal_title_stripped||p.agent||'Terminal';
    return {projectId:project?.id??null,projectLabel:project?.label??null,id:p.pane_id,workspaceId:p.workspace_id,tabId:p.tab_id,
      title,cwd,kind:p.agent||'terminal',status:p.agent_status||'unknown',lastActivity,revision:p.revision||0};
  }
  async function snapshot() {
    if(snapshotFlight) return snapshotFlight;
    snapshotStartedAtSequence=statusSequence;
    const inputDuringFlight=new Set();
    snapshotInputDuringFlight=inputDuringFlight;
    snapshotFlight=(async()=>{
      const base=baseSnapshot();
      try {
        const {snapshot:raw}=await herdr.call('session.snapshot');
        if(raw.protocol!==22) throw new BridgeError('protocol_mismatch','Unsupported Herdr protocol; update the bridge after checking its schema.',503);
        const live=new Set(raw.panes.map(p=>p.pane_id));
        const agents=new Map((raw.agents||[]).map(a=>[a.pane_id,a]));
        const newer=new Set([...statusOverrides].filter(([,event])=>event.sequence>snapshotStartedAtSequence).map(([id])=>id));
        for(const id of inputDuringFlight)newer.add(id);
        activity.observe(raw.panes,newer);
        paneAttachments.prune(live);
        menus.prune(live);
        const workspaces=raw.workspaces.map(w=>({id:w.workspace_id,label:w.label||w.workspace_id}));
        const result={...base,herdrOnline:true,lastUpdatedAt:new Date().toISOString(),workspaces,panes:raw.panes.map(p=>snapshotPane(p,agents))};
        // Keep even an empty successful result: a real empty snapshot must
        // clear an older session list rather than resurrecting it on outage.
        lastGoodSnapshot=result;
        return result;
      } catch(e) {
        const error=e instanceof BridgeError?e.message:'Unable to read Herdr.';
        const canStartHerdr=base.canStartHerdr && e.code==='herdr_offline';
        if(lastGoodSnapshot) return {...lastGoodSnapshot,usage:base.usage,herdrOnline:false,canStartHerdr,stale:true,error};
        return {...base,canStartHerdr,herdrOnline:false,workspaces:[],panes:[],error};
      }
    })();
    try{return await snapshotFlight;} finally {snapshotFlight=null;snapshotInputDuringFlight=null;}
  }
  async function pane(id) {
    const result=await herdr.call('pane.get',{pane_id:id});
    if(!result?.pane || result.pane.pane_id!==id) reject('pane_changed','The requested pane is unavailable. Refresh the session list.',409);
    return result.pane;
  }
  async function locked(id, action) {
    if(locks.has(id)) reject('busy','Another operation is in progress for this pane.',409);
    locks.add(id); try{return await action();}finally{locks.delete(id);}
  }
  async function auth(req) {
    const header=req.headers.authorization;
    if(!header?.startsWith('Bearer ')) reject('unauthorized','Sign in or pair this device first.',401);
    const token=header.slice(7); const device=await authenticate(token);
    if(!device) reject('unauthorized','Device credential is invalid, expired or revoked.',401);
    requireAccess(store,device,'read',config); return {token,device};
  }
  function scopedSnapshot(data,device) {
    const permissionMode=requireAccess(store,device,'read',config);
    const canControl=permissionMode!=='observer';
    return {...data,permissionMode,canControl,allowTerminalInput:data.allowTerminalInput===true&&permissionMode==='terminal',
      canStartHerdr:data.canStartHerdr===true&&canControl,terminalCreationEnabled:data.terminalCreationEnabled===true&&canControl};
  }
  const rate=createRateLimiter();
  let last=''; let polling=false;let latestSnapshot=null;
  let publication=Promise.resolve();
  const ctx={config,dependencies,store,herdr,history,timeline,directories,attachments,operations,push,htmlPreview,menus,
    paneAttachments,launcher,locks,loadUpdate,snapshot,pane,locked,auth,rate,scopedSnapshot,acceptedInput,associatedProject,
    refreshPublished:()=>refreshPublished(),publish:data=>publish(data),latest:()=>latestSnapshot};
  ctx.paneRoutes=createPaneRoutes(ctx);
  const server=http.createServer(createRequestHandler(ctx));
  server.requestTimeout=300000; server.headersTimeout=10000; server.maxHeadersCount=30;
  const sockets=createSocketFanout({server,store,config,authenticate,scopedSnapshot,latest:()=>latestSnapshot,
    authorizeUpgrade:async req=>{const {token,device}=await auth(req);rate(device.deviceId,240);return token;},
    onConnection:()=>{void refreshPublished(true).catch(()=>{});}});
  function publish(data,force=false) {
    try{const observed=push.observe(data);if(Array.isArray(observed?.panes))data=observed;}catch{}
    latestSnapshot=data;
    try{timeline?.observe(data);}catch{}
    if(typeof dependencies.onSnapshot==='function')Promise.resolve().then(()=>dependencies.onSnapshot(data)).catch(()=>{});
    // Freshness changes on every successful poll, but should not itself
    // produce a websocket event when the session data is unchanged.
    const semantic=JSON.stringify({type:'snapshot',data:{...data,lastUpdatedAt:null}});
    if(!force&&semantic===last)return publication;
    last=semantic;
    publication=publication.catch(()=>{}).then(()=>sockets.broadcast(data));
    return publication;
  }
  async function refreshPublished(force=false) {
    // A shared RPC may have started before this reconciliation call.
    const before=snapshotFlight?snapshotStartedAtSequence:statusSequence;
    let data=await snapshot();
    // An event arriving during an RPC must not be overwritten by its older snapshot.
    if(data.herdrOnline)data={...data,panes:data.panes.map(p=>{const event=statusOverrides.get(p.id);return event&&event.sequence>before?{...p,status:event.status}:p;})};
    if(data.herdrOnline) lastGoodSnapshot=data;
    const live=new Set(data.panes.map(p=>p.id));
    for(const id of statusOverrides.keys())if(!live.has(id))statusOverrides.delete(id);
    await publish(data,force);
    statusEvents?.update(data.herdrOnline?data.panes.filter(p=>p.kind!=='terminal'):[]);
    return latestSnapshot;
  }
  // Tests with a fake RPC implementation stay isolated from the real local socket.
  const statusEvents=dependencies.herdr&&!dependencies.statusEventsFactory?null:(dependencies.statusEventsFactory??createStatusEvents)(config.socketPath,{
    onReady:()=>refreshPublished(),
    onStatus:event=>{
      if(!latestSnapshot?.herdrOnline||!latestSnapshot.panes.some(p=>p.id===event.pane_id))return;
      statusOverrides.set(event.pane_id,{sequence:++statusSequence,status:event.agent_status});
      const lastActivity=activity.status(event.pane_id,event.agent_status);
      const updated={...latestSnapshot,panes:latestSnapshot.panes.map(p=>p.id===event.pane_id?{...p,status:event.agent_status,lastActivity}:p)};
      // Events are authoritative too. Keep the outage fallback from reverting
      // a status that arrived after the last session.snapshot RPC.
      lastGoodSnapshot=updated;
      return publish(updated);
    }
  });
  const idle=()=>!timeline&&!push.enabled&&!push.tracking&&typeof dependencies.onSnapshot!=='function'&&sockets.size===0;
  const poll=setInterval(async()=>{
    if(polling)return;
    if(idle()){statusEvents?.update([]);return;}
    polling=true;
    try {await refreshPublished();}catch{}finally{polling=false;}
  },1000);poll.unref();
  server.on('close',()=>{usage.close();clearInterval(poll);statusEvents?.close();sockets.close();try{push.close();}catch{}});
  return {server,store,snapshot,close:()=>new Promise(resolve=>{sockets.terminateAll();server.close(resolve);})};
}
