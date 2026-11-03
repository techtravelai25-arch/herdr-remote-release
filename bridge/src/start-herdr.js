import {BridgeError} from './herdr.js';

/** Start herdr-core only when its socket is missing or refused, then wait until it answers. */
export async function ensureHerdrRunning({herdr, startUnit = () => herdr.call('server.start', {}, 15000), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, timeoutMs = 15000}) {
  try {
    await herdr.call('ping', {}, 1000);
    return {alreadyRunning: true};
  } catch (error) {
    // Never restart or compete with a server that is reachable but busy or
    // unresponsive. Only a missing/refused socket may start the core.
    if (error.code !== 'herdr_offline') throw error;
  }
  await startUnit();
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      await herdr.call('ping', {}, Math.max(1, Math.min(1000, deadline - now())));
      return {alreadyRunning: false};
    } catch (error) {
      if (!['herdr_offline', 'herdr_timeout', 'herdr_disconnected'].includes(error.code)) throw error;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(250, remaining));
  }
  throw new BridgeError('herdr_start_timeout', 'Herdr has not become ready yet. Refresh shortly; no existing process was stopped.', 504);
}
