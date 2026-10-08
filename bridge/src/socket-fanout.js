import {WebSocketServer,WebSocket} from 'ws';
import {BridgeError} from './herdr.js';
import {requireAccess} from './access.js';

const MAX_SOCKETS=8;

/**
 * Snapshot WebSocket fan-out. Every send, heartbeat and access sweep
 * re-authenticates each socket's credential, so revocation, an access change
 * or a malformed device record closes only the affected socket.
 */
export function createSocketFanout({server,store,config,authenticate,authorizeUpgrade,scopedSnapshot,latest,onConnection}) {
  const wss=new WebSocketServer({noServer:true,maxPayload:1024,perMessageDeflate:false});
  server.on('upgrade',async(req,socket,head)=>{
    try {
      if(req.url!=='/v1/events'||req.headers.origin) throw new BridgeError('forbidden','Forbidden',403);
      const token=await authorizeUpgrade(req);
      if(wss.clients.size>=MAX_SOCKETS) throw new BridgeError('busy','Too many connections.',429);
      if(socket.destroyed)return;
      wss.handleUpgrade(req,socket,head,ws=>{
        ws.token=token;ws.alive=true;
        ws.on('pong',()=>{ws.alive=true;});ws.on('error',()=>{});
        wss.emit('connection',ws);
      });
    } catch {socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');}
  });
  wss.on('connection',ws=>onConnection?.(ws));
  // A thrown authenticator (for example a corrupt device store) is treated
  // like a revoked credential for that socket; it never escapes a timer.
  async function eachAuthorized(visit,deny=ws=>ws.terminate()) {
    for(const ws of wss.clients) {
      try {
        const device=await authenticate(ws.token);
        if(!device) throw Error('revoked');
        visit(ws,device,requireAccess(store,device,'read',config));
      } catch {deny(ws);}
    }
  }
  const sendSnapshot=(ws,data)=>ws.send(JSON.stringify({type:'snapshot',data}));
  function broadcast(data) {
    return eachAuthorized((ws,device)=>{
      const scoped=scopedSnapshot(data,device);
      if(ws.bufferedAmount>1024*1024)ws.close(1013,'Slow client');
      else if(ws.readyState===WebSocket.OPEN){ws.permissionMode=scoped.permissionMode;sendSnapshot(ws,scoped);}
    },ws=>ws.close(4001,'Expired, revoked or disabled'));
  }
  const heartbeat=setInterval(()=>void eachAuthorized(ws=>{
    if(!ws.alive){ws.terminate();return;}
    if(ws.readyState!==WebSocket.OPEN)return;
    ws.alive=false;ws.ping();
  }),20000);heartbeat.unref();
  // Another local CLI process can change access.json or devices.json. Check
  // established sockets independently of Herdr output or relay connectivity.
  const accessSweep=setInterval(()=>void eachAuthorized((ws,device,mode)=>{
    const snapshot=latest();
    if(mode===ws.permissionMode||!snapshot||ws.readyState!==WebSocket.OPEN)return;
    const scoped=scopedSnapshot(snapshot,device);ws.permissionMode=mode;sendSnapshot(ws,scoped);
  }),1000);accessSweep.unref();
  const terminateAll=()=>{for(const ws of wss.clients)ws.terminate();};
  function close() {clearInterval(heartbeat);clearInterval(accessSweep);terminateAll();wss.close();}
  return {broadcast,terminateAll,close,get size(){return wss.clients.size;}};
}
