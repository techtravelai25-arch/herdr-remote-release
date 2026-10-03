# Set up your laptop

Use Linux, Node.js 22+, Python 3, Herdr 0.9.0 (protocol22), and optionally cloudflared. Install Herdr from its official upstream instructions and authenticate your coding agents locally. Start a normal Herdr session first.

Download the source from this repository or clone it with Git, then enter the checkout:

```sh
git clone https://github.com/techtravelai25-arch/herdr-remote-release.git
cd herdr-remote-release
npm ci --prefix bridge
python3 ops/setup.py --output /tmp/herdr-remote-setup
```

Inspect the generated config, launcher, and systemd user units. The generator detects executable paths. Override them with `--node`, `--herdr`, or `--cloudflared`; set `--socket` if your Herdr socket is not `~/.config/herdr/herdr.sock`.

When satisfied, install the same configuration:

```sh
python3 ops/setup.py --install
systemctl --user daemon-reload
systemctl --user enable --now herdr-remote-bridge
```

The generator refuses to overwrite existing files and does not start, stop, or enable services itself. It writes configuration under `$XDG_CONFIG_HOME/herdr-remote` (normally `~/.config/herdr-remote`), a launcher in `~/.local/bin`, and systemd user units. Ensure `~/.local/bin` is on PATH. Moving the checkout requires updating the generated units and launcher.

## HTTPS and pairing

With cloudflared installed when generating units, run:

```sh
herdr-remote pair
```

The command starts the configured bridge/tunnel units if needed, checks reachability, and prints a short-lived single-use QR code. Scan it using the Android app. A temporary tunnel is useful for trying the app, but its hostname can change; use a managed tunnel or your own HTTPS reverse proxy for a stable connection.

For your own HTTPS route, forward it to `http://127.0.0.1:8787`, set `publicUrl` in your local configuration, and pair again. Keep the bridge bound to loopback. The bridge API uses device credentials; a browser-only authentication page in front of it will prevent native QR pairing. Optional email login through the portal uses a separate flow.

Do not publish pairing QR images or codes. To list or revoke phones:

```sh
herdr-remote devices
herdr-remote revoke DEVICE_ID
```

## Working directories and permissions

Browse selects any existing folder within the bridge user's Home directory, including Home itself. Symlinks escaping Home are rejected. Recent stores twelve successfully used Home folders. To allow a project outside Home, add an explicit `id`, `label`, and absolute `path` to local `projects` configuration.

`allowTerminalInput` and `allowHerdrStart` default to false. The latter permits the app to start the generated Herdr service and must only be enabled if its socket/session agrees with your configuration. Starting a new agent runs the fixed supported agent executable; Home browsing does not confine the agent's OS permissions.

## Upgrade and uninstall

Stop the bridge, update the checkout, run `npm ci --prefix bridge`, then restart it. Keep local configuration and state outside Git. Review release notes for protocol changes. Android updates must use the same application ID and signing certificate.

To uninstall, stop and disable only the Herdr Remote bridge/tunnel user services you installed; remove their generated units and launcher and run `systemctl --user daemon-reload`. Remove `~/.config/herdr-remote` only if you want to discard pairing credentials and receipts. Herdr and its workspaces are separate; do not stop or delete them merely to remove the bridge.
