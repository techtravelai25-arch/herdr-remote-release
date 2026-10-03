import {execFile as nodeExecFile} from 'node:child_process';
import QRCode from 'qrcode';
import {get as httpsGet} from 'node:https';
import {isIP} from 'node:net';

export const BRIDGE_UNIT = 'herdr-remote-bridge.service';
export const QUICK_TUNNEL_UNIT = 'herdr-remote-quick-tunnel.service';
// A Quick Tunnel can take several seconds to allocate a hostname and for that
// hostname to begin forwarding to the local bridge. Keep one attempt long
// enough for that startup, while preparePairing bounds recovery to one
// additional attempt.
const DEFAULT_WAIT_MS = 30000;
const DEFAULT_POLL_MS = 250;

/**
 * Accept only an HTTPS origin. The bridge does not accept a path, query,
 * fragment or credentials in a pairing payload because the Android client
 * appends API paths itself.
 */
export function normalizeHttpsOrigin(input) {
  if (typeof input !== 'string' || input.length === 0 || input.length > 2048) {
    throw new Error('The server URL must be an HTTPS origin.');
  }
  let value;
  try {
    value = new URL(input.trim());
  } catch {
    throw new Error('The server URL must be an HTTPS origin.');
  }
  if (
    value.protocol !== 'https:' ||
    !value.hostname ||
    value.username ||
    value.password ||
    value.pathname !== '/' ||
    value.search ||
    value.hash ||
    value.origin === 'null'
  ) {
    throw new Error('The server URL must be HTTPS without a path, query, fragment or credentials.');
  }
  return value.origin;
}

export function buildPairingPayload(origin, code, expires) {
  const url = normalizeHttpsOrigin(origin);
  if (typeof code !== 'string' || !/^[0-9a-f]{32}$/.test(code)) {
    throw new Error('The pairing code must be 32 lowercase hexadecimal characters.');
  }
  if (!Number.isInteger(expires) || expires <= 0) {
    throw new Error('The pairing expiry must be a positive Unix timestamp.');
  }
  return `herdr-remote://pair?v=1&url=${encodeURIComponent(url)}&code=${code}&expires=${expires}`;
}

