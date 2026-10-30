"""Prepared offline harness; execute only after frozen delivery/root admission."""
import importlib
import json
import pathlib
import sys
import unittest

stage = pathlib.Path(sys.argv[1]).resolve(strict=True)
result_path = pathlib.Path(sys.argv[2])
sys.path.insert(0, str(stage))
original = importlib.import_module('test_root_maintenance')
# These are exact captured metadata bytes, never a live launcher invocation.
original.M.DEFAULT_CFG = dict(original.M.DEFAULT_CFG,
    launcher=str(stage / 'fixture-launcher.py'),
    manifest=str(stage / 'fixture-manifest.json'))
loader = unittest.TestLoader()
suite = unittest.TestSuite()
modules = ['test_root_maintenance', 'test_root_transport_regressions']
modules += [p.stem for p in sorted(stage.glob('test_*.py'))
            if p.stem not in modules]
for name in modules:
    suite.addTests(loader.loadTestsFromModule(importlib.import_module(name)))
if loader.errors:
    raise RuntimeError('Test discovery failed: ' + repr(loader.errors))
result = unittest.TextTestRunner(verbosity=2).run(suite)
record = dict(tests=result.testsRun, failures=len(result.failures),
              errors=len(result.errors), skipped=len(result.skipped),
              expectedFailures=len(result.expectedFailures),
              unexpectedSuccesses=len(result.unexpectedSuccesses), modules=modules)
with result_path.open('x') as f:
    json.dump(record, f, indent=2)
    f.write('\n')
sys.exit(0 if result.wasSuccessful() and not result.skipped else 1)
