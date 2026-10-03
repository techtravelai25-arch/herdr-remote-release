#!/usr/bin/env python3
"""Generate portable Linux configuration; never start or restart services."""
import argparse
import json
import os
from pathlib import Path
import shlex
import shutil

parser = argparse.ArgumentParser(description=__doc__)
mode = parser.add_mutually_exclusive_group(required=True)
mode.add_argument('--output', type=Path, help='render files into a directory for review')
mode.add_argument('--install', action='store_true', help='install user config, launcher and units; does not enable/start them')
parser.add_argument('--node', default=shutil.which('node'))
parser.add_argument('--herdr', default=shutil.which('herdr'))
parser.add_argument('--cloudflared', default=shutil.which('cloudflared'))
parser.add_argument('--socket', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
home = Path.home()
config_home = Path(os.environ.get('XDG_CONFIG_HOME', home / '.config')).resolve()
config = config_home / 'herdr-remote/config.json'

def binary(value, name):
    if not value:
        parser.error(f'{name} missing from PATH; pass --{name} /absolute/path')
    p = Path(value)
    if not p.is_absolute() or not p.is_file() or not os.access(p, os.X_OK):
        parser.error(f'{name} must name an executable absolute path')
    return str(p.resolve())

node = binary(args.node, 'node')
herdr = binary(args.herdr, 'herdr')
cloudflared = binary(args.cloudflared, 'cloudflared') if args.cloudflared else None

def unitquote(value, executable=False):
    value = str(value)
    if any(c in value for c in '\n\r\x00'):
        parser.error('newlines and NUL are unsupported in paths')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$' if executable else '$') + '"'

def unit(description, command, working, environment=(), restart='on-failure'):
    env = ''.join('Environment=' + unitquote(item) + '\n' for item in environment)
    return f'[Unit]\nDescription={description}\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory={unitquote(working)}\nExecStart={" ".join(unitquote(v, executable=True) for v in command)}\n{env}Restart={restart}\nRestartSec=3\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n'

socket = args.socket or home / '.config/herdr/herdr.sock'
if not socket.is_absolute():
    parser.error('--socket must be absolute')
data = {'port':8787, 'publicUrl':'', 'socketPath':str(socket), 'stateDir':str(config.parent / 'state'), 'projects':[], 'allowTerminalInput':False, 'allowHerdrStart':False}
launcher = '#!/bin/sh\nexport HERDR_REMOTE_CONFIG=' + shlex.quote(str(config)) + '\nexec ' + shlex.quote(node) + ' ' + shlex.quote(str(root / 'bridge/src/cli.js')) + ' "$@"\n'
files = {
    config: json.dumps(data, indent=2) + '\n',
    home / '.local/bin/herdr-remote': launcher,
    config_home / 'systemd/user/herdr-remote-bridge.service': unit('Herdr Remote bridge', [node, root / 'bridge/src/cli.js', 'serve'], root / 'bridge', ['HERDR_REMOTE_CONFIG=' + str(config)]),
    config_home / 'systemd/user/herdr-remote-herdr.service': unit('Herdr session started by Herdr Remote', [herdr, 'server'], home, ['PATH=' + os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin')], 'no'),
}
if cloudflared:
    files[config_home / 'systemd/user/herdr-remote-quick-tunnel.service'] = unit('Herdr Remote temporary development tunnel', [cloudflared, 'tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:8787'], home)
if args.output:
    files = {args.output / p.name: content for p, content in files.items()}
for p in files:
    if p.exists() or p.is_symlink():
        parser.error(f'refusing to overwrite {p}; review existing configuration first')
for p, content in files.items():
    p.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o700 if p.name == 'herdr-remote' else 0o600)
    with os.fdopen(fd, 'w') as handle:
        handle.write(content)
    print(p)
print('Generated only. No service was started, stopped, enabled or reloaded.')
if args.install:
    print('Next: npm ci --prefix bridge; systemctl --user daemon-reload; systemctl --user enable --now herdr-remote-bridge')
    if not cloudflared:
        print('No quick tunnel unit: install cloudflared or configure your own HTTPS tunnel/publicUrl.')
