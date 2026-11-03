# Herdr desktop app backend

The bridge shows and controls sessions from two Herdr backends at the same time:

- the Herdr **TUI** (`herdr server`, socket `~/.config/herdr/herdr.sock`, protocol 22), and
- the Herdr **desktop app** (`herdr-app`). Its terminals run in **herdr-core** (`hc`,
  socket `$XDG_RUNTIME_DIR/herdr-core/default.sock`, or `coreSocketPath` in the config).

```text
phone ──▶ bridge routes ──▶ herdr-mux ──┬──▶ Herdr (TUI socket, protocol 22)
                                        └──▶ HerdrCore (hc socket) ──▶ app terminals
```

[`herdr-mux.js`](../bridge/src/herdr-mux.js) merges both snapshots and routes every
other call by ID. [`herdr-core.js`](../bridge/src/herdr-core.js) answers the protocol-22
methods the bridge uses, in protocol-22 shapes, from hc's JSON-RPC API. The rest of the
bridge is unchanged.

## Mapping

| Bridge concept | Desktop app (hc) |
| --- | --- |
| pane `hc:t7` | hc terminal `t7` with a `herdr.space` label (unlabelled workers and `machine/t7` are hidden) |
| workspace / tab `hc:<id>` | labels `herdr.space` / `herdr.tab`; names from the app's `where` label |
| `terminal_id` | core id, address, shell PID + start time, agent PID + start time |
| agent kind / status | foreground process name (`claude`, `codex`, `opencode`), else hc `status.app` while a child is in front; hc state, `error` → `unknown` |
| `pane.read` | one observe-only attach (never types or resizes), rendered with `@xterm/headless` |
| `pane.send_text`, `pane.send_input` text | raw UTF-8 through a short non-observe attach at the terminal's current size; `\n` → Enter |
| `pane.send_keys` | `terminal.keys` |
| `agent.prompt` | `terminal.send` (paste and submit) |
| new session / restart | `terminal.run` with the agent command and `keep` (atomic; never typed into a shell); a new space uses `herdr-app do space.new` and needs the app window |
| rename / focus / close | label `herdr-remote.title` / `herdr-app do pane.focus` / `terminal.kill` + `terminal.rm` |

## Read contract (hc 0.1.x)

A read that can authorize input is complete only if all of these hold; otherwise it
is returned with `truncated: true` and the question and model flows refuse to act:

1. After the attach reply, a `server.status` RPC on the same connection acts as a
   barrier. Exactly one data frame arrives before its reply.
2. That frame starts with `CAN ESC[!p` and, after every cell and the cursor, contains
   `ESC[?9001l` followed only by OSC sequences (title, `7501` status).
3. The rendered screen equals hc's own `terminal.read {lines: 0}` text, and the
   terminal size is the same before and after.

[`test/fixtures/hc-paint.json`](../bridge/test/fixtures/hc-paint.json) is a real hc
0.1.17 paint. If an hc update changes the format, reads fail closed and
`test/herdr-core.test.js` shows which check failed.

## Outages

A backend that fails after it had panes keeps its last panes as **stale** until it
answers again: they are republished unchanged, `panesComplete` is false, and push,
timeline and activity tracking do not see them, so nothing is pruned or notified.
A backend that never had panes (for example an unused TUI) adds nothing. If both
backends fail, the bridge reports the usual Herdr outage.

## Known limits

- hc holds `terminal.keys` and `terminal.send` while someone typed in that terminal in
  the last ~3 s, including the bridge's own raw text. Text followed by a key therefore
  takes about 3 s longer. Program-driven dialog changes during that wait are possible;
  the question flows re-read after each write and report uncertain delivery.
- Raw text needs a non-observe attach. If the pane is resized on the desktop in the
  milliseconds between the size check and the attach, it briefly takes the old size;
  hc restores it when the attach closes. The owner accepted this on 2026-11-03.
- Status changes of app panes arrive through the 1 s poll, not native events.
- Remote hc machines (`machine/t7`), and companion setup without the TUI, are not
  supported yet.
