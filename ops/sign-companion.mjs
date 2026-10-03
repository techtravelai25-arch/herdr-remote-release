#!/usr/bin/env node
// Release-only tool. The private signing key never belongs in the archive or CI checks.
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const destination = path.resolve(process.argv[2] || 'dist');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude)artifacts'], {cwd: root, encoding: 'utf8'}).trim()) {
    throw Error('Release source is dirty. Commit the tested source before signing companion metadata.');
  }
  const keyPath = process.env.HERDR_COMPANION_SIGNING_KEY || path.join(os.homedir(), '.config/herdr-techtravel-release/companion-signing.pem');
  if (!fs.existsSync(keyPath)) throw Error('Set HERDR_COMPANION_SIGNING_KEY or place the protected Ed25519 release key at ~/.config/herdr-techtravel-release/companion-signing.pem.');
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
  const pinned = crypto.createPublicKey(fs.readFileSync(path.join(root, 'ops/companion-release-key.pem')));
  const actual = crypto.createPublicKey(privateKey);
  if (privateKey.asymmetricKeyType !== 'ed25519' || !actual.equals(pinned)) throw Error('Release signing key does not match the pinned companion key.');
  const versionFile = fs.readFileSync(path.join(root, 'ops/companion-version.json'));
  const {sequence, version, ...extra} = JSON.parse(versionFile);
  if (Object.keys(extra).length || !Number.isSafeInteger(sequence) || sequence < 36 || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw Error('Invalid companion release version.');
  }
  const archive = fs.readFileSync(path.join(destination, 'herdr-remote-companion.tar.gz'));
  if (!archive.length || archive.length > 25 * 1024 * 1024) throw Error('Invalid companion archive size.');
  const packagedRevision = execFileSync('tar', ['-xOzf', path.join(destination, 'herdr-remote-companion.tar.gz'), 'herdr-remote/SOURCE_REVISION'], {encoding: 'utf8', maxBuffer: 8192}).trim();
  if (packagedRevision !== revision) throw Error('Companion archive is not the current committed production source.');
  const packagedVersion = execFileSync('tar', ['-xOzf', path.join(destination, 'herdr-remote-companion.tar.gz'), 'herdr-remote/companion-version.json'], {maxBuffer: 8192});
  if (!packagedVersion.equals(versionFile)) throw Error('Companion archive version does not match the signed release version.');
  const issuedAt = Date.now();
  const release = {schema: 1, sequence, version, sourceRevision: revision, issuedAt, expiresAt: issuedAt + 14 * 86400000, relayProtocol: 3, archive: {name: 'herdr-remote-companion.tar.gz', size: archive.length, sha256: crypto.createHash('sha256').update(archive).digest('hex')}};
  const bytes = Buffer.from(JSON.stringify(release, null, 2) + '\n');
  fs.writeFileSync(path.join(destination, 'companion-release.json'), bytes);
  fs.writeFileSync(path.join(destination, 'companion-release.sig'), crypto.sign(null, bytes, privateKey));
  fs.copyFileSync(path.join(root, 'ops/companion-release-key.pem'), path.join(destination, 'companion-release-key.pem'));
  console.log(`Signed companion ${version} (${sequence}); metadata expires ${new Date(release.expiresAt).toISOString()}.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
