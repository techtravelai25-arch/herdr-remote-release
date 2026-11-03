# Herdr backend

Herdr Remote drives the **Herdr core** (`herdr-core`, `hc` 0.1, protocol generation 1):
the backend of the Herdr desktop app, which keeps terminals and agents running
whether or not the app window is open. The Herdr TUI (`herdr server`) is no
longer supported. The core socket is `$XDG_RUNTIME_DIR/herdr-core/default.sock`,
or `coreSocketPath` in the config.

```text
phone ──▶ bridge routes ──▶ HerdrCore adapter ──▶ herdr-core (JSON-RPC, framed streams)
             ▲                    ▲
             └── core events ─────┘  (events.subscribe: status, turn, title, labels, …)
```

The bridge relies on Herdr for what each agent is doing. It does not parse
agent screens or read agent logs to decide status, questions or completion.
Claude and Codex transcripts are read only for the optional conversation view.

## What Herdr provides

| Bridge needs | From herdr-core |
| --- | --- |
| Panes, spaces, tabs | terminals with `herdr.space` / `herdr.tab` labels; names from the app's `where` label. Unlabelled workers and `machine/t7` terminals are hidden |
| Status and activity | the agent's own report (OSC 7501): `state` idle, working, done, blocked or error; `msg` (activity line), `progress`, `kind` (permission, question or auth when blocked) |
| Finished turns | `turn` goes up each time the status leaves working; `turn` events carry the state it left for |
| Seen on the desktop | the app's `herdr.seen` label (last turn the person viewed) |
| Who may receive input | the foreground process (`claude`, `codex`, `opencode`, `pi`, … decide agent input; a reported app name only labels the pane) |
| Prompt / keys / stop | `terminal.send` (paste and submit), `terminal.keys`, `terminal.interrupt` (agent-aware stop) |
| Live terminal | `terminal.attach` with `observe: true` (complete paint, then VT bytes) |
| New sessions | `terminal.run` with the agent command, `keep: true`; a new space uses `herdr-app do space.new` |

## Status and alerts

Snapshot panes carry `status`, `activity`, `progress`, `blockedKind` and `turn`.
A finished turn above `herdr.seen` is `done` (unseen); at or below it, `idle`
(seen on the desktop).

`core-events.js` keeps one `events.subscribe` connection. Every fact change
republishes the session list at once; a 5-second poll is the safety net (1 s
while events are down). Completion alerts use ordered `turn` events: a turn the
bridge saw end in done/idle alerts once, even if the next turn already started,
and is acknowledged when viewed in the Herdr app or from the phone. Turns learned
from a (re)subscription snapshot are a baseline: the bridge did not see them
finish, so they never alert. Alert state (event IDs, acknowledgements, the push
outbox) survives bridge restarts and core reconnects.

## Live terminal

`pane-stream.js` gives each watching phone its own observe attach, so its bytes
start with hc's complete paint and stay contiguous. hc grants output by KiB of
credit; the bridge replenishes it as bytes are consumed.

- An **epoch** is one contiguous byte sequence; `seq` is a byte offset in it.
- A resize (hc frame type 3, sent before every complete repaint), a client that
  falls more than 512 KiB behind, an expired cursor or a lost core starts a new
  epoch whose first bytes are a complete paint (`reset`).
- Bytes are kept until the phone acknowledges that it rendered them, so a lost
  response replays.

Phones long-poll `GET /v1/panes/:id/stream?attachmentId&epoch&seq&ack&wait=1`
(held up to 15 s; `seq` is what the phone has received, `ack` what xterm.js has
rendered). Direct phones may instead send `{type:'subscribe'|'ack'|'unsubscribe'}`
on their `/v1/events` WebSocket and receive `pane-output` frames.

Android renders the stream with a bundled, render-only xterm.js 6.0.0 in a
WebView. The page has no network access, and nothing listens for xterm.js input,
so the phone never answers terminal queries or sends mouse reports.

## Control and typed input

`POST /v1/panes/:id/control {attachmentId, takeover?}` starts a control session
bound to the device, this bridge process and the pane's occupant (process IDs
and start times). One device controls a pane at a time; another device needs
`takeover`, which revokes the first session. `DELETE /v1/panes/:id/control` ends it.

`POST /v1/panes/:id/stream-input {controlId, seq, data}` sends up to 4 KiB of raw
bytes (keys are encoded on the phone for the program's current keyboard mode).
Batches carry consecutive sequence numbers with a SHA-256 digest:

- the same batch again is acknowledged without typing it twice;
- a different batch for a used number, or a gap, stops the session;
- a write that may or may not have reached the program ends the session, and
  the person checks the screen before taking control again;
- device, permissions, remote access, the session and the occupant are checked
  again inside the pane lock, immediately before each write.

Typing into an agent needs control access; typing into any other program needs
the laptop's terminal grant (`allowTerminalInput` and a `terminal` device).
Input is written through a short attach at the terminal's own size, so the
desktop keeps its size (if the desktop resizes in the same instant, hc restores
it when the attach closes).

## Relay budget

The portal closes the laptop's relay socket for every phone above 2,400 messages
or 32 MiB per minute. The bridge holds at most three live-terminal polls (five
relay slots always stay for other requests) and counts the serialized,
encrypted size of every relayed response: live polls back off first, then
reads; actions keep a reserve. Live-terminal polls and input have their own
per-device limits, separate from ordinary requests.

## Read contract (hc 0.1.x)

Screen reads (`/output` and the bridge's internal reads) use an observe attach.
A read is complete only if exactly one paint frame arrives before the reply to a
barrier request, it starts with `CAN ESC[!p` and ends with `ESC[?9001l` plus only
OSC sequences, the terminal size is unchanged, and the rendered text equals hc's
`terminal.read {lines: 0}`. Otherwise it is marked truncated.
[`test/fixtures/hc-paint.json`](../bridge/test/fixtures/hc-paint.json) is a real
hc 0.1.17 paint; `discovery/herdr-core-schema.json` is the core's own schema,
checked by `test/schema.test.js`.

## Setup

The installer installs herdr-core with its official installer when it is
missing. Setup checks the core's `hello` (generation 1 and the methods above),
starts the core with `herdr-core server start` when it is not running, and never
creates, stops or changes a Herdr TUI session or its startup unit.

## Limits

- Agents that do not report status show as plain terminals; the live terminal
  still works.
- hc holds `terminal.keys` and `terminal.send` while someone typed in that
  terminal in the last ~3 s; program-driven changes during that wait are
  possible, and uncertain delivery is reported.
- Remote hc machines (`machine/t7`) are not shown.
- The iOS app (not published) still uses the text view and has no live terminal.
