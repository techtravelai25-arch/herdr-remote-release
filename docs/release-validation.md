# Release validation: 0.8.46

Source checks on 14 October 2026 for the community Android/Linux release:
package `dev.herdr.remote.community`, Android 0.8.46 (81), and companion
0.8.46 (sequence 83). This update adds **Pause phone alerts** while retaining
the community package, signing policy and deployment defaults. The companion
changes only its release version.

| Check | Result |
| --- | --- |
| Bridge | 460 passed, no failures or skips |
| Portal | Types, check, and dry-run passed; 94 tests passed, one optional sustained relay stress test skipped |
| Linux setup generator | One test passed |
| Android unit tests, lint and signed release assembly | 270 passed, three optional live DNS tests skipped, no failures; debug and release lint passed with zero errors and 15 existing warnings each; signed release assembly passed |
| Community emulator | 80 synthetic UI and OS notification instrumentation tests passed on the API 35 emulator, including two new pause tests; signed 0.8.45 to 0.8.46 upgrade kept the original installation |
| Public-content checks | Private-name/domain/path scan of the change clean; Gitleaks history and staged-change scans found no leaks |

Pause phone alerts is a bell on the dashboard, shown when cloud push or live
monitoring is on, and a switch in Settings → Notifications. While paused, the
app records each alert but does not post it. Monitoring stays connected and
cloud push stays subscribed, so resuming needs no setup and does not replay
alerts that arrived while paused. Acknowledgement and clearing are unchanged.
The ongoing monitoring notification shows when alerts are paused.

Two new emulator tests cover the change. One posts local and cloud alerts while
paused and checks that the tray stays empty, that a repeat of a paused event
stays silent after resuming, and that a new event appears. The other toggles the
pause switch without changing cloud push.

The bridge source is unchanged from 0.8.45, so the native Claude lifecycle
fixture was not rerun for this release.

Maintainer signing and packaging, the in-place upgrade, GitHub CI, and anonymous
artifact verification are recorded in the GitHub release notes after source
publication. The release assets carry the final APK checksum.

The default community APK has optional cloud endpoints disabled. A self-hosted
deployment needs its own email, FCM, relay and managed-companion acceptance
checks.

## Limits

No physical Android phone or iOS simulator was tested, and no iOS binary is
published. Saved real pairing and drafts, plus physical-phone notifications,
need separate device acceptance. The paired app on the emulator is preserved
during separate community tests.
