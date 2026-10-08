import {BridgeError} from './herdr.js';

const secureHeaders={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
export const reject=(code,message,status=400)=>{ throw new BridgeError(code,message,status); };
export function text(value,max,label) {
  if(typeof value!=='string' || !value.trim() || value.length>max) throw new BridgeError('invalid_input',`Invalid ${label}.`);
  return value;
}
export function respond(res,status,value) {
  res.writeHead(status,{'Content-Type':'application/json',...secureHeaders});
  res.end(JSON.stringify(value));
}
/** Write download headers with the bridge's standard no-store/no-sniff policy. */
export const writeDownloadHead=(res,headers)=>res.writeHead(200,{...headers,...secureHeaders});
/** Decode and bound an opaque Herdr pane ID taken from a URL path segment. */
export function paneParam(raw) {
  let id; try {id=decodeURIComponent(raw);} catch {reject('invalid_pane','Invalid pane identifier.');}
  // Herdr IDs are opaque handles, not decimal counters (e.g. w1Y:p1).
  // Bound transport input; let the installed Herdr API resolve the handle.
  // IDs are sent only as JSON fields to fixed methods, never shell commands.
  if(!id || id.length>256 || /[\u0000-\u001f\u007f]/.test(id)) reject('invalid_pane','Invalid pane identifier.');
  return id;
}
/** Reject unknown or repeated query parameters. */
export function onlyParams(url,allowed,code,message) {
  if([...url.searchParams.keys()].some(key=>!allowed.includes(key))||allowed.some(key=>url.searchParams.getAll(key).length>1))
    reject(code,message);
}
/** Fixed-window request counters. Bounds are global: proxy IP headers are never trusted. */
export function createRateLimiter() {
  const buckets=new Map();
  return (key,max,window=60000)=>{
    const now=Date.now(); let b=buckets.get(key);
    if(!b||b.until<now) b={count:0,until:now+window};
    b.count++; buckets.set(key,b);
    if(b.count>max) reject('rate_limited','Too many requests; try again shortly.',429);
  };
}
