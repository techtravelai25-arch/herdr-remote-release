import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {BridgeError} from './herdr.js';
import {associatedProject, within} from './projects.js';
import {openProjectArtifact} from './artifacts.js';
import {paneIdentity} from './pane-attachment.js';

const CHUNK = 128 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_SESSION_BYTES = 40 * 1024 * 1024;
const MAX_CACHED_BYTES = 80 * 1024 * 1024;
const MAX_SESSIONS = 16;
const MAX_ASSETS = 64;
const TTL = 15 * 60 * 1000;
const TYPES = new Map(Object.entries({
  '.html':'text/html', '.htm':'text/html', '.css':'text/css', '.js':'text/javascript',
  '.mjs':'text/javascript', '.json':'application/json', '.png':'image/png',
  '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp',
  '.svg':'image/svg+xml', '.ico':'image/x-icon', '.woff':'font/woff',
  '.woff2':'font/woff2', '.ttf':'font/ttf', '.otf':'font/otf',
}));
const credentialExtension = /\.(?:pem|key|keystore|jks|p8|p12|pfx|env|token|kdbx|tfvars|gpg|asc|ovpn)(?:\.(?:bak|backup|old|orig|save))?$/i;
const credentialName = /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|authorized_keys|credentials|secrets)(?:\..*)?$/i;
const fail = (code, message, status=400) => { throw new BridgeError(code,message,status); };
const denyLocalhost = () => fail('permission_denied','Local page previews require control access.',403);

function parts(value, allowLavish=false) {
  if(typeof value !== 'string' || !value || Buffer.byteLength(value)>768 || value.startsWith('/') || /[%\\\u0000-\u001f\u007f?#]/.test(value))
    fail('invalid_preview_path','Choose a file inside the selected page folder.');
  const pieces=value.split('/');
  if(pieces.some((p,i)=>!p || p==='.' || p==='..' || p.startsWith('.') && !(allowLavish && i===0 && p==='.lavish') || credentialExtension.test(p) || credentialName.test(p)))
    fail('invalid_preview_path','This file path is not available for preview.');
  return pieces;
}

function contentType(name) {
  const type=TYPES.get(path.extname(name).toLowerCase());
  if(!type) fail('unsupported_preview_file','This file type cannot be loaded in the page.',415);
  return type;
}

function canonicalPaneRoot(config,pane) {
  const cwd=pane.foreground_cwd||pane.cwd;
  let root;try {root=fs.realpathSync(cwd);}catch{fail('preview_unavailable','The session folder is unavailable.',409);}
  if(!associatedProject(config,root))fail('project_not_allowed','Files are available only inside an approved project.',403);
  return root;
}

function fileBytes(file,root,beforeRead=()=>{}) {
  let fd;
  try {
    if(!within(root,file) || fs.realpathSync(file)!==file) throw Error('path');
    fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||stat.size>MAX_FILE||
       fs.realpathSync(file)!==file||fs.realpathSync(`/proc/self/fd/${fd}`)!==file)throw Error('changed');
    beforeRead(stat.size);
    const bytes=Buffer.alloc(stat.size);
    let offset=0;
    while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)throw Error('short');offset+=n;}
    const after=fs.fstatSync(fd);
    if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ino!==stat.ino||after.dev!==stat.dev)throw Error('changed');
    return bytes;
  }catch(error){if(error instanceof BridgeError)throw error;fail('preview_file_changed','The page file changed or is unavailable. Open it again.',409);}
  finally{if(fd!==undefined)fs.closeSync(fd);}
}

