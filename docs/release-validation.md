# Release validation: 0.8.45

Source checks on 11 October 2026 for the community Android/Linux release:
package `dev.herdr.remote.community`, Android 0.8.45 (80), and companion
0.8.45 (sequence 82). This update corrects completion acknowledgement while
retaining the community package, signing policy and deployment defaults.

| Check | Result |
| --- | --- |
| Bridge | 460 passed, no failures or skips |
| Portal | Types, check, and dry-run passed; 94 tests passed, one optional sustained relay stress test skipped |
| Linux setup generator | One test passed |
| Android unit tests, lint and unsigned release assembly | 270 passed, three optional live DNS tests skipped, no failures; debug and release lint passed with zero errors; unsigned release assembly passed |
| Native Claude lifecycle | Isolated complete/resume fixture passed with Claude Code 2.1.296 and a local fake model API |
| Community emulator | 78 synthetic UI instrumentation tests passed on the API 35 emulator |
| Public-content checks | Private-name/domain/path scan clean; no private-only tracked files; Gitleaks history and changed-file scans found no leaks |

A selected laptop pane no longer counts as reading every new Claude Code or
Codex reply. The companion keeps a verified native completion eligible for an
alert until Herdr reports an explicit idle state or a new input acknowledges
it. HTTP regressions hold the pane selected across successive turns and check
distinct, unacknowledged completion events. Native identity checks, duplicate
prevention and explicit acknowledgement remain in place.

The native fixture observed verified active work, a stable completion event,
paired history/status and native resume without a second event. It checked the
exact accepted tool result using a local fake API, then removed its owned
Herdr session and temporary workspace.

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

The optional portal development toolchain reports three high npm audit entries
through Wrangler/Miniflare/sharp. They were present in the prior release;
the production dependency audit and bridge install audit were zero then.
