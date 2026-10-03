import {randomUUID} from 'node:crypto';
import {BridgeError} from './herdr.js';

// A token represents one device's observed occupant of one pane in this bridge
// process. terminal_id comes from Herdr; revision is deliberately excluded so
// output changes do not invalidate the attachment.
export function paneIdentity(pane) {
  if (!pane || !pane.pane_id || !pane.terminal_id || !pane.workspace_id || !pane.tab_id)
    throw new BridgeError('pane_identity_unavailable','Herdr did not provide a stable terminal identity. Refresh after it becomes available.',409);
  return JSON.stringify([pane.pane_id,pane.terminal_id,pane.workspace_id,pane.tab_id,
    pane.agent ?? null,pane.agent_session ?? null]);
}

export class PaneAttachments {
  constructor() { this.entries = new Map(); }
  key(deviceId,paneId) { return JSON.stringify([deviceId,paneId]); }
  attach(deviceId,pane) {
    const identity=paneIdentity(pane), key=this.key(deviceId,pane.pane_id);
    let entry=this.entries.get(key);
    if (!entry || entry.identity!==identity) {
      entry={identity,token:randomUUID()};
      this.entries.set(key,entry);
    }
    return entry.token;
  }
  validate(deviceId,pane,token) {
    if (typeof token!=='string' || !/^[0-9a-f-]{36}$/.test(token))
      throw new BridgeError('pane_attachment_required','Refresh the terminal before sending input.',409);
    const entry=this.entries.get(this.key(deviceId,pane?.pane_id));
    if (!entry || entry.token!==token || entry.identity!==paneIdentity(pane))
      throw new BridgeError('pane_attachment_stale','The pane changed. Refresh and reattach before sending input.',409);
  }
  prune(liveIds) {
    for (const key of this.entries.keys()) if (!liveIds.has(JSON.parse(key)[1])) this.entries.delete(key);
  }
}
