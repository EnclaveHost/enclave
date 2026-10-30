"""Run unittest modules and write a structured receipt from unittest.TestResult itself (no log grepping).

usage: run_all.py RECEIPT_JSON LOG_TXT EXPECTED|any MODULE [MODULE...]
exit 0 only if wasSuccessful, testsRun == EXPECTED (unless 'any') and failures/errors/skipped/expectedFailures/unexpectedSuccesses are 0.
The receipt always lists testsRun and the ids that did not pass, so a caller can also compare a run to a baseline run."""
import json, sys, unittest

out, log, expected, names = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
suite = unittest.defaultTestLoader.loadTestsFromNames(names)
with open(log, 'w') as stream:
    result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
counts = {'testsRun': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors), 'skipped': len(result.skipped),
          'expectedFailures': len(result.expectedFailures), 'unexpectedSuccesses': len(result.unexpectedSuccesses)}
bad = {t.id() for t, _ in result.failures + result.errors + result.skipped + result.expectedFailures} | {t.id() for t in result.unexpectedSuccesses}
ok = (result.wasSuccessful() and (expected == 'any' or counts['testsRun'] == int(expected))
      and all(counts[k] == 0 for k in ('failures', 'errors', 'skipped', 'expectedFailures', 'unexpectedSuccesses')))
doc = {'format': 'historical-origin-segments-test-receipt/v2', 'modules': names, 'expectedTests': expected, 'counts': counts, 'pass': ok,
       'notPassed': sorted(bad), 'failureDetails': [[t.id(), tb[-2000:]] for t, tb in result.failures + result.errors]}
with open(out, 'x') as f:
    json.dump(doc, f, indent=1, sort_keys=True)
print(json.dumps({'pass': ok, **counts}))
sys.exit(0 if ok else 1)
