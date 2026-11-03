# Release validation: 0.8.48

Source checks on 3 November 2026 for the community Android/Linux release:
package `dev.herdr.remote.community`, Android 0.8.48 (83), and companion
0.8.48 (sequence 85). The companion now also shows and controls Herdr desktop
app sessions (herdr-app 0.1.12, herdr-core 0.1.17) next to Herdr TUI sessions,
and again confirms Claude Code (2.1.300+) and Codex (0.165+) turn completion.
The Android app changes only its release version.

| Check | Result |
| --- | --- |
| Bridge | 474 passed, no failures or skips, including 11 desktop-app backend tests and the new Claude and Codex record tests |
| Android unit tests, lint and signed release assembly | 273 passed, three optional live DNS tests skipped, no failures; debug and release lint passed with zero errors and 17 warnings each; signed release assembly passed |
| Community emulator | 80 synthetic UI and OS notification instrumentation tests passed on the API 35 emulator; signed 0.8.46 to 0.8.48 upgrade kept the original installation |
| Public-content checks | Private-name/domain/path scan of the change clean; Gitleaks 8.30.1 scans of `main` history and of the staged change found no leaks |

The desktop-app backend reads screens through an observe-only herdr-core attach
and accepts a read that can authorize input only when herdr-core's repaint
header and trailer, a single frame, an unchanged terminal size and herdr-core's
own screen text all agree. Its design, read contract and limits are in
[Herdr desktop app backend](herdr-app-backend.md). `@xterm/headless` 6.0.0
(MIT) was added to the bridge; its notice is in `THIRD_PARTY_NOTICES.md`.

Maintainer signing and packaging, GitHub CI, and anonymous artifact
verification are recorded in the GitHub release notes after source
publication. The release assets carry the final APK checksum.

The default community APK has optional cloud endpoints disabled. A self-hosted
deployment needs its own email, FCM, relay and managed-companion acceptance
checks.

## Limits

No physical Android phone or iOS simulator was tested, and no iOS binary is
published. Saved real pairing and drafts, plus physical-phone notifications,
need separate device acceptance. The paired app on the emulator is preserved
during separate community tests.
