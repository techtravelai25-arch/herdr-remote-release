# Herdr Remote 0.8.26

First Android release from this repository, published as a fresh source snapshot.

- Self-hosted QR pairing and a separate community Android package.
- Current bridge and Android protocol support, conversation history, attachments, and change review.
- Review state clears when selecting another pane, and failed review loads clear obsolete content.
- Landscape terminal and composer layouts remain reachable when space is limited.
- Stale attachment snapshots disable deletion until refreshed.
- Optional cloud features require an explicitly configured deployment.

Download [herdr-remote.apk](https://github.com/techtravelai25-arch/herdr-remote-release/releases/latest/download/herdr-remote.apk) and follow [laptop setup](setup.md). Android 8.0+ is required. This release uses a new signing identity; older community APKs signed with a different key require a fresh installation and pairing. An iOS app is not included.

The release is checked on an Android emulator. Physical-device and optional self-hosted cloud acceptance remain separate checks.
