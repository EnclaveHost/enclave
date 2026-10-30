#!/usr/bin/env python3
"""finality r6.2 isolated tests (PREPARED; NOT run by Claude: jobs/root-finality-r62-tests.sh, exact count 2). Run inside the private
recovery-r7 copy with the r6.2 harness (imports the ported recovery suite for its harness module R only)."""
import json, os, pathlib, sys, tempfile, unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, os.environ['FINALITY_SRC'])
import test_reanchor_recovery as RR                      # the r6.2 harness as R (classes not re-exported)
import finality_state as FS
R = RR.R; FS.OWNER = os.getuid()


class Followups(unittest.TestCase):
    def test_reth_child_environment_is_clean(self):
        """the REAL harness Base.run: a `base reth` child sees PATH/LANG/HOME only (production allowlist empty)"""
        t = pathlib.Path(tempfile.mkdtemp()); self.addCleanup(__import__('shutil').rmtree, t, True)
        out = t / 'env.json'; fake = t / 'fake-base'
        fake.write_text(f'#!/usr/bin/env python3\nimport json, os\nopen({str(out)!r}, "w").write(json.dumps(dict(os.environ)))\n'); fake.chmod(0o755)
        (t / 'w').mkdir(mode=0o700)
        dirty = {'LD_PRELOAD': '/nonexistent/x.so', 'RUST_LOG': 'trace', 'BASE_CHAIN': 'base', 'NODE_OPTIONS': '--import=/x.mjs', 'FAKE_STATE': 'x'}
        with patch.dict(os.environ, dirty), patch.object(R, 'RETH_ENV_PASS', ()):
            R.Base({'baseBinary': str(fake), 'workdir': str(t / 'w'), 'timeouts': {}}, []).run('--version', cls='help')
        env = json.loads(out.read_text())
        self.assertEqual(set(env) - {'PWD', 'SHLVL', '_', 'LC_CTYPE'}, {'PATH', 'LANG', 'HOME'})
        self.assertEqual(env['PATH'], '/usr/bin:/bin')

    def test_node_acceptance_refusal_keeps_the_harness_code_and_opens_nothing(self):
        """finality_state.node_fd with the capture module on HOLD: FS.Refused('a1_capture_pending'), no fd opened"""
        fds = set(os.listdir('/proc/self/fd'))
        with patch.object(R, 'A1_CAPTURE_REVIEWED', False), self.assertRaises(FS.Refused) as cm:
            FS.node_fd(R, os.path.realpath(sys.executable))
        self.assertEqual(cm.exception.code, 'a1_capture_pending')
        self.assertEqual(set(os.listdir('/proc/self/fd')) - fds, set(), 'a file descriptor leaked')


if __name__ == '__main__':
    unittest.main()
