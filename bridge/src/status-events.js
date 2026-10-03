import net from 'node:net';
import {randomUUID} from 'node:crypto';

const EVENT = 'pane.agent_status_changed';
const STATUSES = new Set(['idle', 'working', 'blocked', 'done', 'unknown']);
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_QUEUE_BYTES = 256 * 1024;
const MAX_QUEUE_EVENTS = 128;

/**
 * Protocol 22 read-only, pane-specific status subscription. Dormant until update
 * receives panes; the owner must instantiate/update only while monitoring is on.
 * onReady reconciles a snapshot after subscription acknowledgment. onStatus gets
 * the validated SubscriptionEventEnvelope.data, in arrival order. A snapshot is
 * a baseline, not proof of a completion; only observed transitions should alert.
 */
export function createStatusEvents(socketPath, {onStatus = () => {}, onReady = () => {}} = {}) {
  let panes = new Set();
  let active = null;
  let retry = null;
  let failures = 0;
  let closed = false;

  const cancelRetry = () => { clearTimeout(retry); retry = null; };
  function dispose(connection) {
    if (!connection) return;
    clearTimeout(connection.deadline);
    connection.queue.length = 0;
    connection.queueBytes = 0;
    connection.buffer = '';
    connection.socket.destroy();
  }
  function schedule() {
    if (closed || panes.size === 0 || retry) return;
    const delay = Math.min(30_000, 250 * 2 ** Math.min(failures++, 7));
    retry = setTimeout(() => { retry = null; connect(); }, delay + Math.floor(Math.random() * 100));
    retry.unref?.();
  }
  function fail(connection) {
    if (active !== connection) return;
    active = null;
    dispose(connection);
    schedule();
  }
  async function drain(connection) {
    if (connection.draining || !connection.ready || active !== connection) return;
    connection.draining = true;
    try {
      while (active === connection && connection.queue.length) {
        const entry = connection.queue.shift();
        connection.queueBytes -= entry.bytes;
        await onStatus(entry.data);
      }
    } catch { fail(connection); }
    finally { connection.draining = false; }
  }
  async function reconcile(connection) {
    try {
      await onReady();
      if (active !== connection) return;
      connection.ready = true;
      clearTimeout(connection.deadline);
      failures = 0;
      void drain(connection);
    } catch { fail(connection); }
  }
  function accept(connection, line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { fail(connection); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { fail(connection); return; }
    if (message.id === connection.id) {
      if (connection.acknowledged || message.error || message.result?.type !== 'subscription_started') { fail(connection); return; }
      connection.acknowledged = true;
      void reconcile(connection);
      return;
    }
    if (message.event !== EVENT) return;
    const data = message.data;
    // Never let unsolicited pane events or non-status envelopes affect tracking.
    if (!data || !connection.panes.has(data.pane_id)) return;
    if (typeof data.workspace_id !== 'string' || !STATUSES.has(data.agent_status)) { fail(connection); return; }
    const bytes = Buffer.byteLength(line);
    if (connection.queue.length >= MAX_QUEUE_EVENTS || connection.queueBytes + bytes > MAX_QUEUE_BYTES) { fail(connection); return; }
    connection.queue.push({data, bytes});
    connection.queueBytes += bytes;
    void drain(connection);
  }
  function connect() {
    if (closed || panes.size === 0 || active) return;
    const socket = net.createConnection(socketPath);
    const connection = {socket, id: randomUUID(), panes: new Set(panes), buffer: '', queue: [], queueBytes: 0,
      acknowledged: false, ready: false, draining: false, deadline: null};
    active = connection;
    // Includes handshake + baseline reconciliation, so a stalled baseline cannot
    // accumulate an unbounded pending subscription or block all future retries.
    connection.deadline = setTimeout(() => fail(connection), 15_000);
    connection.deadline.unref?.();
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      if (active !== connection) return;
      const subscriptions = [...connection.panes].map(pane_id => ({type: EVENT, pane_id}));
      socket.write(JSON.stringify({id: connection.id, method: 'events.subscribe', params: {subscriptions}}) + '\n');
    });
    socket.on('error', () => fail(connection));
    socket.on('end', () => fail(connection));
    socket.on('close', () => fail(connection));
    socket.on('data', chunk => {
      if (active !== connection) return;
      connection.buffer += chunk;
      let index;
      while ((index = connection.buffer.indexOf('\n')) !== -1) {
        const line = connection.buffer.slice(0, index);
        connection.buffer = connection.buffer.slice(index + 1);
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { fail(connection); return; }
        accept(connection, line);
        if (active !== connection) return;
      }
      if (Buffer.byteLength(connection.buffer) > MAX_FRAME_BYTES) fail(connection);
    });
  }
  function update(value) {
    if (closed) return;
    const entries = Array.isArray(value) ? value : value?.panes ?? value?.snapshot?.panes ?? [];
    const ids = entries.map(pane => typeof pane === 'string' ? pane : pane?.id ?? pane?.pane_id)
      .filter(id => typeof id === 'string' && id.length > 0 && id.length <= 1024);
    const next = new Set(ids);
    if (next.size > 4096) throw new RangeError('Too many panes for status monitoring');
    if (next.size === panes.size && [...next].every(id => panes.has(id))) return;
    panes = next;
    cancelRetry();
    const previous = active;
    active = null;
    dispose(previous);
    failures = 0;
    connect();
  }
  function close() {
    closed = true;
    panes.clear();
    cancelRetry();
    const previous = active;
    active = null;
    dispose(previous);
  }
  return {update, close};
}
