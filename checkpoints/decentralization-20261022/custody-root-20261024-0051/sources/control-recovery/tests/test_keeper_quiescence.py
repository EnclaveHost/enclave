import subprocess, unittest
import common

class KeeperQuiescence(unittest.TestCase):
    def test_only_confirmed_stopped_keeper_permits_activation(self):
        for state in ('inactive\n', 'failed\n'):
            common.require_keeper_stopped(run=lambda *a, **k: state)
        for state in ('active\n', 'activating\n', 'deactivating\n', '', 'unknown\n'):
            with self.assertRaises(AssertionError):
                common.require_keeper_stopped(run=lambda *a, **k: state)
    def test_unreadable_unit_does_not_permit_activation(self):
        def fail(*a, **k): raise subprocess.CalledProcessError(1, a[0])
        with self.assertRaises(subprocess.CalledProcessError): common.require_keeper_stopped(run=fail)
