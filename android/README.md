# Android builds

Requires JDK 17 and Android SDK 36. From this directory, run:

```sh
./gradlew testDebugUnitTest lintDebug assembleDebug
```

For the Android emulator UI suite, run `scripts/run-emulator-ui-tests.sh` from
the repository root. It installs the separate community debug package for the
test run and checks its Compose screens and callbacks.

Debug builds use an automatically generated local Android debug key and install as
`dev.herdr.remote.community.debug`. Release builds install as
`dev.herdr.remote.community`.

The default build connects through QR pairing to your own HTTPS bridge. It does
not contact an account portal, update service, or Firebase. Live notification
monitoring is available without a portal. Optional voice transcription sends
recordings to Groq only when the user configures and uses it.

## Optional cloud deployment

These public Gradle properties are compiled into the APK; they are not secrets:

| Property | Meaning |
| --- | --- |
| `herdrPortalOrigin` | HTTPS origin serving the optional account and push APIs |
| `herdrUpdateOrigin` | HTTPS origin serving `/v1/app-update` and `/v1/app-update/apk` |
| `herdrDownloadUrl` | HTTPS release page opened from Settings and crash recovery |

The portal and update origins default to empty. The download URL defaults to the
[community release page](https://github.com/techtravelai25-arch/herdr-remote-release/releases/latest).
Configure the origins only if deploying those services.
Origins cannot contain a path, query, fragment, or credentials. The download URL
can contain a path but no query, fragment, or credentials. Non-default HTTPS ports
are supported. Example:

```sh
./gradlew assembleDebug -PherdrPortalOrigin=https://portal.example.test
```

The portal is designed for one trusted audience, not a public multi-tenant service.
The APK updater checks the configured endpoint, digest, package name, version and
installed signing identity; changing a signing key requires a separate install.
Configured service domains and temporary Cloudflare tunnel hostnames can also
use Cloudflare DNS-over-HTTPS if system resolution fails or returns no IPv4 route.

## Release signing

Use a dedicated private release key stored outside this repository. Set:

- `HERDR_RELEASE_KEYSTORE`: absolute keystore path (or Gradle property `herdrReleaseKeystore`)
- `HERDR_RELEASE_STORE_PASSWORD`
- `HERDR_RELEASE_KEY_ALIAS`
- `HERDR_RELEASE_KEY_PASSWORD`

Then run `./gradlew assembleRelease`. Without signing configuration this task
produces an unsigned APK, which must not be published as an installable release.
Never commit a keystore, password, or generated signing configuration. Keep a
secure backup of the release key; updates must use the same key.

Opt-in live tests only contact origins explicitly supplied using
`HERDR_DNS_SMOKE_URL` (bridge) or `HERDR_UPDATE_SMOKE_URL` (update service).
Ordinary unit tests do not require either service.
