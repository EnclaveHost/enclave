"""rpc/snp/memtrend.py: rates between two /memory reports, and none across a restart.

python3 -m unittest test/rpc-snp/test_memtrend.py
"""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'rpc/snp'))
import memtrend as M  # noqa: E402

GIB = 1 << 30


def report(at, anon, steal, refault):
    stat = {'anon': anon, 'file': 30*GIB, 'pgsteal': steal, 'workingset_refault_file': refault}
    return {'at': at, 'meminfo': {'MemTotal': 62*GIB}, 'trees': {'/var/log': 100 << 20},
            'groups': {g: {'current': 50*GIB, 'stat': dict(stat)} for g in M.GROUPS}}


class TrendTest(unittest.TestCase):
    def test_rates_are_bytes_a_second_since_the_report_before(self):
        a, b = M.rows([report(1100, 12*GIB, 3000, 400), report(1000, 10*GIB, 1000, 300)])     # any order in
        self.assertEqual((a['at'], a['steal']['base'], a['refault']['base']), (1000, None, None))
        self.assertEqual(b['steal']['base'], 2000 * 4096 / 100)
        self.assertEqual(b['refault']['el'], 100 * 4096 / 100)
        self.assertEqual((b['anon']['clients'], b['file']['base'], b['logs']), (12*GIB, 30*GIB, 100 << 20))

    def test_block_age_comes_from_the_health_answer_beside_a_report(self):
        with_health = {**report(1000, GIB, 0, 0), 'health': {'l1': {'head': 1, 'headTimestamp': 988}, 'base': {'headTimestamp': 999},
                                                               'beacon': {'sync_distance': '0'}}}
        a, b = M.rows([with_health, report(1100, GIB, 0, 0)])
        self.assertEqual((a['behind'], b['behind']), ({'l1': 12, 'base': 1}, {}))

    def test_a_restart_gives_no_rate(self):
        _, b = M.rows([report(1000, 10*GIB, 5000, 900), report(1100, 2*GIB, 40, 0)])
        self.assertEqual((b['steal']['cl'], b['refault']['cl']), (None, None))

    def test_growth_needs_an_hour_and_looks_at_the_last_hours_only(self):
        t = [(0, 1*GIB), (20*3600, 10*GIB), (23*3600, 13*GIB), (24*3600, 13*GIB)]
        self.assertAlmostEqual(M.growth(t, hours=6), 3 / 4)
        self.assertAlmostEqual(M.growth(t, hours=24), 12 / 24)
        self.assertIsNone(M.growth(t[:1]))
        self.assertIsNone(M.growth([(0, GIB), (600, 2*GIB)]))
        self.assertIsNone(M.growth([]))

    def test_the_boot_is_the_probes_start_or_the_last_time_the_counters_went_back(self):
        reports = [report(1000, GIB, 5000, 0), report(2000, GIB, 6000, 0), report(9000, GIB, 100, 0), report(9500, GIB, 200, 0)]
        self.assertEqual(M.boot(reports, M.rows(reports)), 9000)
        self.assertEqual(M.boot(reports[:2], M.rows(reports[:2])), 1000)
        reports[-1]['probe'] = {'startedAt': 8000, 'samples': []}
        self.assertEqual(M.boot(reports, M.rows(reports)), 8000)

    def test_the_probes_samples_start_when_the_clients_do(self):
        r = {**report(5000, GIB, 0, 0), 'probe': {'samples': [[1000, 0, 0, 0, 0.0], [2800, 50*GIB, 9*GIB, 40*GIB, 0.2]]}}
        self.assertEqual(M.samples(r), [(2800, 9*GIB, 40*GIB)])
        self.assertEqual(M.samples(report(5000, GIB, 0, 0)), [])
        self.assertEqual(M.samples({**report(5000, GIB, 0, 0), 'probe': None}), [])


if __name__ == '__main__':
    unittest.main()
