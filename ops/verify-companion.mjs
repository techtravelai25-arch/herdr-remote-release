#!/usr/bin/env node
// Installed with the companion. Verify exact signed bytes before parsing or extracting.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';

const MAX_ARCHIVE = 25 * 1024 * 1024;
function bounded(file, max) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > max) throw Error('Invalid update file size or type.');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

// Packages contain only regular files and directories from our ustar builder.
// Refuse links, path extensions and duplicate members before invoking tar.
function checkArchive(bytes) {
  const tar = gunzipSync(bytes, {maxOutputLength: 32 * 1024 * 1024});
  const seen = new Set();
  const text = field => field.toString('ascii').replace(/\0.*$/s, '');
  const octal = field => {
    const value = text(field).trim();
    if (!/^[0-7]+$/.test(value)) throw Error('Unsupported companion archive numeric field.');
    return parseInt(value, 8);
  };
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (tar.length - offset < 1024 || tar.subarray(offset).some(byte => byte !== 0)) throw Error('Invalid archive terminator.');
      if (!seen.has('herdr-remote/install.sh')) throw Error('Missing companion installer.');
      return;
    }
    const checksum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== octal(header.subarray(148, 156)) || text(header.subarray(257, 263)) !== 'ustar') throw Error('Invalid companion archive header.');
    const prefix = text(header.subarray(345, 500));
    const name = (prefix ? prefix + '/' : '') + text(header.subarray(0, 100));
    const normalized = name.replace(/\/$/, '');
    const type = header[156];
    const size = octal(header.subarray(124, 136));
    if (!/^[A-Za-z0-9_./-]+$/.test(name) || !/^herdr-remote(?:\/|$)/.test(name) ||
        normalized.split('/').some(part => part === '.' || part === '..' || !part) ||
        ![0, 48, 53].includes(type) || (type === 53 && size !== 0) ||
        (octal(header.subarray(100, 108)) & 0o7000) !== 0 || seen.has(normalized) || seen.size >= 4096) {
      throw Error('Unsafe companion archive member.');
    }
    seen.add(normalized);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (offset > tar.length) throw Error('Truncated companion archive.');
  }
  throw Error('Companion archive has no terminator.');
}

export function verifyRelease({manifest, signature, key, archive, state, now = Date.now()}) {
  const bytes = bounded(manifest, 8192);
  const publicKey = crypto.createPublicKey(bounded(key, 4096));
  if (publicKey.asymmetricKeyType !== 'ed25519' || !crypto.verify(null, bytes, publicKey, bounded(signature, 64))) {
    throw Error('Companion update signature is invalid.');
  }
  const release = JSON.parse(bytes);
  const keys = ['schema', 'sequence', 'version', 'sourceRevision', 'issuedAt', 'expiresAt', 'relayProtocol', 'archive'];
  if (Object.keys(release).sort().join() !== keys.sort().join() || release.schema !== 1 ||
      !Number.isSafeInteger(release.sequence) || release.sequence < 36 ||
      !/^\d+\.\d+\.\d+$/.test(release.version) || !/^[0-9a-f]{40}$/.test(release.sourceRevision) ||
      release.relayProtocol !== 3 || !Number.isSafeInteger(release.issuedAt) || !Number.isSafeInteger(release.expiresAt) ||
      release.issuedAt > now + 300000 || release.expiresAt <= now || release.expiresAt <= release.issuedAt ||
      release.expiresAt - release.issuedAt > 14 * 86400000 ||
      !release.archive || Object.keys(release.archive).sort().join() !== 'name,sha256,size' ||
      release.archive.name !== 'herdr-remote-companion.tar.gz' || !/^[0-9a-f]{64}$/.test(release.archive.sha256) ||
      !Number.isSafeInteger(release.archive.size) || release.archive.size < 1 || release.archive.size > MAX_ARCHIVE) {
    throw Error('Companion update metadata is expired, incompatible or malformed.');
  }
  let previous = {sequence: 36};
  if (fs.existsSync(state)) previous = JSON.parse(bounded(state, 8192));
  if (!Number.isSafeInteger(previous.sequence) || previous.sequence < 36 || release.sequence < previous.sequence ||
      (release.sequence === previous.sequence && previous.sha256 && release.archive.sha256 !== previous.sha256)) {
    throw Error('Companion update would roll back or replace an accepted release.');
  }
  if (archive) {
    const data = bounded(archive, MAX_ARCHIVE);
    if (data.length !== release.archive.size || crypto.createHash('sha256').update(data).digest('hex') !== release.archive.sha256) {
      throw Error('Companion archive does not match signed metadata.');
    }
    checkArchive(data);
  }
  return release;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, manifest, signature, key, state, archive] = process.argv.slice(2);
    if (!['metadata', 'archive', 'accept'].includes(mode) || !state || (mode !== 'metadata' && !archive)) {
      throw Error('Usage: verify-companion.mjs metadata|archive|accept MANIFEST SIGNATURE KEY STATE [ARCHIVE]');
    }
    const release = verifyRelease({manifest, signature, key, state, archive: mode === 'metadata' ? undefined : archive});
    if (mode === 'accept') {
      const temporary = state + '.' + crypto.randomUUID() + '.tmp';
      try {
        fs.writeFileSync(temporary, JSON.stringify({sequence: release.sequence, sha256: release.archive.sha256}) + '\n', {mode: 0o600, flag: 'wx'});
        fs.renameSync(temporary, state);
      } finally { fs.rmSync(temporary, {force: true}); }
    }
    console.log(`Verified companion ${release.version} (${release.sequence}).`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
