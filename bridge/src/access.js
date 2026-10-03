import {BridgeError} from './herdr.js';

const modes = new Set(['observer', 'normal', 'terminal']);

// This file is owned by the laptop. Relay state cannot override it.
export function accessState(store) {
  const state = store.read('access.json', {enabled:true, devices:{}});
  return {
    enabled:state?.enabled !== false,
    devices:state?.devices && typeof state.devices === 'object' && !Array.isArray(state.devices) ? state.devices : {},
    accounts:state?.accounts && typeof state.accounts === 'object' && !Array.isArray(state.accounts) ? state.accounts : {},
  };
}

export function setRemoteEnabled(store, enabled) {
  const state = accessState(store);
  store.write('access.json', {...state, enabled:enabled === true});
}

export function setDeviceMode(store, deviceId, mode) {
  if (typeof deviceId !== 'string' || !deviceId || !modes.has(mode)) throw new Error('Choose a device ID and observer, normal or terminal.');
  const state = accessState(store);
  store.write('access.json', {...state, devices:{...state.devices, [deviceId]:mode}});
}

export function setAccountMode(store, email, mode) {
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email.trim()) || !modes.has(mode))
    throw new Error('Choose an account email and observer, normal or terminal.');
  const state = accessState(store);
  store.write('access.json', {...state, accounts:{...state.accounts, [email.trim().toLowerCase()]:mode}});
}

export function requireAccess(store, device, action='read', config={}) {
  const state = accessState(store);
  if (!state.enabled) throw new BridgeError('remote_disabled','Remote control is disabled on the laptop.',403);
  // Accounts stay read-only unless the laptop owner explicitly grants the
  // verified email its own authority. A per-credential override takes precedence.
  const accountMode = device.deviceId.startsWith('account:') && typeof device.email === 'string'
    ? state.accounts[device.email.toLowerCase()] : undefined;
  const mode = state.devices[device.deviceId] || accountMode || (device.deviceId.startsWith('account:') ? 'observer' : 'normal');
  if (!modes.has(mode)) throw new BridgeError('permission_denied','Device access mode is invalid.',403);
  if (action === 'write' && mode === 'observer') throw new BridgeError('permission_denied','This device has observer access.',403);
  if (action === 'terminal' && (mode !== 'terminal' || config.allowTerminalInput !== true))
    throw new BridgeError('terminal_input_disabled','Terminal input requires a laptop terminal grant and allowTerminalInput.',403);
  return mode;
}
