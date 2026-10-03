import fs from 'node:fs';
import path from 'node:path';
import {randomBytes, randomUUID, createHash, timingSafeEqual} from 'node:crypto';
import {BridgeError} from './herdr.js';
const digest = value => createHash('sha256').update(value).digest('hex');
export class Store {
  constructor(dir) { this.dir = dir; fs.mkdirSync(dir, {recursive:true, mode:0o700}); fs.chmodSync(dir,0o700); }
  read(name, fallback) { try { return JSON.parse(fs.readFileSync(path.join(this.dir,name),'utf8')); } catch(e) { if(e.code==='ENOENT') return fallback; throw e; } }
  syncDirectory() { const fd=fs.openSync(this.dir,'r'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);} }
  write(name, data) {
    const file=path.join(this.dir,name),tmp=file+'.'+randomUUID();
    let fd;
    try {
      fd=fs.openSync(tmp,'wx',0o600);
      fs.writeFileSync(fd,JSON.stringify(data,null,2));
      fs.fsyncSync(fd);
      fs.closeSync(fd);fd=undefined;
      fs.renameSync(tmp,file);
      // A durable receipt/replay marker must survive a power loss before the
      // bridge forwards any action. Sync the rename as well as the file data.
      this.syncDirectory();
    } catch(error) {
      if(fd!==undefined)fs.closeSync(fd);
      fs.rmSync(tmp,{force:true});
      throw error;
    }
  }
  pairCodeDetails() {
    const code=randomBytes(16).toString('hex');
    const expires=Date.now()+300000;
    this.write('pairing.json',{hash:digest(code),expires,attempts:0});
    return {code,expires:Math.floor(expires/1000)};
  }
  pairCode() { return this.pairCodeDetails().code; }
  pair(code,deviceName) {
    const pending=this.read('pairing.json',null);
    if (!pending || pending.consumed || pending.expires<Date.now() || pending.attempts>=10) throw new BridgeError('pairing_closed','Generate a new pairing code on the laptop.',403);
    pending.attempts++; this.write('pairing.json',pending);
    if (typeof code!=='string' || !timingSafeEqual(Buffer.from(digest(code)),Buffer.from(pending.hash))) throw new BridgeError('invalid_code','Pairing code is invalid.',403);
    // Consume the one-use code durably before publishing a credential. A crash
    // between devices.json and unlink must never leave the code reusable.
    pending.consumed=true;this.write('pairing.json',pending);
    const token=randomBytes(32).toString('base64url'); const deviceId=randomUUID();
    const devices=this.read('devices.json',[]); devices.push({deviceId,deviceName,hash:digest(token),createdAt:new Date().toISOString()});
    this.write('devices.json',devices); fs.unlinkSync(path.join(this.dir,'pairing.json'));this.syncDirectory(); return {token,deviceId};
  }
  authenticate(token) { if(typeof token!=='string' || token.length>256) return null; const hash=digest(token); return this.read('devices.json',[]).find(d=>timingSafeEqual(Buffer.from(hash),Buffer.from(d.hash))) ?? null; }
  revoke(id) { this.write('devices.json',this.read('devices.json',[]).filter(d=>d.deviceId!==id)); }
}
