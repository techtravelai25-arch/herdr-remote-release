import fs from 'node:fs';
import {stripVTControlCharacters} from 'node:util';
import {requireAccess} from './access.js';
import {operationInput} from './operations.js';
import {paneIdentity} from './pane-attachment.js';
import {promptAgent} from './prompt-agent.js';
import {reviewProject} from './review.js';
import {openProjectArtifact,listProjectFiles} from './artifacts.js';
import {withClaudeSession} from './claude-session.js';
import {boundedOutput} from './response-budget.js';
import {canonicalDirectory} from './projects.js';
import {readJsonBody as body} from './request-body.js';
import {reject,text,respond,writeDownloadHead,paneParam,onlyParams} from './http-util.js';

const kinds=new Set(['codex','claude','opencode']);
const keys=new Set(['enter','esc','tab','up','down','left','right','ctrl+c','alt+up']);
const actions=/^\/v1\/panes\/([^/]+)(?:\/(output|history|files|prompt|input|keys|stop|restart|rename|focus|review|attachments|answer|question-review|model|model-select|model-cancel|model-key))?$/;
const questionActions=['question-review','answer'];
const modelActions=['model','model-select','model-cancel','model-key'];
const inputActions=['prompt','input','keys','stop','restart','rename','focus'];

/** Pane-scoped HTTP endpoints: output, history, files, previews and pane actions. */
export function createPaneRoutes(ctx) {
  const {config,store,herdr,history,attachments,operations,push,htmlPreview,menus,paneAttachments,launcher}=ctx;
  const {pane,locked}=ctx;
  async function dispatchInput(target,send,guard='always') {
    const startedAt=Date.now();
    const cancel=guard==='none'?()=>{}:ctx.inputStarted(target,startedAt,guard==='completed');
    try {
      const result=await send();
      ctx.acceptedInput(target,startedAt);
      return result;
    } catch(error) {cancel();throw error;}
  }
  async function preview(req,res,url,device,match) {
    const paneId=paneParam(match[1]);
    onlyParams(url,match[2]?['path','offset']:['target','artifactId'],'invalid_preview_path','Use one page or resource path.');
    const current=await pane(paneId);
    // The bridge fetches loopback pages on the device's behalf, so a
    // localhost-sourced page needs write access; project files need read.
    const authorizeLocalhost=()=>requireAccess(store,device,'write',config);
    if(match[2])return respond(res,200,await htmlPreview.read({deviceId:device.deviceId,pane:current,id:match[2],
      relative:url.searchParams.get('path'),offset:url.searchParams.get('offset'),authorizeLocalhost}));
    return respond(res,200,await htmlPreview.create({deviceId:device.deviceId,pane:current,authorizeLocalhost,
      target:url.searchParams.has('target')?url.searchParams.get('target'):undefined,
      artifactId:url.searchParams.has('artifactId')?url.searchParams.get('artifactId'):undefined}));
  }
  async function artifact(req,res,match) {
    const current=await pane(paneParam(match[1]));
    const item=openProjectArtifact(config,current.foreground_cwd||current.cwd,match[2]);
    // A file may grow after fstat. Never stream past the verified snapshot size.
    const stream=item.size===0?null:fs.createReadStream(item.file,{fd:item.fd,autoClose:true,end:item.size-1});
    res.on('close',()=>stream?.destroy());
    stream?.on('error',()=>res.destroy());
    const encodedName=encodeURIComponent(item.name).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
    const filename=item.name.replace(/[^A-Za-z0-9._() -]/g,'_');
    writeDownloadHead(res,{'Content-Type':item.contentType,'Content-Length':item.size,
      'Content-Disposition':`attachment; filename="${filename}"; filename*=UTF-8''${encodedName}`});
    if(stream)stream.pipe(res);else {fs.closeSync(item.fd);res.end();}
  }
  async function output(device,id) {
    const current=await pane(id);
    const menuFields=await menus.observe(device.deviceId,id,current,ctx.locks.has(id));
    // Recent output is passive and bounded. It cannot authorize input;
    // guarded question controls use the separate current visible read.
    const result=await herdr.call('pane.read',{pane_id:id,source:'recent_unwrapped',format:'ansi',strip_ansi:false,lines:300});
    const fresh=await pane(id);
    let attachmentId=null;
    if(current.terminal_id && fresh.terminal_id) {
      if(paneIdentity(fresh)!==paneIdentity(current)) reject('pane_changed','The terminal changed while it was read. Refresh it.',409);
      attachmentId=paneAttachments.attach(device.deviceId,fresh);
    }
    return boundedOutput({text:stripVTControlCharacters(result.read.text),revision:result.read.revision,truncated:result.read.truncated,
      source:'recent_unwrapped',attachmentId,currentModel:null,...menuFields});
  }
  async function readHistory(url,id) {
    onlyParams(url,['cursor','revision'],'invalid_path','Use one history cursor and optional revision.');
    const current=await withClaudeSession(herdr,await pane(id),config.homeDirectory);
    const result=await history.read(current,url.searchParams.get('cursor'),url.searchParams.get('revision'));
    const fresh=await withClaudeSession(herdr,await pane(id),config.homeDirectory);
    if(fresh.agent!==current.agent||JSON.stringify(fresh.agent_session)!==JSON.stringify(current.agent_session)||fresh.terminal_id!==current.terminal_id)
      reject('history_changed','The conversation changed. Refresh history.',409);
    return result;
  }
  function questionAction(req,device,id,action,b) {
    const operationId=operationInput(req,b);
    const allowed=action==='question-review'?['operationId','attachmentId']:['operationId','attachmentId','questionId','option','text','cancel'];
    if(Object.keys(b).some(key=>!allowed.includes(key))) reject('invalid_question','Unsupported question action.');
    if(action==='answer'&&(
      typeof b.questionId!=='string'||!/^[a-f0-9]{64}$/.test(b.questionId)||
      ['option','text','cancel'].filter(key=>key in b).length!==1||
      ('option' in b && (!Number.isInteger(b.option)||b.option<0||b.option>32)) ||
      ('text' in b && (typeof b.text!=='string'||b.text.length<1||b.text.length>500))||
      ('cancel' in b && b.cancel!==true)))
      reject('invalid_question','Refresh the question and choose one visible answer.');
    const input={paneId:id,questionId:b.questionId??null,option:b.option??null,text:b.text??null,cancel:b.cancel??null};
    return operations.run(device.deviceId,operationId,`pane.${action}`,input,()=>locked(id,async()=>{
      const current=await pane(id);
      paneAttachments.validate(device.deviceId,current,b.attachmentId);
      return menus.questionAction(action,device.deviceId,id,current,b);
    }));
  }
  function modelAction(req,device,id,action,b) {
    const operationId=operationInput(req,b);
    const allowed=action==='model'?['operationId','attachmentId']:action==='model-select'?['operationId','attachmentId','menuId','option']
      :action==='model-key'?['operationId','attachmentId','menuId','key']:['operationId','attachmentId','menuId'];
    if(Object.keys(b).some(key=>!allowed.includes(key))) reject('invalid_model_selection','Unsupported model selection input.');
    if(action!=='model'&&(typeof b.menuId!=='string'||!/^[a-f0-9]{64}$/.test(b.menuId))) reject('invalid_model_selection','Refresh the model choices before continuing.');
    if(action==='model-select'&&(!Number.isInteger(b.option)||b.option<0||b.option>99)) reject('invalid_model_selection','Choose a visible model option.');
    if(action==='model-key'&&!['up','down'].includes(b.key)) reject('invalid_model_selection','Choose a supported model navigation key.');
    // Every mutation revalidates the device, the pane attachment, the pane
    // identity/status and the live menu identity before any key is sent.
    // Receipts keep uncertain delivery inspectable, never auto-retried.
    const input={paneId:id,menuId:b.menuId??null,option:b.option??null,key:b.key??null};
    return operations.run(device.deviceId,operationId,`pane.${action}`,input,()=>locked(id,async()=>{
      const current=await pane(id);
      paneAttachments.validate(device.deviceId,current,b.attachmentId);
      return menus.modelAction(action,device.deviceId,id,current,b);
    }));
  }
  async function sendKeys(device,id,action,b) {
    if(action==='keys'&&(!Array.isArray(b.keys)||b.keys.length!==1||b.keys.some(k=>!keys.has(k)))) reject('invalid_keys','Choose one supported key.');
    const target=await pane(id);
    paneAttachments.validate(device.deviceId,target,b.attachmentId);
    if(!target.agent) requireAccess(store,device,'terminal',config);
    return dispatchInput(target,()=>herdr.call('pane.send_keys',{pane_id:id,keys:action==='stop'?['ctrl+c']:b.keys}),
      action==='keys'&&b.keys.includes('enter')?'completed':'none');
  }
  async function prompt(device,id,current,b,completion,attention) {
    paneAttachments.validate(device.deviceId,current,b.attachmentId);
    if(!current.agent) reject('agent_unavailable','This pane has no detected agent. Use terminal input instead.',409);
    const input=attachments.prompt(b.text??'',b.attachmentIds,current,id,device.deviceId);
    const submitted=await dispatchInput(current,()=>promptAgent(herdr,id,input,current));
    const completionCleared=push.acknowledge?.(id,completion);
    const attentionCleared=push.acknowledgeAttention?.(id,attention);
    const latest=ctx.latest();
    if((completionCleared||attentionCleared)&&latest) void ctx.publish(push.annotate?.(latest)??latest);
    return submitted;
  }
  async function restart(id,current) {
    if(!kinds.has(current.agent)) reject('restart_unsupported','Restart is supported only for Codex, Claude Code and OpenCode.',409);
    const agentInfo=(await herdr.call('agent.get',{target:id})).agent;
    const cwd=canonicalDirectory(current.cwd);
    if(!cwd||!ctx.associatedProject(cwd)) reject('project_not_allowed','Restart requires a home folder or configured project.',403);
    // Create replacement before closing to preserve its workspace even when old pane was last.
    const created=await herdr.call('tab.create',{workspace_id:current.workspace_id,cwd,label:'Restart',focus:false});
    const replacement=created.root_pane.pane_id;
    try { await herdr.call('pane.close',{pane_id:id}); }
    catch(e) { await herdr.call('pane.close',{pane_id:replacement}).catch(()=>{}); throw e; }
    try { await launcher.startAgent(replacement,current.agent,agentInfo?.name||`remote-${Date.now().toString(36)}`); }
    catch(e) { e.message+=` Replacement pane ${replacement} was retained; refresh to inspect it.`;e.paneId=replacement;throw e; }
    launcher.rememberDirectory(cwd);
    return {paneId:replacement};
  }
  async function act(device,id,action,b) {
    const completion=action==='prompt'?push.completionFor?.(id):null;
    const attention=action==='prompt'?push.attentionFor?.(id):null;
    if(action==='keys' || action==='stop') return sendKeys(device,id,action,b);
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
    if(action==='prompt') return prompt(device,id,current,b,completion,attention);
    if(action==='input') {
      paneAttachments.validate(device.deviceId,current,b.attachmentId);
      if(!current.agent) requireAccess(store,device,'terminal',config);
      if(typeof b.text!=='string'||!b.text.length||b.text.length>16000||/[\u0000-\u0008\u000b-\u001f\u007f]/.test(b.text))
        reject('invalid_input','Enter up to 16000 characters of terminal text without control characters.');
      return dispatchInput(current,()=>herdr.call('pane.send_input',{pane_id:id,text:b.text}),b.text.includes('\n')?'completed':'none');
    }
    return restart(id,current);
  }
  return async(req,res,url,device)=>{
    const attachmentDelete=url.pathname.match(/^\/v1\/panes\/([^/]+)\/attachments\/([^/]+)$/);
    const previewRoute=url.pathname.match(/^\/v1\/panes\/([^/]+)\/preview(?:\/([a-f0-9]{32}))?$/);
    if(req.method==='GET'&&previewRoute) return preview(req,res,url,device,previewRoute);
    const projectArtifact=url.pathname.match(/^\/v1\/panes\/([^/]+)\/artifacts\/(project-[a-f0-9]{64})$/);
    if(req.method==='GET'&&projectArtifact) return artifact(req,res,projectArtifact);
    if(req.method==='DELETE'&&attachmentDelete) {
      let paneId,attachmentId;
      try{paneId=decodeURIComponent(attachmentDelete[1]);attachmentId=decodeURIComponent(attachmentDelete[2]);}catch{reject('invalid_attachment','Invalid attachment ID.');}
      const remove=()=>attachments.remove(attachmentId,device.deviceId,paneId);
      return respond(res,200,await operations.run(device.deviceId,operationInput(req),'attachment.delete',{paneId,attachmentId},remove));
    }
    const match=url.pathname.match(actions);
    if(!match) reject('not_found','Unknown endpoint.',404);
    const id=paneParam(match[1]);
    const action=match[2];
    if(req.method==='GET'&&action==='files') {
      onlyParams(url,['directory','cursor'],'invalid_directory','Use one project directory and optional page cursor.');
      const current=await pane(id);
      return respond(res,200,listProjectFiles(config,current.foreground_cwd||current.cwd,url.searchParams.get('directory')??'',url.searchParams.get('cursor')));
    }
    if(req.method==='GET'&&action==='history') return respond(res,200,await readHistory(url,id));
    if(req.method==='GET'&&action==='attachments') return respond(res,200,attachments.list(device.deviceId,id));
    if(req.method==='GET'&&action==='review') {
      const current=await pane(id); return respond(res,200,await reviewProject(config,current.foreground_cwd||current.cwd,attachments,device.deviceId,id));
    }
    if(req.method==='GET'&&action==='output') return respond(res,200,await output(device,id));
    if(req.method==='POST'&&questionActions.includes(action)) return respond(res,200,await questionAction(req,device,id,action,await body(req)));
    if(req.method==='POST'&&modelActions.includes(action)) return respond(res,200,await modelAction(req,device,id,action,await body(req)));
    if(req.method==='POST'&&action==='attachments') {
      const result=await locked(id,async()=>attachments.upload(req,await pane(id),id,device.deviceId,()=>pane(id)));
      return respond(res,201,result);
    }
    if(req.method==='DELETE'&&!action) {
      const close=()=>locked(id,()=>herdr.call('pane.close',{pane_id:id}));
      return respond(res,200,await operations.run(device.deviceId,operationInput(req),'pane.close',{paneId:id},close));
    }
    if(req.method!=='POST'||!inputActions.includes(action)) reject('not_found','Unknown endpoint.',404);
    const b=await body(req);
    const operationId=operationInput(req,b);
    const result=await operations.run(device.deviceId,operationId,`pane.${action}`,{paneId:id,body:{...b,operationId:undefined}},
      ()=>locked(id,()=>act(device,id,action,b)));
    respond(res,200,result?.paneId?result:{...result,ok:true});
  };
}
