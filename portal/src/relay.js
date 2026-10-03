import {lookupLaptop} from './public.js';
import {hasMediaType} from './media-type.js';

// The hosted relay accepts ciphertext only. Content keys remain on paired devices.
export const MAX_ENVELOPE_BYTES = 512 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const b64 = /^[A-Za-z0-9_-]+$/;
export function validEnvelope(value, request = true) {
  const keys = request ? ['v','id','iv','data','epk'] : ['v','id','iv','data'];
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !keys.includes(key)) || value.v !== 1 || !uuid.test(value.id || '') ||
      typeof value.iv !== 'string' || value.iv.length !== 16 || !b64.test(value.iv) ||
      typeof value.data !== 'string' || value.data.length < 22 || value.data.length > MAX_ENVELOPE_BYTES - 1024 || !b64.test(value.data)) return false;
  return !request || (typeof value.epk === 'string' && value.epk.length >= 80 && value.epk.length <= 256 && b64.test(value.epk));
}
export const relayError = (status, code, message) => Response.json({error: {code, message}}, {
  status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'},
});
/** @param {Request} request @param {{signal?: AbortSignal}} [options] */
export async function readEnvelope(request, {signal} = {}) {
  if (!hasMediaType(request, 'application/json')) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  let onAbort;
  const aborted = signal && new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, {once: true});
    if (signal.aborted) onAbort();
  });
  let length = 0;
  const chunks = [];
  let completed = false;
  try {
    for (;;) {
      const {done, value} = await (aborted ? Promise.race([reader.read(), aborted]) : reader.read());
      if (done) { completed = true; break; }
      length += value.byteLength;
      if (length > MAX_ENVELOPE_BYTES) return null;
      chunks.push(value);
    }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    // Cancellation can itself stall on an upload source; never hold admission on it.
    if (!completed) {
      try { void reader.cancel().catch(() => {}); } catch {}
    }
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  try { const value = JSON.parse(new TextDecoder().decode(data)); return validEnvelope(value) ? value : null; }
  catch { return null; }
}
/** @param {Request} request @param {Env} env */
export async function handleRelay(request, env) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/v1\/relay\/([a-f0-9-]{36})\/(connect|rpc)$/i);
  if (!match) return relayError(404, 'not_found', 'Connection not found.');
  if (url.search || request.headers.has('origin')) return relayError(403, 'invalid_request', 'Use the Herdr Remote app.');
  if (!env.RELAY) return relayError(503, 'relay_unavailable', 'Remote connections are not configured yet.');
  const [, id, action] = match;
  if (!uuid.test(id)) return relayError(404, 'not_found', 'Connection not found.');
  if(!env.EDGE_RELAY_LIMIT)return relayError(503,'relay_unavailable','Relay abuse protection is not configured.');
  if(!(await env.EDGE_RELAY_LIMIT.limit({key:request.headers.get('CF-Connecting-IP')||'local'})).success)return relayError(429,'rate_limited','Please wait before trying again.');
  const stub=env.RELAY.getByName(id);
  if(action==='connect') {
    if(request.method!=='GET'||request.headers.get('upgrade')?.toLowerCase()!=='websocket')return relayError(426,'websocket_required','Use a WebSocket connection.');
    const token=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const laptop=token?await lookupLaptop(env,id,token):null;
    if(!laptop)return relayError(401,'unauthorized','Register this laptop again.');
    const initialized=await stub.fetch(new Request('https://relay.internal/admin/init',{method:'POST',body:JSON.stringify({id,strict:Number(laptop.relay_auth_version)>=1})}));
    if(!initialized.ok)return initialized;
  } else if(request.method!=='POST')return relayError(405,'method_not_allowed','Use POST.');
  const headers = new Headers(action === 'connect' ? {Upgrade:'websocket'} : {'Content-Type':'application/json'});
  if(action==='rpc'&&request.headers.has('authorization'))headers.set('Authorization',request.headers.get('authorization'));
  // RPC authentication and budgets are authoritative in the per-laptop DO.
  return stub.fetch(new Request(`https://relay.internal/${action}`, {method:request.method,headers,
    ...(action==='rpc'?{body:request.body}:{}),signal:request.signal}));
}
