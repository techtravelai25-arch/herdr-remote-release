import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {requireAccess} from './access.js';
const LIMIT=20*1024*1024,CHUNK=128*1024;

function processStartTime(pid){
  try{
    const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8'),end=stat.lastIndexOf(') ');
    if(end<0)return null;
    const start=stat.slice(end+2).trim().split(/\s+/)[19];
    return /^\d+$/.test(start||'')?start:null;
  }catch(error){return error.code==='ENOENT'?false:null;}
}

function privateTransferRoot(store){
  const root=path.join(store.dir,'relay-transfers');
  try{fs.mkdirSync(root,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  const stat=fs.lstatSync(root);
  if(!stat.isDirectory()||(process.platform!=='win32'&&(stat.uid!==process.getuid()||(stat.mode&0o077)!==0)))throw Error('Relay transfer directory is not private');
  return root;
}

function recoverCrashedSessions(root,selfStart){
  if(process.platform!=='linux'||typeof selfStart!=='string')return;
  for(const item of fs.readdirSync(root,{withFileTypes:true})){
    const match=/^session-([1-9]\d*)-(\d+)-([A-Za-z0-9]{6})$/.exec(item.name);
    if(!match||!item.isDirectory())continue;
    const file=path.join(root,item.name);
    let stat;
    try{stat=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    if(!stat.isDirectory()||stat.uid!==process.getuid()||(stat.mode&0o077)!==0)continue;
    const ownerStart=processStartTime(match[1]);
    // Match process start time as well as PID, since PIDs can be reused.
    // An unreadable /proc entry is not evidence that its owner has exited.
    if(ownerStart!==null&&ownerStart!==match[2])fs.rmSync(file,{recursive:true,force:true});
  }
}

export function createTransfers({store,port,fetchImpl=fetch,now=Date.now}){
  const root=privateTransferRoot(store),selfStart=process.platform==='linux'?processStartTime(process.pid):null;
  recoverCrashedSessions(root,selfStart);
  const entries=new Map(),dir=fs.mkdtempSync(path.join(root,`session-${process.pid}-${selfStart||'unknown'}-`));
  const remove=id=>{const entry=entries.get(id);if(entry)fs.rmSync(entry.file,{force:true});entries.delete(id);};
  const cleanup=()=>{for(const [id,e] of entries)if(e.expires<now())remove(id);};
  const timer=setInterval(cleanup,30000);timer.unref();
  const json=(status,value)=>({status,headers:{'content-type':'application/json'},bytes:Buffer.from(JSON.stringify(value))});
  async function handle(req){
    cleanup();const auth=req.headers.authorization||'',device=store.authenticate(auth.startsWith('Bearer ')?auth.slice(7):'');if(!device)return json(401,{error:'unauthorized'});
    const url=new URL(req.path,'http://localhost');
    // Authorize the same normalized route used below, including encoded dot segments.
    try {requireAccess(store,device,url.pathname.startsWith('/v1/relay-transfer/upload')?'write':'read');}
    catch {return json(403,{error:'permission_denied'});}
    const owner=createHash('sha256').update(auth).digest('hex');
    let input={};if(req.body.length)try{input=JSON.parse(req.body.toString());}catch{return json(400,{error:'invalid_json'});}
    const base=url.pathname.match(/^\/v1\/relay-transfer\/(upload|download)$/),item=url.pathname.match(/^\/v1\/relay-transfer\/(upload|download)\/([a-f0-9-]{36})(\/finish)?$/);
    if(base&&req.method==='POST'){
      if(entries.size>=2)return json(429,{error:'transfer_limit'});
      const type=base[1],id=randomUUID(),file=path.join(dir,id),entry={type,file,owner,expires:now()+300000,size:0,offset:0,headers:{}};
      if(type==='upload'){
        if(typeof input.paneId!=='string'||input.paneId.length>256||typeof input.name!=='string'||input.name.length>255||/[\r\n]/.test(input.name)||!Number.isSafeInteger(input.size)||input.size<1||input.size>LIMIT)return json(400,{error:'invalid_upload'});
        entry.size=input.size;entry.paneId=input.paneId;entry.name=input.name;fs.writeFileSync(file,'',{mode:0o600,flag:'wx'});
      }else{
        if(typeof input.path!=='string'||!(/^\/v1\/attachments\/[A-Za-z0-9_-]+\/content$/.test(input.path)||/^\/v1\/panes\/[A-Za-z0-9_%:.-]+\/artifacts\/project-[a-f0-9]{64}$/.test(input.path)))return json(400,{error:'invalid_download'});
        // Reserve a slot before awaiting network IO.
        entries.set(id,entry);
        try{
          const res=await fetchImpl(`http://127.0.0.1:${port}${input.path}`,{headers:{authorization:auth},redirect:'error',signal:AbortSignal.timeout(60000)});
          if(!res.ok){remove(id);return json(res.status,{error:'download_failed'});}
          for(const name of ['content-type','content-disposition'])if(res.headers.has(name))entry.headers[name]=res.headers.get(name);
          fs.writeFileSync(file,'',{mode:0o600,flag:'wx'});
          for await(const bytes of res.body||[]){entry.size+=bytes.length;if(entry.size>LIMIT)throw Error();fs.appendFileSync(file,bytes);}
        }catch{remove(id);return json(502,{error:'download_failed'});}
      }
      entries.set(id,entry);return json(200,{transferId:id,size:entry.size,headers:entry.headers});
    }
    if(!item)return json(404,{error:'not_found'});
    const [,,id,finish]=item,entry=entries.get(id);if(!entry||entry.owner!==owner||entry.type!==item[1])return json(404,{error:'transfer_expired'});
    if(req.method==='DELETE'){remove(id);return json(200,{ok:true});}
    if(entry.busy)return json(409,{error:'transfer_busy'});
    if(entry.type==='upload'&&req.method==='POST'&&!finish){
      if(input.offset!==entry.offset||typeof input.data!=='string'||input.data.length>Math.ceil(CHUNK*4/3)||!/^[A-Za-z0-9_-]+$/.test(input.data))return json(400,{error:'invalid_chunk'});
      const bytes=Buffer.from(input.data,'base64url');if(bytes.length>CHUNK||entry.offset+bytes.length>entry.size)return json(400,{error:'invalid_chunk'});
      fs.appendFileSync(entry.file,bytes);entry.offset+=bytes.length;return json(200,{offset:entry.offset});
    }
    if(entry.type==='upload'&&req.method==='POST'&&finish){
      if(entry.offset!==entry.size)return json(400,{error:'incomplete_upload'});entry.busy=true;
      try{const res=await fetchImpl(`http://127.0.0.1:${port}/v1/panes/${encodeURIComponent(entry.paneId)}/attachments`,{method:'POST',headers:{authorization:auth,'content-type':'application/octet-stream','x-attachment-name':encodeURIComponent(entry.name),'content-length':String(entry.size)},body:fs.createReadStream(entry.file),duplex:'half',redirect:'error',signal:AbortSignal.timeout(60000)});const bytes=Buffer.from(await res.arrayBuffer());if(bytes.length>128*1024)throw Error();return {status:res.status,headers:{'content-type':'application/json'},bytes};}catch{return json(502,{error:'upload_failed'});}finally{remove(id);}
    }
    if(entry.type==='download'&&req.method==='GET'&&!finish){const offset=Number(url.searchParams.get('offset'));if(!Number.isSafeInteger(offset)||offset<0||offset>entry.size)return json(400,{error:'invalid_offset'});const bytes=Buffer.alloc(Math.min(CHUNK,entry.size-offset)),fd=fs.openSync(entry.file,'r');try{fs.readSync(fd,bytes,0,bytes.length,offset);}finally{fs.closeSync(fd);}return json(200,{data:bytes.toString('base64url'),eof:offset+bytes.length>=entry.size,size:entry.size});}
    return json(405,{error:'method_not_allowed'});
  }
  return {handle,close(){clearInterval(timer);for(const id of entries.keys())remove(id);fs.rmSync(dir,{recursive:true,force:true});}};
}
