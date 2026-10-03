import {createHash, randomUUID} from 'node:crypto';
import {BridgeError} from './herdr.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const uncertainCodes = new Set(['herdr_timeout', 'herdr_disconnected', 'herdr_socket_error', 'herdr_offline', 'internal_error', 'invalid_response', 'response_too_large']);
export const RECEIPT_TTL_MS=7*86400000;
export const MAX_RECEIPTS=10000;

function operationError(record) {
  const status = ['uncertain','running'].includes(record.status) ? 409 : (record.error?.status || 400);
  const code = record.status === 'running' ? 'operation_running' : record.status === 'uncertain' ? 'operation_uncertain' : (record.error?.code || 'operation_failed');
  const message = record.status === 'running' ? 'The operation is still running. Check its receipt before retrying.' : record.status === 'uncertain'
    ? 'The operation may have reached Herdr. Inspect the pane and operation status before retrying.'
    : (record.error?.message || 'The operation failed.');
  const error = new BridgeError(code, message, status);
  error.operationId = record.operationId;
  error.operationStatus = record.status;
  return error;
}

/**
 * Durable, device-scoped operation receipts. A running operation is marked
 * uncertain when a new bridge process opens the store: a process crash cannot
 * establish whether Herdr received the request, so the bridge never retries it
 * implicitly.
 */
export class Operations {
  constructor(store, {now=Date.now,maxRecords=MAX_RECEIPTS,ttl=RECEIPT_TTL_MS}={}) {
    this.store = store;
    this.now=now;this.maxRecords=maxRecords;this.ttl=ttl;
    this.records = this.store.read('operations.json', {});
    let changed = false;
    for (const record of Object.values(this.records)) {
      if (record.status === 'running') { record.status = 'uncertain'; record.recoveredAt = new Date().toISOString(); changed = true; }
    }
    if (changed) this.save();
  }
  save() { this.store.write('operations.json', this.records); }
  prune() {
    let changed=false;
    for(const [key,record] of Object.entries(this.records)) {
      if(record.status!=='running' && Date.parse(record.completedAt||record.startedAt)<this.now()-this.ttl) {delete this.records[key];changed=true;}
    }
    if(changed)this.save();
  }
  id(value) {
    if (value === undefined || value === null || value === '') return randomUUID();
    if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9._:-]{8,128}$/.test(value))
      throw new BridgeError('invalid_operation_id', 'Operation ID must be 8–128 letters, digits, dots, underscores, colons or hyphens.');
    return value;
  }
  key(deviceId, operationId) { return `${deviceId}:${operationId}`; }
  begin(deviceId, operationId, signature, kind) {
    this.prune();
    const key = this.key(deviceId, operationId);
    const existing = this.records[key];
    if (existing) {
      if (existing.signature !== signature || existing.kind !== kind) {
        throw new BridgeError('operation_conflict', 'This operation ID was already used for a different request.', 409);
      }
      if (existing.status === 'succeeded') return {replay: true, response: existing.response};
      throw operationError(existing);
    }
    if(Object.keys(this.records).length>=this.maxRecords) throw new BridgeError('operation_capacity','Operation receipt storage is full; retry after older receipts expire.',503);
    const record = {operationId, deviceId, kind, signature, status: 'running', startedAt: new Date(this.now()).toISOString()};
    this.records[key] = record;
    this.save();
    return {replay: false, record};
  }
  succeed(record, response) {
    record.status = 'succeeded'; record.response = response; record.completedAt = new Date(this.now()).toISOString(); this.save();
  }
  fail(record, error) {
    record.status = uncertainCodes.has(error?.code) || error?.paneId || !(error instanceof BridgeError) ? 'uncertain' : 'failed';
    record.error = {code: error instanceof BridgeError ? error.code : 'internal_error', message: error instanceof BridgeError ? error.message : 'Internal bridge error.', status: error?.status || 500};
    record.completedAt = new Date(this.now()).toISOString(); this.save();
  }
  status(deviceId, operationId) {
    this.prune();
    const record = this.records[this.key(deviceId, operationId)];
    if (!record) throw new BridgeError('operation_not_found', 'No operation receipt was found for this device.', 404);
    const {signature, deviceId: owner, ...publicRecord} = record;
    return publicRecord;
  }
  async run(deviceId, operationId, kind, request, action) {
    const id = this.id(operationId);
    const signature = digest(JSON.stringify({kind, request}));
    const begun = this.begin(deviceId, id, signature, kind);
    if (begun.replay) return {...begun.response, operationId: id, replayed: true};
    try {
      const result = await action();
      const response = {...(result || {ok: true}), ...(result?.paneId ? {} : {ok: true}), operationId: id};
      this.succeed(begun.record, response);
      return response;
    } catch (error) {
      this.fail(begun.record, error);
      error.operationId=id;error.operationStatus=begun.record.status;
      throw error;
    }
  }
}

export function operationInput(req, body = {}) {
  const header = req.headers['x-operation-id'];
  const value = body.operationId ?? header;
  if (header && body.operationId && header !== body.operationId) throw new BridgeError('operation_conflict', 'The operation ID header and body do not match.', 409);
  return value;
}
