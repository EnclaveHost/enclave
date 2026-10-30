import sys,time,unittest,os,importlib.util
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'historical-origin-segments-stage/r2/tests'))
import test_segments as t
if os.environ.get('ROOT_FIXED_OVERLAY') == '1':
    spec=importlib.util.spec_from_file_location('root_fixed',Path(__file__).with_name('anchored_acceptance_fixed.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);t.AA=module
class FreshnessRegression(t.SegTest):
    def test_activation_rechecks_evidence_against_current_time(self):
        self.setup_chain()
        dirs,aggregate=self.covered()
        args=self.acceptance_dir(dirs,aggregate)
        self.activate(*args)
        with patch('time.time',return_value=aggregate['evaluatedAt']+t.SG.MAX_EVIDENCE_AGE+61):
            with self.assertRaises((AssertionError,t.SG.Refused)):
                self.activate(*args)
    def test_future_aggregate_evaluation_is_rejected(self):
        self.setup_chain()
        dirs,aggregate=self.covered()
        future=aggregate['evaluatedAt']+120
        forged=dict(aggregate,evaluatedAt=future)
        with self.assertRaises((AssertionError,t.SG.Refused)):
            self.activate(*self.acceptance_dir(dirs,forged))
if __name__=='__main__':
    suite=unittest.TestSuite([FreshnessRegression(n) for n in ['test_activation_rechecks_evidence_against_current_time','test_future_aggregate_evaluation_is_rejected']])
    if os.environ.get('ROOT_FULL_SUITE') == '1':
        import test_anchored_origin as origin_tests
        suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(t))
        suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(origin_tests))
        assert suite.countTestCases()==27
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    assert not result.skipped and not result.expectedFailures and not result.unexpectedSuccesses
    sys.exit(0 if result.wasSuccessful() else 1)
