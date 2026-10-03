# Herdr Remote

An Android companion for [Herdr](https://github.com/herdrdev/herdr). Read agent conversations, answer questions, send prompts, review changes, and start sessions on your own Linux computer.

[Download the Android APK](https://github.com/techtravelai25-arch/herdr-remote-release/releases/latest/download/herdr-remote.apk) · [Release notes](docs/release-notes.md) · [Laptop setup](docs/setup.md)

## Install

Download `herdr-remote.apk` from the release above. Open it on Android and allow installation from your download app when Android requests it. Android 8.0 (API 26) or newer is required.

Version **0.8.26 (61)** uses package `dev.herdr.remote.community`. It installs separately from other Herdr Remote packages. This repository establishes a new release signing identity; an older community installation signed with another key requires a fresh installation and pairing. Verify [release checksums and signing](docs/releases.md).

On your laptop, install Herdr 0.9.0 (socket protocol 22), Node.js 22+, and the coding agents you use. Clone this repository and follow [laptop setup](docs/setup.md). Expose the loopback bridge through your own HTTPS route, then scan its short-lived QR code in the app. Provider accounts and credentials stay on your laptop.

The distributed APK supports self-hosted QR pairing. Optional portal sign-in, cloud notifications, and automatic update services require your own deployment and a configured app build; see [portal setup](portal/README.md). No hosted service account is required for direct pairing. The Linux installer uses systemd; Windows and macOS hosting are not verified. An iOS app is not included in this release.

## Development

```sh
npm ci --prefix bridge
npm test --prefix bridge
npm ci --prefix portal
npm run types --prefix portal
npm run check --prefix portal
npm test --prefix portal
```

Android builds require JDK 17 and Android SDK 36. See [Android builds](android/README.md), [contributing](CONTRIBUTING.md), [security and data handling](SECURITY.md), and the [release process](docs/releases.md).

## License

Original code is licensed under AGPL-3.0-or-later; see [LICENSE](LICENSE) and [NOTICE](NOTICE). Dependencies retain their own terms, recorded in [third-party notices](THIRD_PARTY_NOTICES.md). Herdr and the supported agents are separate projects. This is not an official product of their vendors.
