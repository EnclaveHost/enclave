"""Real inert local children: failure output survives process-group cleanup."""
from pathlib import Path
import sys
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'rpc'))
import deliver_activation as d


class TransportFailure(unittest.TestCase):
    def test_nonzero_preserves_exact_binary_output_without_printing(self):
        code = 'import os;os.write(1,b"\\xffcontroller");os.write(2,b"private\\x00error");raise SystemExit(7)'
        with self.assertRaises(d.ExchangeFailure) as caught:
            d.exchange([sys.executable, '-I', '-c', code], b'', 2)
        error = caught.exception
        self.assertEqual(error.returncode, 7)
        self.assertEqual(error.stdout, b'\xffcontroller')
        self.assertEqual(error.stderr, b'private\x00error')
        self.assertNotIn('private', str(error))

    def test_timeout_retains_partial_output_without_remote_death_claim(self):
        code = 'import os,time;os.write(1,b"partial");time.sleep(10)'
        start = time.monotonic()
        with self.assertRaises(d.ExchangeFailure) as caught:
            d.exchange([sys.executable, '-I', '-c', code], b'', .3)
        self.assertEqual(caught.exception.reason, 'transport-timeout')
        self.assertEqual(caught.exception.stdout, b'partial')
        self.assertLess(time.monotonic() - start, 2)

    def test_output_flood_still_refused(self):
        with self.assertRaisesRegex(ValueError, 'SSH output bound'):
            d.exchange([sys.executable, '-I', '-c', 'import os;os.write(2,b"x"*100000)'], b'', 2)


if __name__ == '__main__': unittest.main(verbosity=2)
