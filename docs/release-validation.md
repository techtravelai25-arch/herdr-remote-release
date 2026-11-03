# Release validation: 0.9.1

Source checks on 3 November 2026 for the community Android/Linux release:
package `dev.herdr.remote.community`, Android 0.9.1 (85), and companion
0.9.1 (sequence 87). Community 0.9.0 was not published; 0.9.1 includes its
changes. The companion now works only with the Herdr core (herdr-core 0.1.17,
the backend of the Herdr desktop app); the Herdr TUI is no longer supported.
Status and alerts come from Herdr, and the app shows a live terminal with
control sessions instead of per-agent question and model menus.

| Check | Result |
| --- | --- |
| Bridge | 304 passed, no failures or skips, including the live-terminal, control-session and Herdr core event tests |
| Portal | 94 passed, one optional stress test skipped; types, check and deploy dry run passed |
| Linux setup | `ops/test_setup.py` passed (no Herdr TUI unit, no `socketPath`) |
| Android unit tests, lint and signed release assembly | 245 tests: 242 passed, three optional live DNS tests skipped, no failures; debug and release lint passed with zero errors and 17 warnings each; signed release assembly passed |
| Community emulator | 53 synthetic UI and OS notification instrumentation tests passed on the API 35 emulator, including all 11 `TerminalLiveViewRegressionTest` tests; signed 0.8.48 to 0.9.1 upgrade kept the original installation and the app started |
| Public-content checks | Private-name/domain/path scan of the tree clean; Gitleaks 8.30.1 scans of `main` history and of the staged change found no leaks |

`TerminalLiveViewRegressionTest` checks that the live terminal page is really
visible with a non-zero height: Android 0.9.0 shipped an empty terminal box
because the page got no height on the phone, which 0.9.1 fixes.

The live terminal uses bundled xterm.js 6.0.0 (MIT), byte-identical to the
npm package; its notice is in `NOTICE` and `THIRD_PARTY_NOTICES.md`.
`discovery/herdr-core-schema.json` is the unmodified schema from hc 0.1.17.
The design, the live-terminal and input contracts and the relay budget are in
[Herdr backend](herdr-app-backend.md).

Maintainer signing and packaging, GitHub CI, and anonymous artifact
verification are recorded in the GitHub release notes after source
publication. The release assets carry the final APK checksum.

The default community APK has optional cloud endpoints disabled. A self-hosted
deployment needs its own email, FCM, relay and managed-companion acceptance
checks.

## Limits

No physical Android phone or iOS simulator was tested, and no iOS binary is
published. The community emulator tests use synthetic data; the live terminal
against a real laptop pane, saved real pairing and physical-phone
notifications need separate device acceptance. The paired app on the emulator
is preserved during separate community tests.
