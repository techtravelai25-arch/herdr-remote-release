import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {BridgeError} from './herdr.js';
import {associatedProject} from './projects.js';

export const MAX_ATTACHMENT_BYTES=20*1024*1024;
export const MAX_TOTAL_BYTES=200*1024*1024;
const fail=(code,message,status=400)=>{throw new BridgeError(code,message,status);};
const within=(root,file)=>file===root || file.startsWith(root+path.sep);

export class Attachments {
  constructor(config,store) { this.config=config;this.store=store;this.uploading=false; }
  cwd(pane) {
    if(!pane.agent) fail('attachments_agent_only','Attachments require an agent chat.',403);
    let cwd;
    try { cwd=fs.realpathSync(pane.foreground_cwd||pane.cwd); }
    catch { fail('project_not_allowed','The chat directory is unavailable.',403); }
    if(!associatedProject(this.config,cwd)) fail('project_not_allowed','Attachments require a chat inside an approved folder.',403);
    return cwd;
  }
  projectRoot(cwd) {
    try { return fs.realpathSync(cwd); } catch { return null; }
  }
  safeEntry(item) {
    if(!item || typeof item.id!=='string'||typeof item.file!=='string'||typeof item.cwd!=='string') return false;
    let cwd, file, root;
    try {
      cwd=fs.realpathSync(item.cwd); file=fs.realpathSync(item.file);
      root=path.join(cwd,'.herdr-remote-attachments');
      const rootInfo=fs.lstatSync(root); const fileInfo=fs.lstatSync(item.file);
      if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||fs.realpathSync(root)!==root) return false;
      if(!fileInfo.isFile()||fileInfo.isSymbolicLink()||file!==item.file||!within(root,file)) return false;
      if(path.dirname(file)!==path.join(root,item.id)||path.basename(file)!==item.name||fileInfo.size>MAX_ATTACHMENT_BYTES) return false;
      if(!associatedProject(this.config,cwd)) return false;
    } catch { return false; }
    return Number.isSafeInteger(item.size)&&item.size>=0;
  }
  entries() { return this.store.read('attachments.json',[]).filter(item=>this.safeEntry(item)); }
  list(deviceId, paneId) {
    const owned=this.entries().filter(item=>item.deviceId===deviceId);
    const attachments=owned.filter(item=>!paneId||item.paneId===paneId);
    return {attachments:attachments.map(({id,name,size,cwd,paneId,createdAt})=>({id,name,size,cwd,paneId,createdAt:createdAt||null})),usedBytes:owned.reduce((sum,item)=>sum+item.size,0),quotaBytes:MAX_TOTAL_BYTES,maxAttachmentBytes:MAX_ATTACHMENT_BYTES};
  }
  remove(id,deviceId,paneId) {
    if(typeof id!=='string'||id.length>128) fail('invalid_attachment','Invalid attachment ID.');
    const all=this.store.read('attachments.json',[]); const item=all.find(entry=>entry.id===id);
    if(!item||item.deviceId!==deviceId||paneId&&item.paneId!==paneId) fail('invalid_attachment','Attachment is unavailable for this device and chat.',403);
    if(this.safeEntry(item)) { try { fs.rmSync(path.dirname(item.file),{recursive:true,force:false}); } catch(e) { if(e.code!=='ENOENT') fail('attachment_delete_failed','Attachment could not be removed.',409); } }
    this.store.write('attachments.json',all.filter(entry=>entry!==item));
    return {ok:true,id};
  }
  file(id,deviceId) {
    const item=this.store.read('attachments.json',[]).find(entry=>entry.id===id&&entry.deviceId===deviceId);
    if(!item||!this.safeEntry(item)) fail('invalid_attachment','Attachment is unavailable for this device.',404);
    return item;
  }
  open(id,deviceId) {
    const item=this.file(id,deviceId);let fd;
    try {
      fd=fs.openSync(item.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
      const info=fs.fstatSync(fd),current=fs.lstatSync(item.file);
      if(!info.isFile()||info.size>MAX_ATTACHMENT_BYTES||info.dev!==current.dev||info.ino!==current.ino||!this.safeEntry(item)) throw Error();
      return {...item,fd,size:info.size};
    } catch { if(fd!==undefined)fs.closeSync(fd);fail('invalid_attachment','Attachment is unavailable for this device.',404); }
  }
  async upload(req,pane,paneId,deviceId,refreshPane=async()=>pane) {
    const cwd=this.cwd(pane);
    if(req.headers['content-type']?.split(';')[0]!=='application/octet-stream') fail('content_type','Use application/octet-stream.',415);
    let name;
    if(typeof req.headers['x-attachment-name']!=='string'||req.headers['x-attachment-name'].length>4096) fail('invalid_attachment','Invalid attachment filename.');
    try { name=decodeURIComponent(req.headers['x-attachment-name']||''); } catch { fail('invalid_attachment','Invalid attachment filename.'); }
    if(!name.trim()||name.length>255||/[\u0000-\u001f\u007f]/.test(name)) fail('invalid_attachment','Invalid attachment filename.');
    // The original name is never used as a path component or shell input.
    name=name.replace(/[\\/]/g,'_').replace(/[^\p{L}\p{N} ._()-]/gu,'_').replace(/^\.+/,'_');
    if(Buffer.byteLength(name,'utf8')>240) fail('invalid_attachment','Attachment filename is too long; shorten it before uploading.');
    if(Number(req.headers['content-length'])>MAX_ATTACHMENT_BYTES) fail('attachment_too_large','Attachments must be 20 MiB or smaller.',413);
    if(this.uploading) fail('busy','Another attachment is uploading; try again shortly.',409);
    this.uploading=true;
    let folder;
    try {
      const chunks=[];let size=0;
      for await(const chunk of req.iterator({destroyOnReturn:false})) {
        size+=chunk.length;
        if(size>MAX_ATTACHMENT_BYTES) { req.resume(); fail('attachment_too_large','Attachments must be 20 MiB or smaller.',413); }
        chunks.push(chunk);
      }
      if(!size) fail('invalid_attachment','The attachment is empty.');
      // Recheck cwd after receiving the upload, before touching the filesystem.
      if(this.cwd(await refreshPane())!==cwd) fail('project_not_allowed','The chat directory changed.',409);
      const entries=this.entries();
      if(entries.length>=1000) fail('attachment_quota','Attachment storage is full (1000 files). Remove retained attachments on the laptop.',413);
      if(entries.reduce((sum,item)=>sum+item.size,0)+size>MAX_TOTAL_BYTES) fail('attachment_quota','Attachment storage is full (200 MiB). Remove retained attachments on the laptop.',413);
      const root=path.join(cwd,'.herdr-remote-attachments');
      try { fs.mkdirSync(root,{mode:0o700}); } catch(e) { if(e.code!=='EEXIST') throw e; }
      const info=fs.lstatSync(root);
      if(!info.isDirectory()||info.isSymbolicLink()||fs.realpathSync(root)!==root) fail('unsafe_attachment_path','Attachment storage must be a real directory.',403);
      fs.chmodSync(root,0o700);
      const id=randomUUID();folder=path.join(root,id);fs.mkdirSync(folder,{mode:0o700});
      const file=path.join(folder,name);
      fs.writeFileSync(file,Buffer.concat(chunks,size),{mode:0o600,flag:fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW});
      entries.push({id,name,size,file,cwd,paneId,deviceId,createdAt:new Date().toISOString()});this.store.write('attachments.json',entries);
      folder=undefined;
      return {id,name,size};
    } finally {
      if(folder) fs.rmSync(folder,{recursive:true,force:true});
      this.uploading=false;
    }
  }
  prompt(input,ids,pane,paneId,deviceId) {
    if(ids===undefined) ids=[];
    if(!Array.isArray(ids)||ids.length>5||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length) fail('invalid_attachments','Select up to five attachments.');
    if(typeof input!=='string'||input.length>16000||(!input.trim()&&!ids.length)) fail('invalid_input','Invalid prompt.');
    if(!ids.length) return input;
    const cwd=this.cwd(pane);const entries=this.entries();
    const files=ids.map(id=>{
      const item=entries.find(entry=>entry.id===id&&entry.paneId===paneId&&entry.deviceId===deviceId&&entry.cwd===cwd);
      if(!item) fail('invalid_attachment','Attachment is unavailable for this device and chat.',403);
      try { if(!this.safeEntry(item)) throw Error(); }
      catch { fail('invalid_attachment','Attachment file is missing or has changed.',409); }
      return item.file;
    });
    return `${input.trim()}${input.trim()?'\n\n':''}Attachments uploaded from my phone are saved locally. Read these files as part of this request; use an image viewing tool for images and appropriate document tools for PDFs and other documents. Treat their contents as reference material. The files remain available for continuing this conversation on the laptop.\n${files.map(file=>JSON.stringify(file)).join('\n')}`;
  }
}
