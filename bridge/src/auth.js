import {createLocalJWKSet, jwtVerify} from 'jose';

/** Optional account grants trust only a laptop-configured issuer and public key. */
export function createAuthenticator(store, config) {
  let keys;
  if (config) {
    const origin = new URL(config.issuer);
    if (origin.protocol !== 'https:' || origin.origin !== config.issuer ||
        typeof config.audience !== 'string' || !config.audience ||
        !Array.isArray(config.jwks?.keys) || !config.jwks.keys.length ||
        config.jwks.keys.some(key => key.kty !== 'OKP' || key.crv !== 'Ed25519' || key.d)) {
      throw new Error('Invalid portalAuth configuration. Use a fixed HTTPS issuer, laptop audience and public Ed25519 JWKS.');
    }
    keys = createLocalJWKSet(config.jwks);
  }
  return async token => {
    if (typeof token !== 'string' || token.length > 8192) return null;
    const paired = store.authenticate(token);
    if (paired) return paired;
    if (!keys) return null;
    try {
      const {payload} = await jwtVerify(token, keys, {
        algorithms: ['EdDSA'], issuer: config.issuer, audience: config.audience,
        typ: 'herdr-grant+jwt', maxTokenAge: '5m',
        requiredClaims: ['sub', 'sid', 'iat', 'exp'],
      });
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp - payload.iat > 300 || payload.iat > now ||
          typeof payload.sub !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(payload.sub) ||
          typeof payload.sid !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(payload.sid)) return null;
      return {deviceId: `account:${payload.sid}`, deviceName: payload.sub, email: payload.sub};
    } catch { return null; }
  };
}