function execFileText(execFile, command, args) {
  return new Promise((resolve, reject) => {
    // Keep this as execFile with an argv array. Pairing must never invoke a
    // shell, and these arguments are all fixed by this module.
    execFile(command, args, {encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 5000}, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

export function systemdRunner(execFile = nodeExecFile) {
  return {
    exec(command, args) {
      return execFileText(execFile, command, args);
    },
  };
}

async function unitState(runner, unit) {
  const output = await runner.exec('systemctl', [
    '--user', 'show', unit,
    '--property=ActiveState', '--property=InvocationID',
    '--no-pager',
  ]);
  const lines = String(output).trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const named = new Map(lines.map(line => {
    const index = line.indexOf('=');
    return index > 0 ? [line.slice(0, index), line.slice(index + 1)] : ['', ''];
  }).filter(([key]) => key));
  return {
    activeState: (named.get('ActiveState') ?? lines[0] ?? '').trim(),
    invocationId: (named.get('InvocationID') ?? lines[1] ?? '').trim(),
  };
}

/**
 * Read only the current systemd invocation. A journal query without this
 * selector can return a URL from a previous quick-tunnel process.
 */
export async function currentQuickTunnelInvocation(runner, unit = QUICK_TUNNEL_UNIT) {
  const state = await unitState(runner, unit);
  // systemd currently uses a 32-character hex ID. Keep the validation
  // conservative while allowing deterministic fixture IDs in tests; the
  // value is still passed as one argv element and never interpreted by a
  // shell.
  if (state.activeState !== 'active' || !/^[A-Za-z0-9_-]{8,}$/.test(state.invocationId)) return null;
  return state.invocationId;
}

const quickTunnelUrlPattern = /https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com/gi;

export async function discoverCurrentQuickTunnelUrl(runner, unit = QUICK_TUNNEL_UNIT) {
  const invocationId = await currentQuickTunnelInvocation(runner, unit);
  if (!invocationId) return null;
  const output = await runner.exec('journalctl', [
    '--user', '-u', unit,
    `_SYSTEMD_INVOCATION_ID=${invocationId}`,
    '--no-pager', '-o', 'cat',
  ]);
  // A restart can happen while journalctl is reading. Re-read the invocation
  // before accepting a URL so a race cannot publish the previous process URL.
  if (await currentQuickTunnelInvocation(runner, unit) !== invocationId) return null;
  const matches = [...String(output).matchAll(quickTunnelUrlPattern)].map(match => match[0]);
  if (!matches.length) return null;
  return normalizeHttpsOrigin(matches.at(-1));
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(check, {
  timeoutMs = DEFAULT_WAIT_MS,
  intervalMs = DEFAULT_POLL_MS,
  sleepFn = sleep,
  now = Date.now,
  description = 'the requested service',
} = {}) {
  const started = now();
  let lastError;
  while (now() - started <= timeoutMs) {
    try {
      const value = await check();
      if (value !== undefined && value !== null && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    const remaining = timeoutMs - (now() - started);
    if (remaining <= 0) break;
    await sleepFn(Math.min(intervalMs, remaining));
  }
  if (lastError) throw new Error(`${description} was not ready: ${lastError.message}`);
  throw new Error(`Timed out waiting for ${description}.`);
}

// Some local resolvers cache NXDOMAIN before a newly allocated tunnel's DNS
// record propagates. Resolve only Quick Tunnel health probes through Cloudflare
// on a DNS failure; retain the original HTTPS hostname and certificate checks.
export async function quickTunnelDnsStatus(origin, {fetchImpl = globalThis.fetch, get = httpsGet, timeoutMs = 3000} = {}) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname)) {
    throw new Error('DNS fallback is restricted to Quick Tunnel HTTPS hosts.');
  }
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(url.hostname)}&type=A`, {
    headers: {accept: 'application/dns-json'}, signal, redirect: 'error',
  });
  if (!response.ok) throw new Error('Quick Tunnel DNS lookup failed.');
  const data = await response.json();
  const address = data.Status === 0 && data.Answer?.find(answer => answer.type === 1 && isIP(answer.data) === 4)?.data;
  if (!address) throw new Error('Quick Tunnel DNS is not ready.');
  return new Promise((resolve, reject) => {
    const request = get(`${url.origin}/v1/health`, {
      signal, agent: false,
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, [{address, family: 4}])
        : callback(null, address, 4),
    }, result => { result.resume(); resolve(result.statusCode); });
    request.on('error', reject);
  });
}

async function httpStatus(origin, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${origin}/v1/health`, {
      method: 'GET', redirect: 'manual', signal: controller.signal,
    });
    // A body is unnecessary for this unauthenticated gate check. Releasing it
    // keeps repeated readiness checks from retaining pooled connections.
    if (response.body?.cancel) response.body.cancel().catch(() => {});
    return response.status;
  } catch (error) {
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(error.cause?.code ?? error.code) && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(origin)) {
      return await quickTunnelDnsStatus(origin, {fetchImpl, timeoutMs});
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForAuthGate(origin, fetchImpl, {
  timeoutMs = DEFAULT_WAIT_MS,
  intervalMs = DEFAULT_POLL_MS,
  sleepFn = sleep,
  now = Date.now,
  description,
} = {}) {
  let lastStatus = null;
  let lastError = null;
  try {
    const result = await waitFor(async () => {
      try {
        lastStatus = await httpStatus(origin, fetchImpl, Math.min(3000, timeoutMs));
        lastError = null;
      } catch (error) {
        lastStatus = null;
        lastError = error;
        return null;
      }
      return lastStatus === 401 ? true : null;
    }, {timeoutMs, intervalMs, sleepFn, now, description});
    if (!result) throw new Error(`${description} did not return HTTP 401.`);
  } catch (error) {
    if (!error.message.startsWith(`Timed out waiting for ${description}.`)) throw error;
    const detail = lastStatus === null
      ? (lastError ? `last error: ${lastError.message}` : 'no HTTP response')
      : `last HTTP status: ${lastStatus}`;
    throw new Error(`${description} did not return HTTP 401 (${detail}).`);
  }
  return {status: lastStatus};
}

async function ensureUnitStarted(runner, unit) {
  const state = await unitState(runner, unit);
  if (state.activeState !== 'active') {
    await runner.exec('systemctl', ['--user', 'start', unit]);
  }
  return state;
}

function reportProgress(onProgress, message) {
  if (typeof onProgress === 'function') onProgress(message);
}

async function waitForQuickTunnelReady(runner, fetchImpl, {
  tunnelUnit,
  timeoutMs,
  intervalMs,
  sleepFn,
  now,
} = {}) {
  const origin = await waitFor(async () => discoverCurrentQuickTunnelUrl(runner, tunnelUnit), {
    timeoutMs, intervalMs, sleepFn, now, description: 'the current quick-tunnel URL',
  });
  await waitForAuthGate(origin, fetchImpl, {
    timeoutMs, intervalMs, sleepFn, now, description: `the current public URL (${origin})`,
  });
  return origin;
}

/**
 * Start only the fixed bridge/tunnel user units as needed. This function never
 * starts Herdr itself and never accepts a command or executable from input.
 */
export async function preparePairing(config, {
  url,
  runner = systemdRunner(),
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_WAIT_MS,
  intervalMs = DEFAULT_POLL_MS,
  sleepFn = sleep,
  now = Date.now,
  onProgress,
  bridgeUnit = BRIDGE_UNIT,
  tunnelUnit = QUICK_TUNNEL_UNIT,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Node fetch is required for pairing readiness checks.');
  const port = config.port ?? 8787;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid bridge port in local configuration.');
  const localOrigin = `http://127.0.0.1:${port}`;
  const selected = url ?? config.publicUrl;
  const selectedOrigin = selected !== undefined && selected !== null && String(selected).trim() !== ''
    ? normalizeHttpsOrigin(String(selected))
    : null;

  reportProgress(onProgress, 'Checking the local bridge.');
  // If an already-running bridge responds, no systemd action is needed. This
  // also permits a manually started bridge while retaining fixed-unit safety.
  let localReady = false;
  try { localReady = (await httpStatus(localOrigin, fetchImpl, Math.min(3000, timeoutMs))) === 401; } catch {}
  if (!localReady) {
    await ensureUnitStarted(runner, bridgeUnit);
    await waitForAuthGate(localOrigin, fetchImpl, {
      timeoutMs, intervalMs, sleepFn, now, description: 'the local Herdr Remote bridge',
    });
  }

  if (selectedOrigin) {
    reportProgress(onProgress, 'Checking the configured public connection.');
    await waitForAuthGate(selectedOrigin, fetchImpl, {
      timeoutMs, intervalMs, sleepFn, now, description: 'the configured public URL',
    });
    return selectedOrigin;
  }

  reportProgress(onProgress, `Checking the current public tunnel (up to ${Math.ceil(timeoutMs / 1000)} seconds per readiness check).`);
  await ensureUnitStarted(runner, tunnelUnit);
  try {
    return await waitForQuickTunnelReady(runner, fetchImpl, {
      tunnelUnit, timeoutMs, intervalMs, sleepFn, now,
    });
  } catch (firstError) {
    // A Quick Tunnel can remain active after cloudflared has lost its
    // temporary hostname. Restart only the fixed, managed Quick Tunnel unit;
    // explicit/configured URLs returned above never enter this branch.
    reportProgress(onProgress, `Quick tunnel readiness failed (${firstError.message}); retrying once after restarting the managed quick-tunnel service.`);
    try {
      await runner.exec('systemctl', ['--user', 'restart', tunnelUnit]);
    } catch (restartError) {
      throw new Error(`Quick tunnel readiness failed: ${firstError.message}; managed quick-tunnel restart failed: ${restartError.message}`);
    }
    reportProgress(onProgress, 'Managed quick-tunnel restarted; waiting for a new public URL.');
    try {
      return await waitForQuickTunnelReady(runner, fetchImpl, {
        tunnelUnit, timeoutMs, intervalMs, sleepFn, now,
      });
    } catch (retryError) {
      throw new Error(`Quick tunnel recovery failed after one restart: ${retryError.message}`);
    }
  }
}

function stripAnsi(value) {
  return String(value).replace(/\u001B\[[0-?]*[ -\/]*[@-~]/g, '');
}

function visibleWidth(value) {
  return Math.max(0, ...String(value).split(/\r?\n/).map(line => stripAnsi(line).length));
}

export async function renderPairingQr(payload, {
  columns = process.stdout.columns,
  manual = false,
  qrCode = QRCode,
} = {}) {
  if (manual) return {manual: true, qr: null};
  const qr = renderQrTerminal(qrCode.create(payload, {errorCorrectionLevel: 'M'}), 4);
  // Leave a small buffer so the right quiet zone is not wrapped away by a
  // narrow terminal. Undefined columns (pipes/CI) are treated as unbounded.
  if (Number.isInteger(columns) && columns > 0 && visibleWidth(qr) + 2 > columns) {
    return {manual: true, qr: null};
  }
  return {manual: false, qr};
}

/**
 * Render the qrcode package's module matrix with a real four-module quiet
 * zone. qrcode's built-in terminal-small renderer always emits a one-module
 * border and ignores its margin option, so padding the matrix here keeps the
 * scan margin independent of the terminal renderer's implementation.
 */
export function renderQrTerminal(qrData, margin = 4) {
  const size = qrData?.modules?.size;
  const data = qrData?.modules?.data;
  if (!Number.isInteger(size) || size < 1 || !data || data.length !== size * size) {
    throw new Error('The QR renderer returned an invalid matrix.');
  }
  if (!Number.isInteger(margin) || margin < 4 || margin > 16) {
    throw new Error('The QR quiet zone must be at least four modules.');
  }
  const width = size + margin * 2;
  const height = size + margin * 2;
  const moduleAt = (x, y) => x >= margin && x < width - margin && y >= margin && y < height - margin
    ? Boolean(data[(y - margin) * size + (x - margin)])
    : false;
  const cell = (top, bottom) => {
    if (top && bottom) return '\u001b[40m ';
    if (!top && !bottom) return '\u001b[47m ';
    if (top) return '\u001b[30m\u001b[47m▀';
    return '\u001b[37m\u001b[40m▀';
  };
  const lines = [];
  for (let y = 0; y < height; y += 2) {
    let line = '\u001b[0m';
    for (let x = 0; x < width; x += 1) line += cell(moduleAt(x, y), moduleAt(x, y + 1));
    lines.push(`${line}\u001b[0m`);
  }
  return lines.join('\n');
}

export function pairingInstructions({origin, code, expires, manual = false}) {
  const when = new Date(expires * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  const lines = [];
  if (manual) {
    lines.push('The terminal is too narrow for the QR code (or --manual was requested).');
    lines.push('In Herdr Remote, enter these values:');
    lines.push(`Laptop URL: ${origin}`);
    lines.push(`Pairing code: ${code}`);
  } else {
    lines.push('Open Herdr Remote on your phone and scan this QR code:');
  }
  lines.push(`This one-use pairing expires at ${when} (in 5 minutes).`);
  return lines.join('\n');
}
