import fs from 'node:fs';
import path from 'node:path';
import {BridgeError} from './herdr.js';
import {requireAccess} from './access.js';
import {operationInput} from './operations.js';
import {ensureHerdrRunning} from './start-herdr.js';
import {readJsonBody as body} from './request-body.js';
import {reject,text,respond,writeDownloadHead,onlyParams} from './http-util.js';

const kinds=new Set(['codex','claude','opencode']);
const queryRoutes=/^\/v1\/panes\/[^/]+\/(history|files|preview(?:\/[a-f0-9]{32})?)$/;

/**
 * The native HTTP API. `ctx` carries the bridge's shared services; pane-scoped
 * endpoints are delegated to `ctx.paneRoutes`.
 */
export function createRequestHandler(ctx) {
  const {config,dependencies,store,herdr,directories,attachments,operations,timeline,launcher}=ctx;
  const projects=new Map(config.projects.map(p=>[p.id,p]));
  function projectAvailable(project) {
    try {return fs.statSync(project.path).isDirectory();} catch {return false;}
  }
  async function routes(req,res,url,device) {
    if(req.method==='GET'&&url.pathname==='/v1/directories') {
      onlyParams(url,['path','cursor'],'invalid_path','Use one folder path and optional page cursor.');
      return respond(res,200,await directories.list(url.searchParams.get('path')??undefined,url.searchParams.get('cursor')??undefined));
    }
    const operationStatus=url.pathname.match(/^\/v1\/operations\/([^/]+)$/);
    if(req.method==='GET'&&operationStatus) {
      let id; try { id=decodeURIComponent(operationStatus[1]); } catch { reject('invalid_operation_id','Invalid operation ID.'); }
      return respond(res,200,operations.status(device.deviceId,id));
    }
    if(req.method==='GET'&&url.pathname==='/v1/diagnostics') {
      const checkedAt=new Date().toISOString(); const s=await ctx.snapshot();
      return respond(res,200,{bridgeOnline:true,herdrOnline:s.herdrOnline,hostname:s.hostname,process:{uptimeSeconds:Math.floor(process.uptime())},
        projects:config.projects.map(project=>({id:project.id,label:project.label,available:projectAvailable(project)})),
        websocketSupported:true,sessionResumeSupported:false,checkedAt,error:s.error||null});
    }
    if(req.method==='GET'&&url.pathname==='/v1/attachments') return respond(res,200,attachments.list(device.deviceId));
    const attachmentContent=url.pathname.match(/^\/v1\/attachments\/([^/]+)\/content$/);
    if(req.method==='GET'&&attachmentContent) {
      let attachmentId; try {attachmentId=decodeURIComponent(attachmentContent[1]);}catch{reject('invalid_attachment','Invalid attachment ID.');}
      const item=attachments.open(attachmentId,device.deviceId); const stream=fs.createReadStream(item.file,{fd:item.fd,autoClose:true});
      res.on('close',()=>stream.destroy());
      const filename=item.name.replace(/[^A-Za-z0-9._()-]/g,'_');
      writeDownloadHead(res,{'Content-Type':'application/octet-stream','Content-Length':item.size,'Content-Disposition':`attachment; filename="${filename}"`});
      stream.on('error',()=>{
        if(!res.headersSent)respond(res,404,{error:{code:'invalid_attachment',message:'Attachment is unavailable.'}});else res.destroy();
      });
      stream.pipe(res); return;
    }
    if(req.method==='POST' && url.pathname==='/v1/herdr/start') {
      if(config.allowHerdrStart!==true) reject('herdr_start_disabled','Starting Herdr is not enabled on this laptop.',403);
      const input=await body(req);
      if(Object.keys(input).length) reject('invalid_input','Herdr start does not accept commands or options.');
      const result=await ctx.locked('herdr-start',()=>ensureHerdrRunning({herdr,startUnit:dependencies.startHerdrUnit}));
      return respond(res,200,{ok:true,...result});
    }
    if(req.method==='GET' && (url.pathname==='/v1/app-update' || url.pathname==='/v1/app-update/apk')) {
      const {metadata,bytes}=await ctx.loadUpdate();
      if(url.pathname==='/v1/app-update') return respond(res,200,metadata);
      writeDownloadHead(res,{'Content-Type':'application/vnd.android.package-archive','Content-Length':bytes.length,'Content-Disposition':'attachment; filename="herdr-remote.apk"'});
      // Node handles backpressure/disconnects; the immutable validated buffer
      // is shared, so concurrent downloads do not reread/allocate whole APKs.
      res.end(bytes);
      return;
    }
    if(req.method==='GET'&&url.pathname==='/v1/health') {
      const s=await ctx.snapshot(); return respond(res,200,{bridgeOnline:true,herdrOnline:s.herdrOnline,hostname:s.hostname});
    }
    if(req.method==='GET'&&url.pathname==='/v1/activity') return respond(res,200,timeline?.list()??{events:[],startedAt:null,disabled:true});
    if(req.method==='GET'&&url.pathname==='/v1/snapshot') return respond(res,200,ctx.scopedSnapshot(await ctx.refreshPublished(),device));
    if(req.method==='POST'&&url.pathname==='/v1/agents') return respond(res,201,await createAgent(req,device));
    return ctx.paneRoutes(req,res,url,device);
  }
  async function createAgent(req,device) {
    const b=await body(req);
    if(b.directory!==undefined && b.projectId!==undefined) reject('invalid_directory','Choose a folder or a configured project, not both.');
    const directorySelected=b.directory!==undefined;
    const project=directorySelected?null:projects.get(b.projectId);
    if(!directorySelected&&!project) reject('project_not_allowed','Select a project configured on the laptop.',403);
    if(directorySelected && (typeof b.directory!=='string'||!b.directory.trim()||b.directory.length>4096))
      reject('invalid_directory','Choose a folder inside your home directory.');
    if((!kinds.has(b.kind)&&b.kind!=='terminal')||typeof b.name!=='string'||!/^[a-z][a-z0-9_-]{0,31}$/.test(b.name))
      reject('invalid_agent','Choose a supported session type and a lowercase name (1–32 characters).');
    const target=directorySelected?{directory:b.directory}:{projectId:b.projectId};
    return operations.run(device.deviceId,operationInput(req,b),'agent.create',{...target,kind:b.kind,name:b.name},()=>ctx.locked('start',async()=>{
      if(b.kind!=='terminal') {
        const list=await herdr.call('agent.list'); if(list.agents.some(a=>a.name===b.name)) reject('duplicate_name','Agent name is already in use.',409);
      }
      const cwd=directorySelected?directories.resolve(b.directory):null;
      const location=directorySelected?{path:cwd,label:cwd===directories.home?'Home':path.basename(cwd)}:project;
      return launcher.start(location,b.kind,b.name);
    }));
  }
  return async(req,res)=>{
    try {
      // Native API only. Reject browser-origin calls, including WebSocket CSRF attempts.
      if(req.headers.origin) reject('origin_forbidden','Browser requests are not supported.',403);
      const url=new URL(req.url,'http://localhost');
      if(url.search && !(req.method==='GET'&&(url.pathname==='/v1/directories'||queryRoutes.test(url.pathname))))
        reject('invalid_path','Query parameters are not supported.');
      if(req.method==='POST'&&url.pathname==='/v1/pair') {
        requireAccess(store,{deviceId:'pairing'},'read',config);
        ctx.rate('pair',15); const b=await body(req); const deviceName=text(b.deviceName,80,'device name');
        return respond(res,200,store.pair(b.code,deviceName));
      }
      const {device}=await ctx.auth(req); ctx.rate(device.deviceId,240);
      if(req.method!=='GET') requireAccess(store,device,'write',config);
      await routes(req,res,url,device);
    } catch(e) {
      if(!res.headersSent) {
        if(!req.complete) { res.shouldKeepAlive=false;res.setHeader('Connection','close'); }
        const message=e instanceof BridgeError?e.message:'Internal bridge error.';
        respond(res,e.status||500,{error:{code:e.code||'internal_error',message,...(e.paneId?{paneId:e.paneId}:{}),
          ...(e.operationId?{operationId:e.operationId}:{}),...(e.operationStatus?{operationStatus:e.operationStatus}:{})}});
      }
    }
  };
}
