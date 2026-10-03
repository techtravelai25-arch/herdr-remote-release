import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {stripVTControlCharacters} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {WebSocketServer, WebSocket} from 'ws';
import {Herdr, BridgeError} from './herdr.js';
import {Store} from './store.js';
import {Attachments} from './attachments.js';
import {createUpdateSource} from './updates.js';
import {ensureHerdrRunning} from './start-herdr.js';
import {promptAgent} from './prompt-agent.js';
import {readAgentModelMenu,openAgentModelMenu,actAgentModelMenu,keyAgentModelMenu,modelSelectionAgents} from './agent-model.js';
import {PaneAttachments, paneIdentity} from './pane-attachment.js';
import {createAuthenticator} from './auth.js';
import {requireAccess} from './access.js';
import {Operations, operationInput} from './operations.js';
import {reviewProject} from './review.js';
import {createPushMonitor} from './push.js';
import {openProjectArtifact, listProjectFiles} from './artifacts.js';
import {createStatusEvents} from './status-events.js';
import {createUsageSource} from './usage.js';
import {Directories} from './directories.js';
import {createHistory} from './history.js';
import {Timeline} from './timeline.js';
import {PaneActivity} from './pane-activity.js';
import {boundedOutput} from './response-budget.js';
import {readCodexQuestionScreen,revealCodexQuestion,actCodexQuestion,questionFingerprint,questionSemantic,questionId} from './codex-question.js';
import {associatedProject as projectFor,canonicalDirectory} from './projects.js';
import {readJsonBody as body} from './request-body.js';
const kinds = new Set(['codex','claude','opencode']);
const keys = new Set(['enter','esc','tab','up','down','left','right','ctrl+c','alt+up']);
const text = (value, max, label) => { if(typeof value!=='string' || !value.trim() || value.length>max) throw new BridgeError('invalid_input',`Invalid ${label}.`); return value; };
const reject = (code, message, status=400) => { throw new BridgeError(code,message,status); };

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
  const usage=dependencies.usage ?? createUsageSource(dependencies.herdr?{read:()=>({promise:Promise.reject(new Error('Test fixture'))})}:{});
  const activity=new PaneActivity(store); const paneAttachments=new PaneAttachments(); const locks=new Set();
  // Model-menu recognition is scoped to an explicit picker request. Codex
  // question recognition separately reads the current visible screen only;
  // neither passive read sends input.
  const modelMenuRequests=new Map();
  const modelMenuKey=(deviceId,paneId)=>JSON.stringify([deviceId,paneId]);
  // Each device may act only on the current question it actually saw. A
  // dispatched key retires that exact generation even if the old frame lingers.
  const questionRequests=new Map();
  const questionReveals=new Map();
  const retiredKey=id=>createHash('sha256').update(id).digest('hex');
  const identityHash=pane=>createHash('sha256').update(paneIdentity(pane)).digest('hex');
  let questionRetired=new Map(Object.entries(store.read('question-retired.json',{})));
  function saveQuestionRetired(next) {
    // Commit tombstones before dispatch. They contain hashes only: neither
    // the user's question nor the terminal/pane identity is stored verbatim.
    store.write('question-retired.json',Object.fromEntries(next));
    questionRetired=next;
  }
  function retireQuestion(id,pane,semantic) {
    const next=new Map(questionRetired);
    next.set(retiredKey(id),{identity:identityHash(pane),semantic});
    saveQuestionRetired(next);
  }
  function clearRetiredQuestion(id) {
    const key=retiredKey(id);
    if(!questionRetired.has(key))return;
    const next=new Map(questionRetired);next.delete(key);saveQuestionRetired(next);
  }
  const questionKey=(deviceId,paneId)=>JSON.stringify([deviceId,paneId]);
  const loadUpdate=createUpdateSource(dependencies.updateDir);
  let snapshotFlight;let snapshotInputDuringFlight=null;let snapshotStartedAtSequence=0;let statusSequence=0;let lastGoodSnapshot=null;
  const statusOverrides=new Map();
  function acceptedInput(pane) {
    activity.acceptedInput(pane);
    snapshotInputDuringFlight?.add(pane.pane_id);
  }
  async function snapshot() {
    if(snapshotFlight) return snapshotFlight;
    snapshotStartedAtSequence=statusSequence;
    const inputDuringFlight=new Set();
    snapshotInputDuringFlight=inputDuringFlight;
    snapshotFlight=(async()=>{
    const base={structuredHistoryEnabled:config.structuredHistory!==false,activityTimelineEnabled:timeline!==null,agentModelSelectionEnabled:true,modelSelectionAgents:[...modelSelectionAgents],codexModelSelectionEnabled:modelSelectionAgents.includes('codex'),questionSelectionEnabled:true,terminalSnapshotSource:'recent_unwrapped',terminalInputEnabled:true,terminalCreationEnabled:true,directoryBrowsingEnabled:directories.home!==null,usage:usage.get(),attachmentsEnabled:true,reviewEnabled:true,operationReceiptsEnabled:true,attachmentManagementEnabled:true,sessionRenameEnabled:true,desktopHandoffEnabled:true,sessionResumeSupported:false,hostname:os.hostname(),projects:config.projects.map(({id,label})=>({id,label})),allowTerminalInput:config.allowTerminalInput===true,canStartHerdr:config.allowHerdrStart===true,lastUpdatedAt:null,stale:false};
      try {
        const {snapshot:raw}=await herdr.call('session.snapshot');
        if(raw.protocol!==22) throw new BridgeError('protocol_mismatch','Unsupported Herdr protocol; update the bridge after checking its schema.',503);
        const live=new Set(raw.panes.map(p=>p.pane_id));
        const agents=new Map((raw.agents||[]).map(a=>[a.pane_id,a]));
        const newer=new Set([...statusOverrides].filter(([,event])=>event.sequence>snapshotStartedAtSequence).map(([id])=>id));
        for(const id of inputDuringFlight)newer.add(id);
        activity.observe(raw.panes,newer);
        paneAttachments.prune(live);
        for(const [key,request] of modelMenuRequests) if(!live.has(request.paneId)||request.expiresAt<Date.now()) modelMenuRequests.delete(key);
        for(const [key,request] of questionRequests) if(!live.has(request.paneId)||(!request.attempted&&request.expiresAt<Date.now())) questionRequests.delete(key);
        for(const [key,request] of questionReveals) if(!live.has(request.paneId)) questionReveals.delete(key);
        const liveRetirementKeys=new Set([...live].map(retiredKey));
        if([...questionRetired.keys()].some(key=>!liveRetirementKeys.has(key)))
          saveQuestionRetired(new Map([...questionRetired].filter(([key])=>liveRetirementKeys.has(key))));
        const result={...base,herdrOnline:true,lastUpdatedAt:new Date().toISOString(),workspaces:raw.workspaces.map(w=>({id:w.workspace_id,label:w.label||w.workspace_id})),panes:raw.panes.map(p=>{
          const lastActivity=activity.lastActivity(p);
          const cwd=p.foreground_cwd||p.cwd||'';
          const project=associatedProject(cwd);
          return {projectId:project?.id??null,projectLabel:project?.label??null,id:p.pane_id,workspaceId:p.workspace_id,tabId:p.tab_id,title:p.label||agents.get(p.pane_id)?.name||p.title||p.terminal_title_stripped||p.agent||'Terminal',cwd,kind:p.agent||'terminal',status:p.agent_status||'unknown',lastActivity,revision:p.revision||0};
        })};
        // Keep even an empty successful result: a real empty snapshot must
        // clear an older session list rather than resurrecting it on outage.
        lastGoodSnapshot=result;
        return result;
      } catch(e) {
        const error=e instanceof BridgeError?e.message:'Unable to read Herdr.';
        if(lastGoodSnapshot) return {...lastGoodSnapshot,usage:base.usage,herdrOnline:false,canStartHerdr:base.canStartHerdr && e.code==='herdr_offline',stale:true,error};
        return {...base,canStartHerdr:base.canStartHerdr && e.code==='herdr_offline',herdrOnline:false,workspaces:[],panes:[],error};
      }
    })();
    try{return await snapshotFlight;} finally {snapshotFlight=null;snapshotInputDuringFlight=null;}
  }
  async function pane(id) {
    const result=await herdr.call('pane.get',{pane_id:id});
    if(!result?.pane || result.pane.pane_id!==id) reject('pane_changed','The requested pane is unavailable. Refresh the session list.',409);
    return result.pane;
  }
  async function locked(id, action) { if(locks.has(id)) reject('busy','Another operation is in progress for this pane.',409); locks.add(id); try{return await action();}finally{locks.delete(id);} }
  const projects=new Map(config.projects.map(p=>[p.id,p]));
  function projectPath(project) { try { const resolved=fs.realpathSync(project.path); if(!fs.statSync(resolved).isDirectory()) throw new Error(); return resolved; } catch { reject('project_unavailable','The selected project directory is unavailable.',409); } }
  function associatedProject(cwd) {return projectFor(config,cwd);}
  function rememberDirectory(cwd) {
    // A successful launch must remain successful even if the optional recent
    // list cannot be persisted (for example when the disk is full).
    try {directories.record(cwd);} catch {}
  }
  async function startAgent(paneId, kind, name) {
    const deadline=Date.now()+40000;
    let result;
    // Only agent_pane_busy is a confirmed pre-launch rejection. Once a launch
    // is accepted, everything below is observation: never launch it again.
    for (let attempt=0; ; attempt++) {
      try {
        result=await herdr.call('agent.start',{pane_id:paneId,kind,name,timeout_ms:30000},Math.min(35000,Math.max(1,deadline-Date.now())));
        break;
      } catch (error) {
        if(error.code!=='agent_pane_busy'||attempt>=12||Date.now()>=deadline) throw error;
        await new Promise(resolve=>setTimeout(resolve,250));
      }
    }
    if(!result?.agent || result.agent.interactive_ready || result.agent.agent_status==='blocked') return result;
    const readinessDeadline=Math.min(deadline,Date.now()+15000);
    while(Date.now()<readinessDeadline) {
      await new Promise(resolve=>setTimeout(resolve,250));
      const remaining=readinessDeadline-Date.now();
      if(remaining<=0) break;
      try {
        const current=(await herdr.call('agent.get',{target:paneId},Math.min(3000,remaining))).agent;
        if(result.agent.terminal_id && current?.terminal_id!==result.agent.terminal_id)
          throw new BridgeError('agent_changed','The new pane changed while its agent was starting.',409);
        if(current?.interactive_ready || current?.agent_status==='blocked') return {type:'agent_started',agent:current,argv:result.argv||[]};
      } catch(error) {
        if(!['agent_not_ready','agent_pane_busy'].includes(error.code)) throw error;
      }
    }
    throw new BridgeError('agent_start_timeout','The agent is still starting. Refresh the retained pane to inspect it.',504);
  }
  async function start(project,kind,name,existingWorkspace) {
    const cwd=projectPath(project);
    const created=existingWorkspace
      ? await herdr.call('tab.create',{workspace_id:existingWorkspace,cwd,label:name,focus:false})
      : await herdr.call('workspace.create',{cwd,label:project.label,focus:false});
    const id=created.root_pane.pane_id;
    try {
      // A newly created layout already contains a shell. Terminal sessions must
      // never call agent.start or send startup commands to that shell.
      if(kind==='terminal') await herdr.call('pane.rename',{pane_id:id,label:name});
      else await startAgent(id,kind,name);
      rememberDirectory(cwd);
      return {paneId:id};
    } catch(e) {
      // Retain the created pane so startup approval/login can be inspected and answered.
      e.message=`${e.message} The new pane ${id} was retained; refresh to inspect it.`;
      e.paneId=id; throw e;
    }
  }
  async function auth(req) { const header=req.headers.authorization; if(!header?.startsWith('Bearer ')) reject('unauthorized','Sign in or pair this device first.',401); const token=header.slice(7); const device=await authenticate(token); if(!device) reject('unauthorized','Device credential is invalid, expired or revoked.',401); requireAccess(store,device,'read',config); return {token,device}; }
  function scopedSnapshot(data,device) {
    const permissionMode=requireAccess(store,device,'read',config);
    const canControl=permissionMode!=='observer';
    return {...data,permissionMode,canControl,allowTerminalInput:data.allowTerminalInput===true&&permissionMode==='terminal',canStartHerdr:data.canStartHerdr===true&&canControl,terminalCreationEnabled:data.terminalCreationEnabled===true&&canControl};
  }
  // Bounds are global: proxy-provided IP headers are never trusted for authentication or rate limits.
  const buckets=new Map();
  function rate(key,max,window=60000) { const now=Date.now(); let b=buckets.get(key); if(!b||b.until<now) b={count:0,until:now+window}; b.count++; buckets.set(key,b); if(b.count>max) reject('rate_limited','Too many requests; try again shortly.',429); }
  function respond(res,status,value) { res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(value)); }
  const server=http.createServer(async(req,res)=>{
    try {
      // Native API only. Reject browser-origin calls, including WebSocket CSRF attempts.
      if(req.headers.origin) reject('origin_forbidden','Browser requests are not supported.',403);
      const url=new URL(req.url,'http://localhost');
      if(url.search && !(req.method==='GET'&&(url.pathname==='/v1/directories'||/^\/v1\/panes\/[^/]+\/(history|files)$/.test(url.pathname)))) reject('invalid_path','Query parameters are not supported.');
      if(req.method==='POST'&&url.pathname==='/v1/pair') {
        requireAccess(store,{deviceId:'pairing'},'read',config);
        rate('pair',15); const b=await body(req); const deviceName=text(b.deviceName,80,'device name');
        return respond(res,200,store.pair(b.code,deviceName));
      }
      const {device}=await auth(req); rate(device.deviceId,240);
      if(req.method!=='GET') requireAccess(store,device,'write',config);
      if(req.method==='GET'&&url.pathname==='/v1/directories') {
        if([...url.searchParams.keys()].some(key=>!['path','cursor'].includes(key)) ||
            ['path','cursor'].some(key=>url.searchParams.getAll(key).length>1)) reject('invalid_path','Use one folder path and optional page cursor.');
        return respond(res,200,await directories.list(url.searchParams.get('path')??undefined,url.searchParams.get('cursor')??undefined));
      }
      const operationStatus=url.pathname.match(/^\/v1\/operations\/([^/]+)$/);
      if(req.method==='GET'&&operationStatus) {
        let id; try { id=decodeURIComponent(operationStatus[1]); } catch { reject('invalid_operation_id','Invalid operation ID.'); }
        return respond(res,200,operations.status(device.deviceId,id));
      }
      if(req.method==='GET'&&url.pathname==='/v1/diagnostics') {
        const checkedAt=new Date().toISOString(); const s=await snapshot();
        return respond(res,200,{bridgeOnline:true,herdrOnline:s.herdrOnline,hostname:s.hostname,process:{uptimeSeconds:Math.floor(process.uptime())},projects:config.projects.map(project=>{let available=false;try{available=fs.statSync(project.path).isDirectory();}catch{}return {id:project.id,label:project.label,available};}),websocketSupported:true,sessionResumeSupported:false,checkedAt,error:s.error||null});
      }
      if(req.method==='GET'&&url.pathname==='/v1/attachments') return respond(res,200,attachments.list(device.deviceId));
      const attachmentContent=url.pathname.match(/^\/v1\/attachments\/([^/]+)\/content$/);
      if(req.method==='GET'&&attachmentContent) {
        let attachmentId; try {attachmentId=decodeURIComponent(attachmentContent[1]);}catch{reject('invalid_attachment','Invalid attachment ID.');}
        const item=attachments.open(attachmentId,device.deviceId); const stream=fs.createReadStream(item.file,{fd:item.fd,autoClose:true});
        res.on('close',()=>stream.destroy());
        res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':item.size,'Content-Disposition':`attachment; filename="${item.name.replace(/[^A-Za-z0-9._()-]/g,'_')}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
        stream.on('error',()=>{if(!res.headersSent)respond(res,404,{error:{code:'invalid_attachment',message:'Attachment is unavailable.'}});else res.destroy();}); stream.pipe(res); return;
      }
      if(req.method==='POST' && url.pathname==='/v1/herdr/start') {
        if(config.allowHerdrStart!==true) reject('herdr_start_disabled','Starting Herdr is not enabled on this laptop.',403);
        const input=await body(req);
        if(Object.keys(input).length) reject('invalid_input','Herdr start does not accept commands or options.');
        const result=await locked('herdr-start',()=>ensureHerdrRunning({herdr,startUnit:dependencies.startHerdrUnit}));
        return respond(res,200,{ok:true,...result});
      }
      if(req.method==='GET' && (url.pathname==='/v1/app-update' || url.pathname==='/v1/app-update/apk')) {
        const {metadata,bytes}=await loadUpdate();
        if(url.pathname==='/v1/app-update') return respond(res,200,metadata);
        res.writeHead(200,{'Content-Type':'application/vnd.android.package-archive','Content-Length':bytes.length,'Content-Disposition':'attachment; filename="herdr-remote.apk"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
        // Node handles backpressure/disconnects; the immutable validated buffer
        // is shared, so concurrent downloads do not reread/allocate whole APKs.
        res.end(bytes);
        return;
      }
      if(req.method==='GET'&&url.pathname==='/v1/health') { const s=await snapshot(); return respond(res,200,{bridgeOnline:true,herdrOnline:s.herdrOnline,hostname:s.hostname}); }
      if(req.method==='GET'&&url.pathname==='/v1/activity') return respond(res,200,timeline?.list()??{events:[],startedAt:null,disabled:true});
      if(req.method==='GET'&&url.pathname==='/v1/snapshot') return respond(res,200,scopedSnapshot(await refreshPublished(),device));
      if(req.method==='POST'&&url.pathname==='/v1/agents') {
        const b=await body(req);
        if(b.directory!==undefined && b.projectId!==undefined) reject('invalid_directory','Choose a folder or a configured project, not both.');
        const directorySelected=b.directory!==undefined;
        const project=directorySelected?null:projects.get(b.projectId);
        if(!directorySelected&&!project) reject('project_not_allowed','Select a project configured on the laptop.',403);
        if(directorySelected && (typeof b.directory!=='string'||!b.directory.trim()||b.directory.length>4096)) reject('invalid_directory','Choose a folder inside your home directory.');
        if((!kinds.has(b.kind)&&b.kind!=='terminal')||typeof b.name!=='string'||!/^[a-z][a-z0-9_-]{0,31}$/.test(b.name)) reject('invalid_agent','Choose a supported session type and a lowercase name (1–32 characters).');
        const target=directorySelected?{directory:b.directory}:{projectId:b.projectId};
        const result=await operations.run(device.deviceId,operationInput(req,b),'agent.create',{...target,kind:b.kind,name:b.name},()=>locked('start',async()=>{
          if(b.kind!=='terminal') {
            const list=await herdr.call('agent.list'); if(list.agents.some(a=>a.name===b.name)) reject('duplicate_name','Agent name is already in use.',409);
          }
          const cwd=directorySelected?directories.resolve(b.directory):null;
          return start(directorySelected?{path:cwd,label:cwd===directories.home?'Home':path.basename(cwd)}:project,b.kind,b.name);
        })); return respond(res,201,result);
      }
      const attachmentDelete=url.pathname.match(/^\/v1\/panes\/([^/]+)\/attachments\/([^/]+)$/);
      const projectArtifact=url.pathname.match(/^\/v1\/panes\/([^/]+)\/artifacts\/(project-[a-f0-9]{64})$/);
      if(req.method==='GET'&&projectArtifact) {
        let paneId;try {paneId=decodeURIComponent(projectArtifact[1]);}catch {reject('invalid_pane','Invalid pane identifier.');}
        if(!paneId||paneId.length>256||/[\u0000-\u001f\u007f]/.test(paneId))reject('invalid_pane','Invalid pane identifier.');
        const current=await pane(paneId);
        const item=openProjectArtifact(config,current.foreground_cwd||current.cwd,projectArtifact[2]);
        // A file may grow after fstat. Never stream past the verified snapshot size.
        const stream=item.size===0?null:fs.createReadStream(item.file,{fd:item.fd,autoClose:true,end:item.size-1});
        res.on('close',()=>stream?.destroy());
        stream?.on('error',()=>res.destroy());
        const encodedName=encodeURIComponent(item.name).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
        res.writeHead(200,{'Content-Type':item.contentType,'Content-Length':item.size,'Content-Disposition':`attachment; filename="${item.name.replace(/[^A-Za-z0-9._() -]/g,'_')}"; filename*=UTF-8''${encodedName}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
        if(stream)stream.pipe(res);else {fs.closeSync(item.fd);res.end();}return;
      }
      if(req.method==='DELETE'&&attachmentDelete) {
        let paneId,attachmentId; try{paneId=decodeURIComponent(attachmentDelete[1]);attachmentId=decodeURIComponent(attachmentDelete[2]);}catch{reject('invalid_attachment','Invalid attachment ID.');}
        return respond(res,200,await operations.run(device.deviceId,operationInput(req),'attachment.delete',{paneId,attachmentId},()=>attachments.remove(attachmentId,device.deviceId,paneId)));
      }
      const match=url.pathname.match(/^\/v1\/panes\/([^/]+)(?:\/(output|history|files|prompt|input|keys|stop|restart|rename|focus|review|attachments|answer|question-review|model|model-select|model-cancel|model-key))?$/);
      if(!match) reject('not_found','Unknown endpoint.',404);
      let id; try {id=decodeURIComponent(match[1]);} catch {reject('invalid_pane','Invalid pane identifier.');}
      // Herdr IDs are opaque handles, not decimal counters (e.g. w1Y:p1).
      // Bound transport input; let the installed Herdr API resolve the handle.
      // IDs are sent only as JSON fields to fixed methods, never shell commands.
      if(!id || id.length>256 || /[\u0000-\u001f\u007f]/.test(id)) reject('invalid_pane','Invalid pane identifier.');
      const action=match[2];
      if(req.method==='GET'&&action==='files') {
        if([...url.searchParams.keys()].some(key=>!['directory','cursor'].includes(key))||['directory','cursor'].some(key=>url.searchParams.getAll(key).length>1))reject('invalid_directory','Use one project directory and optional page cursor.');
        const current=await pane(id);
        return respond(res,200,listProjectFiles(config,current.foreground_cwd||current.cwd,url.searchParams.get('directory')??'',url.searchParams.get('cursor')));
      }
      if(req.method==='GET'&&action==='history') {
        if([...url.searchParams.keys()].some(key=>key!=='cursor')||url.searchParams.getAll('cursor').length>1)reject('invalid_path','Use one history cursor.');
        const current=await pane(id);
        const result=await history.read(current,url.searchParams.get('cursor'));
        const fresh=await pane(id);
        if(fresh.agent!==current.agent||JSON.stringify(fresh.agent_session)!==JSON.stringify(current.agent_session)||fresh.terminal_id!==current.terminal_id)reject('history_changed','The conversation changed. Refresh history.',409);
        return respond(res,200,result);
      }
      if(req.method==='GET'&&action==='attachments') return respond(res,200,attachments.list(device.deviceId,id));
      if(req.method==='GET'&&action==='review') {
        const current=await pane(id); return respond(res,200,await reviewProject(config,current.foreground_cwd||current.cwd,attachments,device.deviceId,id));
      }
      if(req.method==='GET'&&action==='output') {
        const current=await pane(id);
        // Menu metadata is published only after this device requested the
        // picker in this exact pane occupant. Detection reads never send input.
        const requestKey=modelMenuKey(device.deviceId,id);
        const modelRequest=modelMenuRequests.get(requestKey);
        let agentModelMenu=null;
        let question=null,questionReviewAvailable=false,questionAwaitingTransition=false;
        const qKey=questionKey(device.deviceId,id);
        if(current.agent==='codex' && locks.has(id)) questionAwaitingTransition=true;
        else if(current.agent==='codex') {
          try {
            const screen=await readCodexQuestionScreen(herdr,id,current);
            const retired=questionRetired.get(retiredKey(id));
            if(retired && (retired.identity!==identityHash(current) || screen.transitioned ||
                (screen.question && retired.semantic!==questionSemantic(screen.question,current))))
              clearRetiredQuestion(id);
            const previousReveal=questionReveals.get(id);
            const sameReveal=previousReveal?.attempted && previousReveal.identity===paneIdentity(current);
            // An unknown or truncated frame does not prove a prior reveal
            // failed. Only a complete editor, normal composer, or changed
            // occupant retires the attempt.
            if(previousReveal && (!sameReveal || screen.question || screen.transitioned)) questionReveals.delete(id);
            questionAwaitingTransition=questionRetired.has(retiredKey(id)) ||
              Boolean(sameReveal && !screen.question && !screen.transitioned);
            questionReviewAvailable=screen.collapsed && !questionAwaitingTransition;
            if(screen.question && !questionAwaitingTransition) {
              const fingerprint=questionFingerprint(screen.question,current);
              let request=questionRequests.get(qKey);
              if(!request || request.fingerprint!==fingerprint || request.identity!==paneIdentity(current)) {
                request={paneId:id,identity:paneIdentity(current),fingerprint,question:screen.question,id:questionId(fingerprint,randomUUID()),attempted:false,expiresAt:Date.now()+120000};
                questionRequests.set(qKey,request);
              }
              if(!request.attempted) {
                request.expiresAt=Date.now()+120000;
                const native=screen.question;
                question=native.stage==='text'
                  ?(native.otherDraft===null?{id:request.id,prompt:native.prompt,options:[],selectedIndex:null,freeText:true,stage:'text'}:null)
                  :{id:request.id,prompt:native.prompt,options:native.options,selectedIndex:native.selectedIndex,freeText:false,stage:'choices'};
              }
            } else if(!questionAwaitingTransition) questionRequests.delete(qKey);
          } catch {
            questionRequests.delete(qKey);
            const previousReveal=questionReveals.get(id);
            questionAwaitingTransition=questionRetired.has(retiredKey(id)) ||
              Boolean(previousReveal?.attempted && previousReveal.identity===paneIdentity(current));
          }
        }
        if(modelRequest) {
          try {
            if(modelRequest.expiresAt>Date.now()&&modelRequest.identity===paneIdentity(current)&&
              modelSelectionAgents.includes(current.agent)&&!['working','starting','stopped','error'].includes(current.agent_status)) {
              agentModelMenu=await readAgentModelMenu(herdr,id,current);
              if(agentModelMenu) modelRequest.expiresAt=Date.now()+300000;
            } else modelMenuRequests.delete(requestKey);
          } catch {modelMenuRequests.delete(requestKey);}
        }
        // Recent output is passive and bounded. It cannot authorize input;
        // guarded question controls use the separate current visible read.
        const result=await herdr.call('pane.read',{pane_id:id,source:'recent_unwrapped',format:'ansi',strip_ansi:false,lines:300});
        const fresh=await pane(id);
        let attachmentId=null;
        if(current.terminal_id && fresh.terminal_id) {
          if(paneIdentity(fresh)!==paneIdentity(current)) reject('pane_changed','The terminal changed while it was read. Refresh it.',409);
          attachmentId=paneAttachments.attach(device.deviceId,fresh);
        }
        return respond(res,200,boundedOutput({text:stripVTControlCharacters(result.read.text),revision:result.read.revision,truncated:result.read.truncated,source:'recent_unwrapped',attachmentId,currentModel:null,questionReviewAvailable,questionAwaitingTransition,...(question?{question}:{}),...(agentModelMenu?{agentModelMenu,...(current.agent==='codex'?{codexModelMenu:agentModelMenu}:{})}:{})}));
      }
      if(req.method==='POST'&&['question-review','answer'].includes(action)) {
        const b=await body(req); const operationId=operationInput(req,b);
        const allowed=action==='question-review'?['operationId','attachmentId']:['operationId','attachmentId','questionId','option','text'];
        if(Object.keys(b).some(key=>!allowed.includes(key))) reject('invalid_question','Unsupported question action.');
        if(action==='answer'&&(
          typeof b.questionId!=='string'||!/^[a-f0-9]{64}$/.test(b.questionId)||
          (Number.isInteger(b.option)===('text' in b)) ||
          ('option' in b && (b.option<0||b.option>32)) ||
          ('text' in b && (typeof b.text!=='string'||b.text.length<1||b.text.length>500))))
          reject('invalid_question','Refresh the question and choose one visible answer.');
        return respond(res,200,await operations.run(device.deviceId,operationId,`pane.${action}`,
          {paneId:id,questionId:b.questionId??null,option:b.option??null,text:b.text??null},()=>locked(id,async()=>{
            const current=await pane(id);
            paneAttachments.validate(device.deviceId,current,b.attachmentId);
            if(current.agent!=='codex') reject('question_unavailable','This pane does not have a supported Codex question.',409);
            if(action==='question-review') {
              const prior=questionReveals.get(id);
              if(prior?.attempted && prior.identity===paneIdentity(current))
                reject('question_stale','The question reveal was already attempted. Inspect the pane.',409);
              return revealCodexQuestion(herdr,id,current,()=>questionReveals.set(id,{paneId:id,identity:paneIdentity(current),attempted:true}));
            }
            const request=questionRequests.get(questionKey(device.deviceId,id));
            if(!request || request.attempted || request.id!==b.questionId || request.identity!==paneIdentity(current) || request.expiresAt<Date.now())
              reject('question_stale','The question changed. Refresh before answering.',409);
            return actCodexQuestion(herdr,id,current,request.question,{option:b.option,text:b.text},()=>{
              // Another phone may have observed the same frame. Once any key is
              // dispatched, all those authorizations are obsolete.
              retireQuestion(id,current,questionSemantic(request.question,current));
              for(const entry of questionRequests.values())
                if(entry.paneId===id && entry.identity===request.identity) entry.attempted=true;
            });
          })));
      }
      if(req.method==='POST'&&['model','model-select','model-cancel','model-key'].includes(action)) {
        const b=await body(req); const operationId=operationInput(req,b);
        const allowed=action==='model'?['operationId','attachmentId']:action==='model-select'?['operationId','attachmentId','menuId','option']:action==='model-key'?['operationId','attachmentId','menuId','key']:['operationId','attachmentId','menuId'];
        if(Object.keys(b).some(key=>!allowed.includes(key))) reject('invalid_model_selection','Unsupported model selection input.');
        if(action!=='model'&&(typeof b.menuId!=='string'||!/^[a-f0-9]{64}$/.test(b.menuId))) reject('invalid_model_selection','Refresh the model choices before continuing.');
        if(action==='model-select'&&(!Number.isInteger(b.option)||b.option<0||b.option>99)) reject('invalid_model_selection','Choose a visible model option.');
        if(action==='model-key'&&!['up','down'].includes(b.key)) reject('invalid_model_selection','Choose a supported model navigation key.');
        // Every mutation revalidates the device, the pane attachment, the pane
        // identity/status and the live menu identity before any key is sent.
        // Receipts keep uncertain delivery inspectable, never auto-retried.
        return respond(res,200,await operations.run(device.deviceId,operationId,`pane.${action}`,{paneId:id,menuId:b.menuId??null,option:b.option??null,key:b.key??null},()=>locked(id,async()=>{
          const current=await pane(id);
          paneAttachments.validate(device.deviceId,current,b.attachmentId);
          if(!modelSelectionAgents.includes(current.agent)) reject('model_unavailable','This agent does not have a verified app model picker. Use its terminal controls.',409);
          const result=await (action==='model'?openAgentModelMenu(herdr,id,current)
            :action==='model-key'?keyAgentModelMenu(herdr,id,current,{menuId:b.menuId,key:b.key})
            :actAgentModelMenu(herdr,id,current,{menuId:b.menuId,option:b.option,cancel:action==='model-cancel'}));
          const requestKey=modelMenuKey(device.deviceId,id);
          if(action==='model-cancel') modelMenuRequests.delete(requestKey);
          else modelMenuRequests.set(requestKey,{paneId:id,identity:paneIdentity(current),expiresAt:Date.now()+120000});
          return result;
        })));
      }
      if(req.method==='POST'&&action==='attachments') {
        const result=await locked(id,async()=>attachments.upload(req,await pane(id),id,device.deviceId,()=>pane(id)));
        return respond(res,201,result);
      }
      if(req.method==='DELETE'&&!action) {
        const result=await operations.run(device.deviceId,operationInput(req),'pane.close',{paneId:id},()=>locked(id,()=>herdr.call('pane.close',{pane_id:id}))); return respond(res,200,result);
      }
      if(req.method!=='POST'||!['prompt','input','keys','stop','restart','rename','focus'].includes(action)) reject('not_found','Unknown endpoint.',404);
      const b=await body(req);
      const operationId=operationInput(req,b);
      const result=await operations.run(device.deviceId,operationId,`pane.${action}`,{paneId:id,body:{...b,operationId:undefined}},()=>locked(id,async()=>{
        const completion=action==='prompt'?push.completionFor?.(id):null;
        if(action==='keys' || action==='stop') {
          if(action==='keys'&&(!Array.isArray(b.keys)||b.keys.length!==1||b.keys.some(k=>!keys.has(k)))) reject('invalid_keys','Choose one supported key.');
          const target=await pane(id);
          paneAttachments.validate(device.deviceId,target,b.attachmentId);
          if(!target.agent) requireAccess(store,device,'terminal',config);
          const sent=await herdr.call('pane.send_keys',{pane_id:id,keys:action==='stop'?['ctrl+c']:b.keys});
          acceptedInput(target);
          return sent;
        }
        const current=await pane(id);
        if(action==='rename') {
          const title=text(b.title,120,'session title').trim();
          if(/[\u0000-\u001f\u007f-\u009f]/.test(b.title))reject('invalid_input','Session titles cannot contain control characters.');
          await herdr.call('pane.rename',{pane_id:id,label:title});
          return {title};
        }
        if(action==='focus') {
          if(Object.keys(b).some(key=>key!=='operationId'))reject('invalid_input','Desktop handoff does not accept options.');
          await herdr.call('pane.focus',{pane_id:id});
          return {focused:true};
        }
        if(action==='prompt') {
          paneAttachments.validate(device.deviceId,current,b.attachmentId);
          if(!current.agent) reject('agent_unavailable','This pane has no detected agent. Use terminal input instead.',409);
          const input=attachments.prompt(b.text??'',b.attachmentIds,current,id,device.deviceId);
          const submitted=await promptAgent(herdr,id,input,current);
          acceptedInput(current);
          if(push.acknowledge?.(id,completion)&&latestSnapshot)
            void publish(push.annotate?.(latestSnapshot)??latestSnapshot);
          return submitted;
        }
        if(action==='input') {
          paneAttachments.validate(device.deviceId,current,b.attachmentId);
          if(!current.agent) requireAccess(store,device,'terminal',config);
          if(typeof b.text!=='string'||!b.text.length||b.text.length>16000||/[\u0000-\u0008\u000b-\u001f\u007f]/.test(b.text))
            reject('invalid_input','Enter up to 16000 characters of terminal text without control characters.');
          const sent=await herdr.call('pane.send_input',{pane_id:id,text:b.text});
          acceptedInput(current);
          return sent;
        }
        if(!kinds.has(current.agent)) reject('restart_unsupported','Restart is supported only for Codex, Claude Code and OpenCode.',409);
        const agentInfo=(await herdr.call('agent.get',{target:id})).agent;
        const cwd=canonicalDirectory(current.cwd);
        if(!cwd||!associatedProject(cwd)) reject('project_not_allowed','Restart requires a home folder or configured project.',403);
        // Create replacement before closing to preserve its workspace even when old pane was last.
        const created=await herdr.call('tab.create',{workspace_id:current.workspace_id,cwd,label:'Restart',focus:false});
        const replacement=created.root_pane.pane_id;
        try { await herdr.call('pane.close',{pane_id:id}); }
        catch(e) { await herdr.call('pane.close',{pane_id:replacement}).catch(()=>{}); throw e; }
        try { await startAgent(replacement,current.agent,agentInfo?.name||`remote-${Date.now().toString(36)}`); }
        catch(e) { e.message+=` Replacement pane ${replacement} was retained; refresh to inspect it.`;e.paneId=replacement;throw e; }
        rememberDirectory(cwd);
        return {paneId:replacement};
      }));
      respond(res,200,result?.paneId?result:{...result,ok:true});
    } catch(e) {
      if(!res.headersSent) {
        if(!req.complete) { res.shouldKeepAlive=false;res.setHeader('Connection','close'); }
        respond(res,e.status||500,{error:{code:e.code||'internal_error',message:e instanceof BridgeError?e.message:'Internal bridge error.',...(e.paneId?{paneId:e.paneId}:{}),...(e.operationId?{operationId:e.operationId}:{}),...(e.operationStatus?{operationStatus:e.operationStatus}:{})}});
      }
    }
  });
  server.requestTimeout=300000; server.headersTimeout=10000; server.maxHeadersCount=30;
  const wss=new WebSocketServer({noServer:true,maxPayload:1024,perMessageDeflate:false});
  server.on('upgrade',async(req,socket,head)=>{
    try { if(req.url!=='/v1/events'||req.headers.origin) reject('forbidden','Forbidden',403); const {token,device}=await auth(req);rate(device.deviceId,240);if(wss.clients.size>=8) reject('busy','Too many connections.',429);
      if(socket.destroyed)return;
      wss.handleUpgrade(req,socket,head,ws=>{ws.token=token;ws.alive=true;ws.on('pong',()=>{ws.alive=true;});ws.on('error',()=>{});wss.emit('connection',ws);});
    } catch {socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');}
  });
  let last=''; let polling=false;let latestSnapshot=null;
  let publication=Promise.resolve();
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
    publication=publication.catch(()=>{}).then(async()=>{
      for(const ws of wss.clients){const device=await authenticate(ws.token);let scoped;try {if(!device) throw Error('revoked');scoped=scopedSnapshot(data,device);}catch {ws.close(4001,'Expired, revoked or disabled');continue;}if(ws.bufferedAmount>1024*1024)ws.close(1013,'Slow client');else if(ws.readyState===WebSocket.OPEN){ws.permissionMode=scoped.permissionMode;ws.send(JSON.stringify({type:'snapshot',data:scoped}));}}
    });
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
  wss.on('connection',()=>{void refreshPublished(true).catch(()=>{});});
  const poll=setInterval(async()=>{
    if(polling)return;
    if(!timeline&&!push.enabled&&!push.tracking&&typeof dependencies.onSnapshot!=='function'&&wss.clients.size===0){statusEvents?.update([]);return;}
    polling=true;
    try {await refreshPublished();}catch{}finally{polling=false;}
  },1000);poll.unref();
  const heartbeat=setInterval(async()=>{for(const ws of wss.clients){const device=await authenticate(ws.token);try {if(!device) throw Error('revoked');requireAccess(store,device,'read',config);}catch {ws.terminate();continue;}if(!ws.alive){ws.terminate();continue;}if(ws.readyState!==WebSocket.OPEN)continue;ws.alive=false;ws.ping();}},20000);heartbeat.unref();
  // Another local CLI process can change access.json or devices.json. Check
  // established sockets independently of Herdr output or relay connectivity.
  const accessSweep=setInterval(async()=>{for(const ws of wss.clients){const device=await authenticate(ws.token);let mode;try {if(!device) throw Error('revoked');mode=requireAccess(store,device,'read',config);}catch {ws.terminate();continue;}if(mode!==ws.permissionMode&&latestSnapshot&&ws.readyState===WebSocket.OPEN){const scoped=scopedSnapshot(latestSnapshot,device);ws.permissionMode=mode;ws.send(JSON.stringify({type:'snapshot',data:scoped}));}}},1000);accessSweep.unref();
  server.on('close',()=>{usage.close();clearInterval(poll);clearInterval(heartbeat);clearInterval(accessSweep);statusEvents?.close();for(const ws of wss.clients)ws.terminate();wss.close();try{push.close();}catch{}});
  return {server,store,snapshot,close:()=>new Promise(resolve=>{for(const ws of wss.clients)ws.terminate();server.close(resolve);})};
}
