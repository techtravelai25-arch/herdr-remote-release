import net from 'node:net';
import {randomUUID} from 'node:crypto';

export class BridgeError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export class Herdr {
  constructor(socketPath) { this.socketPath = socketPath; }
  call(method, params = {}, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const id = randomUUID(); let buffer = ''; let settled = false;
      const socket = net.createConnection(this.socketPath);
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => finish(new BridgeError('herdr_timeout', 'Herdr did not respond. Refresh before retrying an action; it may have completed.', 504)), timeout);
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(JSON.stringify({id, method, params}) + '\n'));
      socket.on('error', error => finish(['ENOENT','ECONNREFUSED'].includes(error.code)
        ? new BridgeError('herdr_offline', 'Herdr is unavailable. Start the configured Herdr session on the laptop.', 503)
        : new BridgeError('herdr_socket_error', 'Cannot access the Herdr socket. Check its permissions and configuration on the laptop.', 503)));
      socket.on('end', () => finish(new BridgeError('herdr_disconnected', 'Herdr disconnected; refresh before retrying.', 503)));
      socket.on('data', chunk => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) return finish(new BridgeError('response_too_large', 'Herdr response exceeded limit.', 502));
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0,index); buffer = buffer.slice(index+1);
          try {
            const response = JSON.parse(line);
            if (response.id !== id) continue;
            if (response.error) finish(new BridgeError(response.error.code, response.error.message, 409));
            else if (response.result) finish(null, response.result);
            else finish(new BridgeError('invalid_response', 'Invalid Herdr response.', 502));
          } catch { finish(new BridgeError('invalid_response', 'Invalid Herdr response.', 502)); }
        }
      });
    });
  }
}
