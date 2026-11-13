"""rpc/snp/kvm_check.py: the verdict over the lines a guest prints about itself. The fixture is image r14's own
run under plain KVM (2026-11-13, root hash d0b6040a…1a58).

python3 -m unittest test/rpc-snp/test_kvm_check.py
"""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'rpc/snp'))
import kvm_check as K  # noqa: E402

LOG = (ROOT/'test/fixtures/rpc-snp/r14-check.txt').read_text()
FLOOD = 'each journal stays within its cap after more text than it holds'


class VerdictTest(unittest.TestCase):
    def failing(self, old=None, new=None):
        self.assertTrue(old is None or LOG.count(old) == 1, old)
        return [c for c, ok, _ in K.verdict(K.facts(LOG if old is None else LOG.replace(old, new)))if not ok]

    def test_the_recorded_run_holds(self):
        self.assertEqual(self.failing(), [])
        self.assertEqual(len(K.verdict(K.facts(LOG))), 10)

    def test_lines_become_facts_wherever_the_console_put_them(self):
        f = K.facts('[  12.3] sh[1]: QUAL unit a.service masked inactive\nnoise\nQUAL unit b.timer enabled active\nQUAL end\n')
        self.assertEqual(f, {'unit': [['a.service', 'masked', 'inactive'], ['b.timer', 'enabled', 'active']], 'end': [[]]})

    def test_a_flood_journald_dropped_proves_nothing_about_the_cap(self):
        # the first run of this check: journald's burst limit kept 27,500 of 2,000,000 lines and every journal was small
        self.assertEqual(self.failing('QUAL flood-suppressed base=0 main=0', 'QUAL flood-suppressed base=1 main=0'), [FLOOD])
        self.assertEqual(self.failing('4.base 259\n', '4.base 16\n'), [FLOOD])

    def test_a_journal_over_its_cap_or_one_that_kept_everything_fails(self):
        self.assertEqual(self.failing('4.base 259\n', '4.base 380\n'), [FLOOD])
        self.assertEqual(self.failing('QUAL journal-lines-kept base=427961', 'QUAL journal-lines-kept base=2000000'), [FLOOD])

    def test_a_stock_unit_left_enabled_or_not_looked_at_fails(self):
        masks = 'every stock unit the image masks is masked and not running'
        self.assertEqual(self.failing('QUAL unit rsyslog.service masked inactive', 'QUAL unit rsyslog.service enabled active'), [masks])
        self.assertEqual(self.failing('QUAL unit snapd.service masked inactive\n', ''), [masks])

    def test_a_syslog_file_that_grows_fails(self):
        self.assertEqual(self.failing('QUAL syslog-file-after-flood 188502', 'QUAL syslog-file-after-flood 400188502'), ['no syslog file grows'])
        self.assertEqual(self.failing('QUAL journald-conf ForwardToSyslog=no\n', ''), ['the journal is capped and not copied to syslog'])

    def test_base_lines_in_the_default_journal_fail(self):
        self.assertEqual(self.failing('QUAL ns-default-sees-base 0', 'QUAL ns-default-sees-base 2'),
                         ['the Base unit logs to its own journal and the front reads it'])

    def test_limits_in_bytes_and_a_limit_the_probe_moved_fail(self):
        shares, probe = 'the limits are shares of the memory the guest was given', 'the probe asked the loaded slice and set no limit'
        self.assertEqual(self.failing('high=7493263360 max=7826296832 reclaim=present', 'high=62277025792 max=64424509440 reclaim=present'),
                         [shares, probe])
        self.assertEqual(self.failing('QUAL slice-probed current=1689198592 high=7493263360', 'QUAL slice-probed current=1689198592 high=1689198592'), [probe])
        self.assertEqual(self.failing('QUAL probe-after measuring 4 2 ', 'QUAL probe-after waiting 0 0 '), [probe])

    def test_a_failed_unit_fails(self):
        self.assertEqual([c for c, ok, _ in K.verdict(K.facts(LOG + 'QUAL failed multipathd.socket\n')) if not ok], ['no unit failed'])


if __name__ == '__main__':
    unittest.main()
