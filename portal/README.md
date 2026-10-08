# Optional self-hosted portal

The Android app and laptop bridge can pair through your own HTTPS bridge without this portal. The release APK is available from [GitHub Releases](https://github.com/techtravelai25-arch/herdr-remote-release/releases/latest); the portal's public download button points there by default through `PUBLIC_APK_URL`. Automatic app updates are disabled unless you build the app with your own update origin.

The portal adds an encrypted relay, optional account sign-in and laptop directory, optional push notifications, and optional hosted APK distribution. The checked-in `wrangler.jsonc` uses placeholder domains and database IDs, has no users or credentials, and cannot serve a production deployment as-is. The default account settings describe one owner or a trusted group. Do not enable public signup for unrelated users without reviewing the tenant isolation and abuse controls yourself.

## Check locally

Run `npm ci`, `npm run types`, `npm run check`, `npm test`, and `npm run dry-run` from this directory. The dry-run script creates an empty local assets directory; it does not deploy the Worker. Migration number `0006` is intentionally absent; never reuse it.

## Configure your portal

1. Copy `wrangler.jsonc` to ignored `wrangler.local.jsonc`. Set a custom HTTPS route and matching `PORTAL_ORIGIN`. Create your own D1 database and replace the placeholder ID. Apply every migration in `migrations/` with `npx wrangler d1 migrations apply herdr-remote-portal --remote --config wrangler.local.jsonc`.
2. Configure the Durable Object and rate-limit bindings for your Cloudflare account. Keep `LAPTOP_REGISTRATION_ENABLED` and `PUBLIC_SIGNUP_ENABLED` disabled until you have configured and tested their prerequisites. If you migrate an old domain, set `LEGACY_PORTAL_ORIGIN` to its exact HTTPS origin; otherwise leave it empty.
3. For email sign-in, protect `/login*` using your Cloudflare Access application. Set `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and `ALLOWED_EMAILS`. Follow [portal authentication](../docs/portal-auth.md) to create your own grant-signing key and configure each bridge's public JWKS. Do not put browser-only Access in front of the bridge API.
4. For direct server directory entries, set `DEVICES` to a JSON string such as `[{"id":"laptop","label":"My laptop","url":"https://laptop.example.com"}]`. Point that HTTPS name to your loopback bridge through a tunnel. Never expose its plain HTTP listener to the internet.
5. Build Android with your `herdrPortalOrigin` if you want account sign-in. Set `herdrUpdateOrigin` only when you operate an update service. The community app defaults `herdrDownloadUrl` to the GitHub release APK; override it if you distribute from your own domain. Firebase push is optional; use your own project and service account as described in [cloud push setup](../docs/cloud-push.md).
6. To host an APK, publish a verified, signed community build with `ops/publish-apk.sh` and stage it with `ops/publish-cloud-apk.sh --stage-only`. Set `PUBLIC_APK_URL` to `/v1/app-update/apk` in your local Wrangler config. Review the generated `release-assets/` and your local Wrangler config before deploying. The companion installer routes also require a separately packaged and signed companion archive; until then, direct bridge setup via [companion setup](../docs/companion-setup.md) works without those routes.

The public `/download` page links to the configured APK. The `/v1/app-update` routes serve a staged APK without account authentication when you host one. Account and device controls stay authenticated. You can distribute the APK through GitHub Releases without deploying a portal.
