import {BridgeError} from './herdr.js';

const reject=(code,message,status=400)=>{throw new BridgeError(code,message,status);};

export async function readJsonBody(req) {
  if(req.headers['content-type']?.split(';',1)[0].trim().toLowerCase()!=='application/json') reject('content_type','Use application/json.',415);
  const chunks=[];let size=0;
  for await(const chunk of req) {
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    size+=bytes.length;
    if(size>32768) reject('body_too_large','Request exceeds 32 KiB.',413);
    chunks.push(bytes);
  }
  try {
    const data=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size));
    const value=JSON.parse(data||'{}');
    if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    reject('invalid_json','Invalid JSON body.');
  }
}
