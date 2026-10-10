# PC activity and phone notification dismissal

A fresh Herdr `done` → `idle` transition means a completed reply was seen on the
PC. The companion acknowledges that exact completion and clears the matching
Android notification and in-app unread state. Resuming the pane also acknowledges
its previous reply. Work that finishes directly in Herdr's `idle` state is already
seen on the PC and does not create an unread completion alert.

Input-request and error alerts now retain their own event identities. Resuming
work or replacing an attention alert clears the old event. A successful phone
prompt acknowledges the completion and attention events captured before dispatch;
its delayed response cannot acknowledge a newer event.

Acknowledgements persist on the companion and travel through live snapshots and
cloud clear messages. Android records exact event tombstones to prevent delayed
messages from recreating dismissed alerts. A clear for an older alert cannot
remove a newer alert or another pane's notification. Stale/offline snapshots and
`unknown` status do not prove acknowledgement. Returning from `unknown` to the
same input request preserves the existing identity.

Local attention notifications created before event tracking are cleared after a
fresh confirmed resume. Already-delivered legacy cloud attention notifications
have no retained companion identity and cannot be reconstructed for an exact
clear. Normal Android background delivery and network delays still apply.

This behavior uses Herdr's pane status, not general keyboard/mouse activity on the
PC. Looking at a different pane does not acknowledge an unrelated reply. A request
that still needs an answer remains outstanding until it is resolved. This
behavior requires the Android app and companion 0.8.29 or later.

Local live-monitoring alerts also require an explicit `done` state after observed
work from the same agent. `working` → `idle` never sends a reply-ready alert or
creates a new unread marker, including with older bridges without event IDs.
Acknowledged `done` events are suppressed. This applies to Claude and Codex alike.
