import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {BridgeError} from './herdr.js';

const MAX_BYTES = 20 * 1024 * 1024;
const references = new Map();
const MAX_REFERENCES = 2048;
const TTL = 15 * 60 * 1000;
const credentialExtension = /\.(?:pem|key|keystore|jks|p8|p12|pfx|env|token|kdbx|tfvars|gpg|asc|ovpn)(?:\.(?:bak|backup|old|orig|save))?$/i;
const credentialName = /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|authorized_keys|credentials|secrets)(?:\..*)?$/i;
const cursors = new Map();
function closeListing(state) { clearTimeout(state.timer); try { state.handle.closeSync(); } catch {} }
function retainListing(state) {
  while (cursors.size >= 32) { const oldest=cursors.keys().next().value;closeListing(cursors.get(oldest));cursors.delete(oldest); }
  const cursor=randomBytes(24).toString('hex');
  state.timer=setTimeout(()=>{cursors.delete(cursor);closeListing(state);},60000);state.timer.unref();
  cursors.set(cursor,state);return cursor;
}

export function validRelative(relative, allowRoot = false) {
  return typeof relative === 'string' && Buffer.byteLength(relative) <= 768 &&
    (allowRoot && relative === '' || relative.length > 0 && !path.isAbsolute(relative) &&
      !/[\\\u0000-\u001f\u007f]/.test(relative) && relative.split('/').every(part =>
        part.length > 0 && !part.startsWith('.') && !credentialExtension.test(part) && !credentialName.test(part)));
}

function safeFile(root, relative) {
  if (!validRelative(relative)) return null;
  const file = path.join(root, relative);
  try {
    if (!file.startsWith(root + path.sep) || fs.realpathSync(file) !== file) return null;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) return null;
    return {file, stat};
  } catch { return null; }
}

function remember(root, relative) {
  const id = 'project-' + createHash('sha256').update('browse\n' + root + '\n' + relative).digest('hex');
  const now = Date.now();
  for (const [key, value] of references) if (value.expires <= now) references.delete(key);
  references.delete(id);
  while (references.size >= MAX_REFERENCES) references.delete(references.keys().next().value);
  references.set(id, {root, relative, expires: now + TTL});
  return id;
}

/** The caller supplies a freshly authorized, canonical session working directory. */
export function browseProjectFiles(root, directory = '', cursor = null) {
  if (!validRelative(directory, true)) throw new BridgeError('invalid_directory', 'Choose a folder inside this project.', 400);
  const folder = path.join(root, directory);
  let state, handle;
  try {
    if (fs.realpathSync(folder) !== folder || !fs.lstatSync(folder).isDirectory()) throw Error('changed');
    const stat=fs.statSync(folder);
    if(cursor!==null) {
      if(typeof cursor!=='string'||! /^[a-f0-9]{48}$/.test(cursor))throw Error('cursor');
      state=cursors.get(cursor);
      if(!state||state.root!==root||state.directory!==directory)throw Error('cursor');
      cursors.delete(cursor);clearTimeout(state.timer);
      if(state.ino!==stat.ino||state.dev!==stat.dev||state.modified!==stat.mtimeMs) {closeListing(state);throw Error('changed');}
      handle=state.handle;
    } else {
      handle = fs.opendirSync(folder);
      state={root,directory,handle,ino:stat.ino,dev:stat.dev,modified:stat.mtimeMs};
    }
  } catch { throw new BridgeError('directory_unavailable', 'This folder is unavailable. Refresh the project files.', 409); }
  const entries = [];
  let inspected = 0, truncated = false;
  try {
    while(true) {
      if (inspected >= 1000 || entries.length >= 100) {
        state.pending = handle.readSync();
        truncated = state.pending !== null;
        break;
      }
      const entry=state.pending ?? handle.readSync();state.pending=null;if(entry===null)break;
      inspected++;
      const relative = directory ? directory + '/' + entry.name : entry.name;
      if (!validRelative(relative) || entry.isSymbolicLink()) continue;
      const file = path.join(root, relative);
      try {
        if (fs.realpathSync(file) !== file) continue;
        const stat = fs.lstatSync(file);
        if (stat.isDirectory()) entries.push({name: entry.name, path: relative, type: 'directory'});
        else if (stat.isFile() && stat.nlink === 1) {
          const downloadable = stat.size <= MAX_BYTES;
          entries.push({name: entry.name, path: relative, type: 'file', size: stat.size, downloadable,
            ...(downloadable ? {id: remember(root, relative)} : {})});
        }
      } catch { /* Ignore entries removed while listing. */ }
    }
  } catch {closeListing(state);throw new BridgeError('directory_unavailable','This folder changed. Refresh the project files.',409);}
  const nextCursor=truncated?retainListing(state):null;
  if(!truncated)closeListing(state);
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
  return {directory, parent: directory ? directory.split('/').slice(0, -1).join('/') : null, entries, truncated, nextCursor};
}

export function resolveBrowsedFile(root, id) {
  const ref = references.get(id);
  if (!ref || ref.root !== root || ref.expires <= Date.now()) return null;
  const current = safeFile(root, ref.relative);
  if (!current) return null;
  return {id, name: path.basename(ref.relative), file: current.file,
    size: current.stat.size, contentType: 'application/octet-stream'};
}
