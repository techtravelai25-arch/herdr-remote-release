# Release validation: 0.8.44

Verified locally on 11 October 2026 for the community Android/Linux release:
package `dev.herdr.remote.community`, Android 0.8.44 (79), and companion
0.8.44 (sequence 81). This update contains the reviewed question-state
correction while retaining the community package and deployment defaults.

| Check | Result |
| --- | --- |
| Bridge | 460 passed, no failures or skips |
| Portal | Types, check, and dry-run passed; 94 tests passed, one optional sustained relay stress test skipped |
| Linux setup generator | One test passed |
| Android unit tests | 270 passed; three optional live DNS checks skipped |
| Android lint | Debug and release: zero errors, 15 warnings each |
| Signed release | Community package and 0.8.44 (79), non-debuggable, expected certificate, matching bundled legal notices, APK linkage passed |
| Community emulator | All 78 Compose and OS notification instrumentation tests passed on Android 15 / API 35 |
| Native Claude fixture | Single and multiple custom answers, trust Exit/relaunch, and complete/resume lifecycle passed with Claude Code 2.1.296 |
| In-place upgrade | Signed 0.8.43 to 0.8.44 install succeeded; saved Dark theme survived and the original installation time was unchanged |
| Public-content checks | Changed source scan found no private names, domains or paths; Gitleaks history and changed-file scans found no leaks |

The bridge regression covers an answered Claude Code question followed by a
desktop draft and current status footer, and an older composer above an
incomplete question menu. Android regressions cover delayed questions, fresh
no-question output, transition state, dismissed question IDs, and the pending
terminal view. The phone keeps checking fresh output while a question action
is pending. A pane's idle status alone does not authorize an old answer.

The isolated native fixtures observed the exact accepted answer in Claude
Code's tool result through the local fake model API. Choosing Exit returned to
the shell, required folder trust on relaunch, and made no model API calls.
Each fixture removed its owned Herdr session and temporary workspace.
The lifecycle fixture observed live work, stable completion, paired history,
one completion event, and native resume without another alert.

The signed release APK's SHA-256 is
`76f226edb66fda8a023e990b089750020624d86c9e7032ce7bf0b493e51bea09`.
Its certificate SHA-256 remains
`fb79225bfd54ca4158db75befca85ec8980a742fcf2b13b6ae86d779325dc73e`.
The community emulator upgrade preserved the existing app installation and
Dark appearance setting; the previous Use device setting choice was restored
after the check. The community app remained unpaired. Instrumentation used
only the separate community debug and test packages with synthetic data.
The paired private app was not uninstalled. GitHub CI and anonymous downloads
are checked after the public source and release are published.

The community package ID, signing policy, optional cloud defaults and
community-only setup behavior remain in place. The default APK has optional
cloud endpoints disabled. A self-hosted deployment needs its own email, FCM,
relay and managed-companion acceptance checks.

## Limits

No physical Android phone or iOS simulator was tested, and no iOS binary is
published. Saved real pairing and drafts, plus physical-phone notifications,
need separate device acceptance. Native fixtures use isolated test sessions
with a local fake model endpoint; they do not send input to an active user's
pane.

The optional portal development toolchain reports three high npm audit entries
through Wrangler/Miniflare/sharp. They were present in the prior release;
the production dependency audit and bridge install audit were zero then.
