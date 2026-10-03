# Optional portal authentication

Direct QR pairing does not need a portal. Follow [portal setup](../portal/README.md) first if you want email sign-in. This implementation trusts one owner or a group sharing all laptops: every allowed email can obtain grants for every registered laptop. It has no per-user laptop ownership.

## Origins and device identity

Use your own domain in place of `https://remote.example.com` for the portal and `https://laptop.example.com` for the laptop tunnel. Set `PORTAL_ORIGIN` to the exact HTTPS origin, without a trailing slash. In your ignored `portal/wrangler.local.jsonc`, set `DEVICES` to a JSON-encoded string such as:

```json
"DEVICES": "[{\"id\":\"laptop\",\"label\":\"My laptop\",\"url\":\"https://laptop.example.com\"}]"
```

The laptop ID must match the bridge's `portalAuth.audience`. Protect the portal's `/login*` routes with your Cloudflare Access application and copy its team domain and audience into `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. Keep the Access policy and the JSON-encoded `ALLOWED_EMAILS` list synchronized. Leave native `/v1` API routes outside browser-only Access; they enforce their own token authentication.

## Generate the signing key

From the repository root, this Node command generates fresh keys outside the checkout. It refuses to replace existing files. The private JWK stays on your machine until you upload it as a Worker secret; only the public JWKS belongs on laptops.

```bash
node --input-type=module <<'JS'
import {generateKeyPairSync, randomUUID} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
const directory = join(homedir(), '.config', 'herdr-remote', 'portal-keys');
mkdirSync(directory, {recursive:true, mode:0o700});
const {privateKey, publicKey} = generateKeyPairSync('ed25519');
const metadata = {kid:randomUUID(), alg:'EdDSA', use:'sig'};
const privateJwk = {...privateKey.export({format:'jwk'}), ...metadata};
const publicJwk = {...publicKey.export({format:'jwk'}), ...metadata};
writeFileSync(join(directory, 'grant-private.json'), JSON.stringify(privateJwk), {flag:'wx', mode:0o600});
writeFileSync(join(directory, 'grant-public.json'), JSON.stringify({keys:[publicJwk]}, null, 2), {flag:'wx', mode:0o600});
JS
cd portal
npx wrangler secret put GRANT_SIGNING_JWK --config wrangler.local.jsonc < "$HOME/.config/herdr-remote/portal-keys/grant-private.json"
```

Merge this field into the laptop's private bridge configuration, preserving its other settings. Replace `keys` with the actual array from `grant-public.json`:

```json
{
  "portalAuth": {
    "issuer": "https://remote.example.com",
    "audience": "laptop",
    "jwks": {
      "keys": [
        {"kty":"OKP","crv":"Ed25519","x":"REPLACE_WITH_PUBLIC_X","kid":"REPLACE_WITH_KEY_ID","alg":"EdDSA","use":"sig"}
      ]
    }
  }
}
```

Never include the private `d` field in bridge JWKS. The bridge validates signed grants locally against these configured public keys; it does not automatically download replacements. The portal exposes the public key at `/.well-known/jwks.json` for inspection. When rotating keys, distribute the new public key to bridges before switching the portal's private key, keep both public keys during the five-minute grant overlap, then remove the old key.

## Activate and verify

Apply the D1 migrations and deploy your configured portal as described in its README. Restart only `herdr-remote-bridge` after changing its configuration; there is no need to restart Herdr or agents. Build your Android app with `-PherdrPortalOrigin=https://remote.example.com`. For a development APK, run from `android/`:

```bash
./gradlew assembleDebug -PherdrPortalOrigin=https://remote.example.com
```

The public release APK defaults to QR pairing with portal sign-in disabled. A self-hosted portal requires your configured build. Debug builds use the `.debug` application ID suffix and install separately.

Sign in with an allowed email, confirm the matching device code in the browser, select a laptop, and read its sessions. Verify a disallowed email cannot complete sign-in. Keep the HTTPS laptop endpoint free of browser-only Access redirects. Removing an email prevents new portal sessions/grants; a grant already issued can remain valid on the bridge until its five-minute expiry. Existing direct QR pairings are independent and must be revoked separately if needed.
