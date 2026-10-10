# Release process

The Android release package is `dev.herdr.remote.community`; development builds add `.debug`. Version 0.8.26 (61) was the first release from this repository; later versions keep the same certificate and update it in place. The dedicated certificate is recorded in `release-signing.json`. Builds signed with another key cannot update it in place.

## Verify a download

Download the APK and `SHA256SUMS` from the same [GitHub release](https://github.com/techtravelai25-arch/herdr-remote-release/releases/latest), then run:

```sh
sha256sum -c SHA256SUMS
apksigner verify --verbose --print-certs herdr-remote.apk
```

Compare the certificate SHA-256 digest with `release-signing.json` from that release's source tag. APK checksums detect changed bytes; Android's signing identity controls compatible updates. This initial locally built release does not claim GitHub build provenance.

## Build and publish

Contributor builds need no maintainer credentials. Use your local debug signer for development. Distributing a fork requires your own package ID and signing key.

For a maintainer release, protect and back up the private signing key outside the checkout. Losing it prevents normal compatible updates. Set `HERDR_RELEASE_KEYSTORE`, `HERDR_RELEASE_STORE_PASSWORD`, `HERDR_RELEASE_KEY_ALIAS`, and `HERDR_RELEASE_KEY_PASSWORD`; never print or commit them. See `android/README.md` for Gradle options.

Run unit tests, debug/release lint, the APK linkage check, and the relevant emulator tests. Verify device acceptance separately; emulator coverage is not physical-phone coverage. From `android/`, build:

```sh
./gradlew --no-daemon :app:testDebugUnitTest :app:lintDebug :app:lintRelease :app:assembleRelease
```

From the repository root, with `ANDROID_HOME` set to the SDK:

```sh
python3 scripts/package-release.py --apk android/app/build/outputs/apk/release/app-release.apk --tag v0.8.39 --out artifacts
```

The packaging check rejects a different certificate, package ID, debuggable APK, version mismatch, or stale legal notices. After committing the tested public source, run `ops/package-source.sh artifacts` to create `herdr-remote-source.tar.gz` with the matching source revision. Publish that archive, `herdr-remote.apk`, `SHA256SUMS`, `app-update.json`, `release-signing.json`, and the three notice files with the matching source tag. Include every other asset in `SHA256SUMS`. Release assets are not committed to Git.

CI runs source checks without release credentials. Releases are published by the maintainer account after verification; CI does not deploy a portal, touch a user's laptop, or automatically publish tags.

For changes to Claude Code question controls, also run the opt-in native fixture from `bridge/` with installed Claude Code and Herdr:

```sh
HERDR_ENV=1 npm run test:claude-herdr
HERDR_ENV=1 npm run test:claude-herdr -- --multi
HERDR_ENV=1 npm run test:claude-herdr -- --trust-exit
```

It starts isolated test panes and a local fake model endpoint and checks the exact submitted tool result. Do not use active user panes as test fixtures.
