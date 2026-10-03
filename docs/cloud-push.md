# Optional cloud push

Cloud push requires your own [portal sign-in setup](portal-auth.md), Firebase project, and an Android phone with compatible Google Play services. QR-only phones can use the foreground connection monitor without Firebase. The app offers these as separate notification modes.

This portal is for one owner or a trusted group sharing all laptops. Push events are delivered to eligible signed-in sessions across that group; there is no per-owner isolation. Payloads contain event/laptop/pane identifiers and a status kind (`done`, `needs_input`, or `error`), not prompts, terminal text, filenames or code. FCM registration tokens are retained in the portal's D1 database for delivery.

## Firebase and Worker configuration

1. Create a Firebase project and register the Android package you will install: `dev.herdr.remote.community` for release or `dev.herdr.remote.community.debug` for a debug build. Use a matching app registration/API-key restriction for each build. Enable the Firebase Cloud Messaging HTTP v1 API.
2. From that Android app's Firebase configuration, map `project_id`, `mobilesdk_app_id`, `project_number`, and `current_key` into the following object. Set `FIREBASE_ANDROID_CONFIG` in ignored `portal/wrangler.local.jsonc` to its **JSON-encoded string**, as with `DEVICES`:

   ```json
   {"projectId":"your-project-id","applicationId":"1:123456:android:abcdef","senderId":"123456","apiKey":"REPLACE_WITH_FIREBASE_ANDROID_API_KEY"}
   ```

   These are client configuration values, not the service-account private key. The app obtains them after portal authentication and initializes Firebase programmatically; do not add `google-services.json` to this repository.
3. Create a dedicated service account in the same Firebase project, grant it Firebase Cloud Messaging API Admin (`roles/firebasecloudmessaging.admin`), and download its JSON private key to a protected file outside the checkout. The Worker signs OAuth assertions and calls FCM HTTP v1 using this key. Set the Worker secret from `portal/`:

   ```bash
   npx wrangler secret put FIREBASE_SERVICE_ACCOUNT --config wrangler.local.jsonc < /absolute/private/firebase-service-account.json
   ```

   The service account's `project_id` must equal the client configuration's `projectId`. This implementation requires a service-account JSON key; it does not implement workload identity federation. See the official [FCM server authorization instructions](https://firebase.google.com/docs/cloud-messaging/send/v1-api).

## Bridge credential

Run this command on each laptop. It generates a new 32-byte base64url token without printing it and refuses to overwrite an existing token. The hash file is the value uploaded to the Worker; the raw token stays on the laptop.

```bash
node --input-type=module <<'JS'
import {randomBytes, createHash} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
const directory = join(homedir(), '.config', 'herdr-remote');
mkdirSync(directory, {recursive:true, mode:0o700});
const token = randomBytes(32).toString('base64url');
writeFileSync(join(directory, 'bridge-push.token'), token, {flag:'wx', mode:0o600});
const hashes = {laptop:createHash('sha256').update(token).digest('hex')};
writeFileSync(join(directory, 'bridge-push-hashes.json'), JSON.stringify(hashes), {flag:'wx', mode:0o600});
JS
cd portal
npx wrangler secret put PUSH_BRIDGE_TOKEN_HASHES --config wrangler.local.jsonc < "$HOME/.config/herdr-remote/bridge-push-hashes.json"
```

`laptop` must be the ID in `DEVICES`. For multiple laptops, use distinct tokens and combine their hash entries in one JSON object before uploading; `secret put` replaces the whole map. Never put raw bridge tokens in Wrangler variables, the APK, or Git.

Merge this into each laptop's existing private bridge configuration:

```json
{
  "cloudPush": {
    "portalOrigin": "https://remote.example.com",
    "deviceId": "laptop",
    "tokenFile": "/absolute/private/bridge-push.token"
  }
}
```

Set `tokenFile` to the absolute path generated above. The bridge rejects symlinks and group/world-accessible token files. `portalOrigin` must be an exact HTTPS origin without path, query, credentials or trailing slash.

## Activate and test

From `portal/`, apply migrations and deploy your local configuration:

```bash
npx wrangler d1 migrations apply herdr-remote-portal --remote --config wrangler.local.jsonc
npx wrangler deploy --config wrangler.local.jsonc
```

Restart only the laptop bridge after saving its configuration. On your portal-configured Android build, sign in, allow notifications, then enable **Settings → Notifications → Cloud push**. Generate a new completion and a new question/needs-input transition while the app is backgrounded. Confirm each notification arrives and opens the intended session. Merely registering the phone or seeing configuration report `available` does not prove delivery.

If unavailable, check all three Worker configuration values: `FIREBASE_ANDROID_CONFIG`, `FIREBASE_SERVICE_ACCOUNT`, and `PUSH_BRIDGE_TOKEN_HASHES`. If registration fails, check the Firebase Android app registration and API-key restrictions. If delivery fails, check service-account permissions and the FCM API in the matching project. The official [Android FCM setup guide](https://firebase.google.com/docs/cloud-messaging/android/get-started) covers client prerequisites and notification permission.

The bridge retains at most 128 pending events for 24 hours and retries temporary failures. The initial snapshot does not announce old completed work. Push cannot wake a sleeping laptop; force-stopping the Android app can prevent background delivery until reopened. Disabling cloud push/signing out disables local receipt and attempts to remove the subscription. Expired, revoked or disallowed sessions do not receive new sends, although an already in-flight notification may arrive. Opening a pane still requires current authorization.

To leave push disabled, omit `cloudPush` from the bridge and keep the portal's `FIREBASE_ANDROID_CONFIG` as `"{}"`. No Firebase project is needed for direct QR pairing.
