#!/usr/bin/env python3
"""No live services: exercise generation under an isolated temporary HOME."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

class SetupTests(unittest.TestCase):
    def test_safe_paths_and_existing_install(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            root = base / 'checkout spaces $dollar %percent "quote'
            (root / 'ops').mkdir(parents=True)
            (root / 'ops/setup.py').write_text(Path(__file__).with_name('setup.py').read_text())
            home = base / 'home spaces $dollar %percent'
            home.mkdir()
            binary = base / 'bin spaces $dollar %percent'
            binary.write_text('#!/bin/sh\nprintf "%s\\n" "$HERDR_REMOTE_CONFIG" "$@"\n')
            binary.chmod(0o700)
            env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home / '.config'))
            command = ['python3', str(root / 'ops/setup.py'), '--install', '--node', str(binary), '--herdr', str(binary)]
            result = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            config = home / '.config/herdr-remote/config.json'
            self.assertEqual(json.loads(config.read_text())['socketPath'], str(home / '.config/herdr/herdr.sock'))
            unit = (home / '.config/systemd/user/herdr-remote-bridge.service').read_text()
            self.assertIn('WorkingDirectory="' + str(root).replace('%', '%%').replace('"','\\"') + '/bridge"', unit)
            self.assertIn('bin spaces $$dollar %%percent', unit)
            self.assertIn('Environment="HERDR_REMOTE_CONFIG=' + str(config).replace('%','%%') + '"', unit)
            launched = subprocess.run([str(home / '.local/bin/herdr-remote'), 'argument $() with spaces'], capture_output=True, text=True)
            self.assertEqual(launched.stdout.splitlines(), [str(config), str(root / 'bridge/src/cli.js'), 'argument $() with spaces'])
            again = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertNotEqual(again.returncode, 0)
            self.assertIn('refusing to overwrite', again.stderr)

if __name__ == '__main__':
    unittest.main()
