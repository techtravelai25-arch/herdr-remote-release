# Release validation: 0.8.43

Verified locally on 11 October 2026 before publication. This is a community
Android/Linux release, with package `dev.herdr.remote.community`, Android
0.8.43 (78), and companion 0.8.43 (sequence 80).

| Check | Result |
| --- | --- |
| Bridge | 457 passed, no failures or skips |
| Portal | Types/check and dry-run passed; 94 tests passed, one optional sustained relay stress test skipped |
| Linux setup generator | One test passed |
| Android unit tests | 266 passed; three optional live DNS checks skipped |
| Android lint | Debug and release: zero errors, 15 warnings each |
| Signed release | Non-debuggable community package, expected version and certificate, matching bundled legal notices; APK linkage passed |
| Community emulator | All 77 Compose and OS notification instrumentation tests passed on Android 15 / API 35 |
| Native Claude | Single/multiple custom answers, trust Exit/relaunch and complete/resume lifecycle fixtures passed using a local fake model API |
| Public-content checks | Gitleaks staged and history scans passed; private names/domains/paths and private-only files were excluded |

The native fixtures used Herdr 0.9.1 and Claude Code 2.1.296. They owned isolated
sessions, checked the exact native tool result, and removed their sessions and
workspaces. The lifecycle fixture observed active work, completion/Idle, paired
HTTP history, a stable completion event and resume without another alert. No
paid model API or active user's pane was used.

The signed APK upgraded the existing community 0.8.39 (74) emulator installation
in place. Its original installation time was unchanged, and a saved Dark theme
survived the upgrade; the previous theme setting was then restored. Onboarding
and Settings opened successfully. The separately installed paired app was not
uninstalled. Instrumentation used only the separate community debug/test packages
and synthetic alerts. The existing debug signer was selected for compatibility.

The initial combined Android build exhausted its 384 MiB compiler metaspace
allowance. The completed run used 768 MiB metaspace and a 1.5 GiB heap, with no
source changes. The first instrumentation install rejected the shell's different
debug certificate; selecting the existing fixture's key allowed an in-place
install and all 77 tests passed. Neither failure is counted as a passing run.

The dedicated release certificate SHA-256 remains
`fb79225bfd54ca4158db75befca85ec8980a742fcf2b13b6ae86d779325dc73e`.
The release assets contain the final APK size and SHA-256 in `app-update.json`
and `SHA256SUMS`. The source archive is produced from the clean public commit;
its `SOURCE_REVISION` identifies that commit. Release assets and local test logs
are excluded from Git. This is a local maintainer build, with no claim of signed
CI build provenance. GitHub CI and anonymous downloads are checked after the
source push; their outcome is recorded in the GitHub release notes.

## Limits

No physical Android phone or iOS simulator was tested, and no iOS binary is
published. The community release remained unpaired during the upgrade check;
saved real pairing/drafts and physical-phone notifications were not verified.
The default APK has optional cloud endpoints disabled. A self-hosted deployment
needs its own email, FCM, relay and managed-companion acceptance checks.

Unsupported or partial native evidence is conservative; native completion proves
an agent turn ended, not that its task succeeded. Codex title/DB/process recovery
is weaker than authenticated native hook lineage, and a pane switch after the
last identity recheck remains a narrow upstream race.

The unchanged optional portal development toolchain reports three high npm audit
entries through Wrangler/Miniflare/sharp. The portal production dependency audit
(`npm audit --omit=dev`) reports zero, and bridge install audit reports zero.
These development advisories are an outstanding maintenance item.
