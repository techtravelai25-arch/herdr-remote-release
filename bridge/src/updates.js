import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {BridgeError} from './herdr.js';

const DEFAULT_DIR = fileURLToPath(new URL('../../artifacts/', import.meta.url));
const MAX_APK = 100 * 1024 * 1024;
const fail = () => new BridgeError('update_invalid', 'The published APK is incomplete or invalid. Publish the laptop build again.', 503);

/** Fixed local artifact names only; a single verified buffer is shared across downloads. */
export function createUpdateSource(directory = DEFAULT_DIR) {
  let cached;
  let flight;
  async function load() {
    let handle;
    try {
      const manifestPath = path.join(directory, 'app-update.json');
      const apkPath = path.join(directory, 'herdr-remote-debug.apk');
      const [metaStat, apkStat] = await Promise.all([fs.stat(manifestPath), fs.stat(apkPath)]);
      if (!metaStat.isFile() || metaStat.size > 16384 || !apkStat.isFile() || apkStat.size < 1 || apkStat.size > MAX_APK) throw fail();
      const key = [metaStat.ino, metaStat.size, metaStat.mtimeMs, metaStat.ctimeMs, apkStat.ino, apkStat.size, apkStat.mtimeMs, apkStat.ctimeMs].join(':');
      if (cached?.key === key) return cached;
      const value = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      if (!Number.isSafeInteger(value.versionCode) || value.versionCode < 1 || typeof value.versionName !== 'string' || !value.versionName.trim() || value.versionName.length > 100 || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_APK || value.size !== apkStat.size || value.apkPath !== '/v1/app-update/apk') throw fail();
      // Read at most the declared size plus one byte, so a concurrently changed
      // artifact cannot exceed the allocation bound or escape hash validation.
      handle = await fs.open(apkPath, 'r');
      const allocation = Buffer.alloc(value.size + 1);
      let count = 0;
      while (count < allocation.length) {
        const {bytesRead} = await handle.read(allocation, count, allocation.length - count, count);
        if (bytesRead === 0) break;
        count += bytesRead;
      }
      const bytes = allocation.subarray(0, count);
      if (count !== value.size || createHash('sha256').update(bytes).digest('hex') !== value.sha256) throw fail();
      const metadata = {versionCode: value.versionCode, versionName: value.versionName, sha256: value.sha256, size: value.size, apkPath: '/v1/app-update/apk'};
      cached = {key, metadata, bytes};
      return cached;
    } catch (error) {
      cached = undefined;
      if (error.code === 'ENOENT') throw new BridgeError('update_missing', 'No APK has been published on this laptop yet.', 404);
      if (error instanceof BridgeError) throw error;
      throw fail();
    } finally { await handle?.close(); }
  }
  return async () => {
    if (!flight) flight = load().finally(() => { flight = undefined; });
    return flight;
  };
}