function loopbackTarget(raw,bridgePort) {
  if(/(?:^|\/)(?:\.{1,2}|%2e(?:%2e)?)(?:\/|%2f|$)/i.test(raw))
    fail('invalid_preview_target','The page URL contains an unsafe path.');
  let parsed;try{parsed=new URL(raw);}catch{fail('invalid_preview_target','Choose an HTML file or local page URL.');}
  if(parsed.protocol!=='http:' || !['localhost','127.0.0.1','[::1]'].includes(parsed.hostname) ||
     !parsed.port || Number(parsed.port)<1024 || Number(parsed.port)>65535 || Number(parsed.port)===bridgePort ||
     parsed.username || parsed.password || parsed.search)
    fail('invalid_preview_target','Use a local HTTP page with an explicit port and no query or credentials.');
  let pathname;
  try{pathname=decodeURIComponent(parsed.pathname);}catch{fail('invalid_preview_target','The page URL is invalid.');}
  if(/%2f|%5c/i.test(parsed.pathname)||pathname.includes('\\')||pathname.includes('\0')||pathname.split('/').includes('..'))
    fail('invalid_preview_target','The page URL contains an unsafe path.');
  if(pathname.split('/').filter(Boolean).some(part=>part.startsWith('.')||credentialExtension.test(part)||credentialName.test(part)))
    fail('invalid_preview_target','This local page path is not available for preview.');
  const entry=pathname.endsWith('/')?'index.html':path.posix.basename(pathname);
  parts(entry);
  if(contentType(entry)!=='text/html')fail('unsupported_preview_file','Choose an HTML page.',415);
  const directory=pathname.endsWith('/')?pathname:pathname.slice(0,pathname.lastIndexOf('/')+1);
  // Always connect to numeric loopback; the original hostname never triggers DNS.
  return {host:parsed.hostname==='[::1]'?'[::1]':'127.0.0.1',port:Number(parsed.port),directory,entryPath:entry,entryRequestPath:pathname};
}

async function localhostBytes(session,relative,fetchImpl) {
  const url=new URL(`http://${session.host}:${session.port}`);
  url.pathname=relative===session.entryPath?session.entryRequestPath:
    session.directory+relative.split('/').map(encodeURIComponent).join('/');
  const response=await fetchImpl(url,{method:'GET',redirect:'manual',headers:{accept:'*/*'},signal:AbortSignal.timeout(8000)});
  if(!response.ok || response.status>=300)fail('preview_file_unavailable','The local page resource is unavailable.',404);
  const reported=Number(response.headers.get('content-length'));
  if(Number.isFinite(reported)&&reported>MAX_FILE)fail('preview_file_too_large','This page resource exceeds 20 MB.',413);
  const chunks=[];let total=0;
  for await(const chunk of response.body||[]){total+=chunk.length;if(total>MAX_FILE)fail('preview_file_too_large','This page resource exceeds 20 MB.',413);chunks.push(chunk);}
  return Buffer.concat(chunks,total);
}

