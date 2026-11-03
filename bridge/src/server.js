import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {BridgeError} from './herdr.js';
import {HerdrCore,defaultCoreSocket} from './herdr-core.js';
import {createCoreEvents} from './core-events.js';
import {createPaneStreams} from './pane-stream.js';
import {createPaneControl} from './pane-control.js';
import {Store} from './store.js';
import {Attachments} from './attachments.js';
import {createUpdateSource} from './updates.js';
import {PaneAttachments} from './pane-attachment.js';
import {createAuthenticator} from './auth.js';
import {requireAccess} from './access.js';
import {Operations} from './operations.js';
import {createPushMonitor} from './push.js';
import {createHtmlPreview} from './html-preview.js';
import {createUsageSource} from './usage.js';
import {Directories} from './directories.js';
import {createHistory} from './history.js';
import {Timeline} from './timeline.js';
import {PaneActivity} from './pane-activity.js';
import {associatedProject as projectFor} from './projects.js';
import {createLauncher} from './agent-launch.js';
import {createSocketFanout} from './socket-fanout.js';
import {createRequestHandler} from './routes.js';
import {createPaneRoutes} from './pane-routes.js';
import {reject,createRateLimiter} from './http-util.js';

export function createBridge(config, dependencies={}) {
  config={...config,homeDirectory:dependencies.homeDirectory??os.homedir()};
  const coreSocket=config.coreSocketPath||defaultCoreSocket();
  // Tests with a fake backend stay isolated from the real herdr-core socket.
  const coreEvents=dependencies.herdr&&!dependencies.coreEventsFactory?null
    :(dependencies.coreEventsFactory??createCoreEvents)(coreSocket,{onChange:()=>scheduleRefresh()});
  const herdr=dependencies.herdr ?? new HerdrCore(coreSocket,{events:coreEvents});
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
  const launcher=createLauncher({herdr,directories});
  const streams=createPaneStreams({core:herdr});
  const loadUpdate=createUpdateSource(dependencies.updateDir);
  let snapshotFlight;let snapshotInputDuringFlight=null;let lastGoodSnapshot=null;
  function acceptedInput(pane) {
    activity.acceptedInput(pane);
    snapshotInputDuringFlight?.add(pane.pane_id);
  }
  const associatedProject=cwd=>projectFor(config,cwd);
  function baseSnapshot() {
    // Structured question and model menus are gone: older apps read these as off.
    return {structuredHistoryEnabled:config.structuredHistory!==false,activityTimelineEnabled:timeline!==null,
      agentModelSelectionEnabled:false,modelSelectionAgents:[],codexModelSelectionEnabled:false,
      questionSelectionEnabled:false,terminalStreamEnabled:true,htmlPreviewEnabled:true,terminalSnapshotSource:'recent_unwrapped',terminalInputEnabled:true,
      terminalCreationEnabled:true,directoryBrowsingEnabled:directories.home!==null,usage:usage.get(),attachmentsEnabled:true,
      reviewEnabled:true,operationReceiptsEnabled:true,attachmentManagementEnabled:true,sessionRenameEnabled:true,
      desktopHandoffEnabled:true,sessionResumeSupported:false,hostname:os.hostname(),projects:config.projects.map(({id,label})=>({id,label})),
      allowTerminalInput:config.allowTerminalInput===true,canStartHerdr:config.allowHerdrStart===true,lastUpdatedAt:null,stale:false};
  }
  function snapshotPane(p,agents) {
    const lastActivity=activity.lastActivity(p);
    const cwd=p.foreground_cwd||p.cwd||'';
    const project=associatedProject(cwd);
    const title=p.label||agents.get(p.pane_id)?.name||p.title||p.terminal_title_stripped||p.display_kind||p.agent||'Terminal';
    return {projectId:project?.id??null,projectLabel:project?.label??null,id:p.pane_id,workspaceId:p.workspace_id,tabId:p.tab_id,
      title,cwd,kind:p.display_kind||p.agent||'terminal',status:p.agent_status||'unknown',lastActivity,revision:p.revision||0,
      activity:p.activity??null,progress:p.progress??null,blockedKind:p.blocked_kind??null,turn:p.turn??null,
      bindingGeneration:p.bindingGeneration??null,bindingVerification:p.bindingVerification??null,
      nativeTurnId:p.nativeTurnId??null,completionEligible:p.completionEligible===true,rawStatus:p.agent_status??'unknown'};
  }
  async function snapshot() {
    if(snapshotFlight) return snapshotFlight;
    const inputDuringFlight=new Set();
    snapshotInputDuringFlight=inputDuringFlight;
    snapshotFlight=(async()=>{
      const base=baseSnapshot();
      try {
        const {snapshot:raw}=await herdr.call('session.snapshot');
        if(raw.protocol!==22) throw new BridgeError('protocol_mismatch','Unsupported Herdr protocol; update the bridge after checking its schema.',503);
        const live=new Set(raw.panes.map(p=>p.pane_id));
        const agents=new Map((raw.agents||[]).map(a=>[a.pane_id,a]));
        activity.observe(raw.panes,inputDuringFlight);
        paneAttachments.prune(live);
        const workspaces=raw.workspaces.map(w=>({id:w.workspace_id,label:w.label||w.workspace_id}));
        // Keep even an empty successful result: a real empty snapshot must
        // clear an older session list rather than resurrecting it on outage.
        lastGoodSnapshot={...base,herdrOnline:true,panesComplete:true,lastUpdatedAt:new Date().toISOString(),workspaces,
          panes:raw.panes.map(p=>snapshotPane(p,agents))};
        return lastGoodSnapshot;
      } catch(e) {
        const error=e instanceof BridgeError?e.message:'Unable to read Herdr.';
        const canStartHerdr=base.canStartHerdr && e.code==='herdr_offline';
        if(lastGoodSnapshot) return {...lastGoodSnapshot,usage:base.usage,herdrOnline:false,panesComplete:false,canStartHerdr,stale:true,error};
        return {...base,canStartHerdr,herdrOnline:false,panesComplete:false,workspaces:[],panes:[],error};
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
  let last=''; let polling=false;let latestSnapshot=null;let lastPoll=0;let refreshTimer=null;
  let publicationErrorCount=0;
  let publication=Promise.resolve();
  const ctx={config,dependencies,store,herdr,history,timeline,directories,attachments,operations,push,htmlPreview,
    paneAttachments,launcher,streams,locks,loadUpdate,snapshot,pane,locked,auth,rate,scopedSnapshot,acceptedInput,associatedProject,
    refreshPublished:()=>refreshPublished(),publish:data=>publish(data),latest:()=>latestSnapshot,
    diagnostics:()=>({publicationErrorCount,push:push.diagnostics?.()??null})};
  ctx.paneControl=createPaneControl(ctx);
  ctx.paneRoutes=createPaneRoutes(ctx);
  const server=http.createServer(createRequestHandler(ctx));
  server.requestTimeout=300000; server.headersTimeout=10000; server.maxHeadersCount=30;
  // Direct phones watch a pane over their snapshot WebSocket: one subscription per socket.
  const watching=new Map();
  function unwatch(ws){const state=watching.get(ws);if(!state)return;clearInterval(state.timer);watching.delete(ws);streams.close(state.key);}
  async function socketMessage(ws,message) {
    const device=await authenticate(ws.token);
    if(!device){ws.close(4001,'Expired, revoked or disabled');return;}
    requireAccess(store,device,'read',config);
    if(message?.type==='unsubscribe'){unwatch(ws);return;}
    if(message?.type==='ack'){const state=watching.get(ws);
      if(state&&message.epoch===state.epoch&&Number.isSafeInteger(message.seq)&&message.seq<=state.sent)state.acked=Math.max(state.acked,message.seq);return;}
    if(message?.type!=='subscribe'||typeof message.paneId!=='string'||message.paneId.length>256)return;
    rate(`${device.deviceId}:stream`,300);
    unwatch(ws);
    const current=await pane(message.paneId);
    paneAttachments.validate(device.deviceId,current,message.attachmentId);
    const key=`ws:${ws.id}`;
    await streams.open(key,message.paneId);
    const state={key,paneId:message.paneId,epoch:null,sent:0,acked:0,busy:false};
    watching.set(ws,state);
    state.timer=setInterval(async()=>{
      if(state.busy||ws.readyState!==1)return;
      // The phone acknowledges what it rendered; stop sending past 256 KiB unacknowledged.
      if(state.epoch&&state.sent-state.acked>256*1024)return;
      state.busy=true;
      try {
        const out=await streams.read(key,{epoch:state.epoch,seq:state.sent,max:64*1024});
        if(out.reset){state.epoch=out.epoch;state.acked=0;}
        if(!out.data.length&&!out.reset)return;
        state.sent=out.nextSeq;
        ws.send(JSON.stringify({type:'pane-output',paneId:state.paneId,epoch:out.epoch,seq:out.seq,reset:out.reset,
          cols:out.cols,rows:out.rows,ended:out.ended,data:out.data.toString('base64')}));
      } catch {unwatch(ws);if(ws.readyState===1)ws.send(JSON.stringify({type:'pane-output',paneId:state.paneId,closed:true}));}
      finally {state.busy=false;}
    },100);
  }
  const sockets=createSocketFanout({server,store,config,authenticate,scopedSnapshot,latest:()=>latestSnapshot,
    authorizeUpgrade:async req=>{const {token,device}=await auth(req);rate(device.deviceId,240);return token;},
    onConnection:()=>{void refreshPublished(true).catch(()=>{});},
    onMessage:(ws,message)=>socketMessage(ws,message).catch(()=>{}),onSocketClose:ws=>unwatch(ws)});
  function publish(data,force=false) {
    try{const observed=push.observe(data);if(Array.isArray(observed?.panes))data=observed;}
    catch{publicationErrorCount++;data={...data,publicationError:'push_annotation_failed'};}
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
    lastPoll=Date.now();
    await publish(await snapshot(),force);
    return latestSnapshot;
  }
  // herdr-core fact changes republish at once; alert decisions use ordered turn events, not this debounce.
  function scheduleRefresh() {
    if(refreshTimer)return;
    refreshTimer=setTimeout(()=>{refreshTimer=null;void refreshPublished().catch(()=>{});},75);
    refreshTimer.unref?.();
  }
  const idle=()=>!timeline&&!push.enabled&&!push.tracking&&typeof dependencies.onSnapshot!=='function'&&sockets.size===0;
  // A safety net: every second without core events, every five seconds while they flow.
  const poll=setInterval(async()=>{
    if(polling||idle())return;
    if(coreEvents?.healthy&&Date.now()-lastPoll<5000)return;
    polling=true;
    try {await refreshPublished();}catch{}finally{polling=false;}
  },1000);poll.unref();
  server.on('close',()=>{usage.close();clearInterval(poll);clearTimeout(refreshTimer);coreEvents?.close();ctx.paneControl.close();streams.closeAll();sockets.close();try{push.close();}catch{}});
  return {server,store,snapshot,refresh:()=>refreshPublished(),close:()=>new Promise(resolve=>{sockets.terminateAll();server.close(resolve);})};
}
