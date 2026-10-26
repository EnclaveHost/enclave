"""Run the stage suites and write a structured receipt from unittest.TestResult itself (no log grepping).

usage: run_all.py RECEIPT_JSON LOG_TXT EXPECTED_TESTS   -> exit 0 only if testsRun == EXPECTED and every other count is 0."""
import json, sys, unittest

out, log, expected = sys.argv[1], sys.argv[2], int(sys.argv[3])
suite = unittest.defaultTestLoader.loadTestsFromNames(['test_anchored_origin', 'test_segments'])
with open(log, 'w') as stream:
    result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
counts = {'testsRun': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors), 'skipped': len(result.skipped),
          'expectedFailures': len(result.expectedFailures), 'unexpectedSuccesses': len(result.unexpectedSuccesses)}
bad = {t.id() for t, _ in result.failures + result.errors + result.skipped + result.expectedFailures} | {t.id() for t in result.unexpectedSuccesses}
ok = (result.wasSuccessful() and counts['testsRun'] == expected
      and all(counts[k] == 0 for k in ('failures', 'errors', 'skipped', 'expectedFailures', 'unexpectedSuccesses')))
doc = {'format': 'historical-origin-segments-test-receipt/v1', 'expectedTests': expected, 'counts': counts, 'pass': ok,
       'notPassed': sorted(bad), 'failureDetails': [[t.id(), tb[-2000:]] for t, tb in result.failures + result.errors]}
with open(out, 'x') as f:
    json.dump(doc, f, indent=1, sort_keys=True)
print(json.dumps({'pass': ok, **counts}))
sys.exit(0 if ok else 1)