/** Private native-API page preview. No URL or credential is sent to page JavaScript. */
export function createHtmlPreview({config,bridgePort=()=>0,fetchImpl=fetch,now=Date.now}={}) {
  const sessions=new Map();
  let reservedBytes=0;
  function prune(){for(const [id,s] of sessions)if(s.expires<=now())sessions.delete(id);}
  function makeRoom(amount,session) {
    let cached=[...sessions.values()].reduce((sum,s)=>sum+s.total,0);
    for(const [id,old] of sessions){
      if(cached+reservedBytes+amount<=MAX_CACHED_BYTES)break;
      if(old===session||old.active>0)continue;
      cached-=old.total;sessions.delete(id);
    }
    if(cached+reservedBytes+amount>MAX_CACHED_BYTES)
      fail('preview_limit','Page preview memory is full. Open the page again.',429);
  }
  // `authorizeLocalhost` throws unless the device may make the bridge fetch
  // loopback pages (write access); it is checked on creation and every read.
  async function create({deviceId,pane,target,artifactId,authorizeLocalhost=denyLocalhost}) {
    prune();
    if(sessions.size>=MAX_SESSIONS){
      const oldest=[...sessions].find(([,s])=>s.active===0)?.[0];
      if(oldest)sessions.delete(oldest);
      else fail('preview_limit','Too many pages are open. Close a preview and try again.',429);
    }
    if((target===undefined)===(artifactId===undefined))fail('invalid_preview_target','Choose one HTML page to preview.');
    const root=canonicalPaneRoot(config,pane),identity=paneIdentity(pane);
    let source='file',entryPath,base,host,port,directory,entryRequestPath;
    if(artifactId!==undefined){
      if(typeof artifactId!=='string'||!/^project-[a-f0-9]{64}$/.test(artifactId))fail('invalid_preview_target','Invalid file reference.');
      const opened=openProjectArtifact(config,root,artifactId);
      fs.closeSync(opened.fd);
      if(contentType(opened.name)!=='text/html')fail('unsupported_preview_file','Choose an HTML page.',415);
      base=path.dirname(opened.file);entryPath=path.basename(opened.file);
    }else if(typeof target==='string'&&/^http:/i.test(target)){
      authorizeLocalhost();
      source='localhost';({host,port,directory,entryPath,entryRequestPath}=loopbackTarget(target,bridgePort()));
    }else{
      if(typeof target!=='string')fail('invalid_preview_target','Choose an HTML file or local page URL.');
      let file=target;
      if(target.startsWith('file:'))try{
        const fileUrl=new URL(target);if(fileUrl.search)throw Error();
        fileUrl.hash='';
        fileUrl.pathname=fileUrl.pathname.replace(/\.(html?)%3A\d+$/i,'.$1').replace(/\.(html?):\d+$/i,'.$1');
        file=fileURLToPath(fileUrl);
      }catch{fail('invalid_preview_target','The file URL is invalid.');}
      else file=file.split('#',1)[0].replace(/\.(html?):\d+$/i,'.$1')
        .replace(/^\.\//,'').replace(/%20/gi,' ');
      const relative=path.isAbsolute(file)?path.relative(root,file):file;
      parts(relative,true);
      if(contentType(relative)!=='text/html')fail('unsupported_preview_file','Choose an HTML page.',415);
      const resolved=path.join(root,relative);
      if(!within(root,resolved))fail('invalid_preview_target','The page is outside this session folder.');
      base=path.dirname(resolved);entryPath=path.basename(resolved);
    }
    const id=randomBytes(16).toString('hex');
    const session={id,deviceId,paneId:pane.pane_id,identity,root,source,base,host,port,directory,entryPath,entryRequestPath,
      expires:now()+TTL,assets:new Map(),pending:new Map(),total:0,active:1};
    sessions.set(id,session);
    // Retain the pending session so concurrent creations count toward the
    // global memory budget; remove it if its entry cannot be loaded.
    try{await load(session,entryPath);}catch(error){sessions.delete(id);throw error;}
    finally{session.active--;}
    return {id,title:entryPath,entryPath,source};
  }
  async function load(session,relative) {
    parts(relative);const type=contentType(relative);
    const asset=session.assets.get(relative);
    if(asset)return asset;
    if(session.pending.has(relative))return session.pending.get(relative);
    const loading=(async()=>{
      if(session.assets.size+session.pending.size>=MAX_ASSETS)fail('preview_limit','This page requested too many resources.',429);
      let bytes;
      if(session.source==='file'){
        const file=path.join(session.base,relative);
        if(!within(session.base,file))fail('invalid_preview_path','The resource is outside this page folder.');
        bytes=fileBytes(file,session.root,size=>makeRoom(size,session));
      }else{
        // A slow local server cannot let concurrent reads allocate beyond the
        // aggregate cap while their content lengths are still unknown.
        makeRoom(MAX_FILE,session);reservedBytes+=MAX_FILE;
        try{bytes=await localhostBytes(session,relative,fetchImpl);}
        finally{reservedBytes-=MAX_FILE;}
      }
      if(session.total+bytes.length>MAX_SESSION_BYTES)fail('preview_limit','This page exceeds the preview size limit.',413);
      makeRoom(bytes.length,session);
      const result={bytes,contentType:type};session.assets.set(relative,result);session.total+=bytes.length;
      return result;
    })();
    session.pending.set(relative,loading);
    try{return await loading;}finally{session.pending.delete(relative);}
  }
  async function read({deviceId,pane,id,relative,offset,authorizeLocalhost=denyLocalhost}) {
    prune();const s=sessions.get(id);
    if(!s||s.deviceId!==deviceId||s.paneId!==pane.pane_id)fail('preview_expired','Open the page again.',404);
    if(s.source==='localhost')authorizeLocalhost();
    if(s.identity!==paneIdentity(pane)||s.root!==canonicalPaneRoot(config,pane)){
      sessions.delete(id);fail('preview_changed','The session changed. Open the page again.',409);
    }
    if(typeof relative!=='string')fail('invalid_preview_path','Choose a page resource.');
    if(typeof offset!=='string'||!/^(0|[1-9]\d*)$/.test(offset)||!Number.isSafeInteger(Number(offset)))
      fail('invalid_preview_offset','Invalid page offset.');
    s.active++;
    try{
      const asset=await load(s,relative),at=Number(offset);
      if(at>asset.bytes.length)fail('invalid_preview_offset','Invalid page offset.');
      const data=asset.bytes.subarray(at,at+CHUNK);
      return {data:data.toString('base64url'),contentType:asset.contentType,size:asset.bytes.length,offset:at,eof:at+data.length>=asset.bytes.length};
    }finally{s.active--;}
  }
  return {create,read};
}
