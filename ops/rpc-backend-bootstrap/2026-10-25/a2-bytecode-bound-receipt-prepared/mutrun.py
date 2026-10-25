#!/usr/bin/env python3
"""Strict unittest driver for the a1-a2-integration mutant harness (no third-party deps).

  mutrun.py DIR all-pass OUT.json            run EVERY test of DIR/test/test_a2a4.py; exit 0 only if all pass
  mutrun.py DIR kill     OUT.json ID [ID..]  run ONLY the named tests (Class.test_name); exit 0 only if GENUINELY killed:
        every named test loaded and ran exactly once, every one FAILED through an assertion (unittest failureException,
        including failing subTests), zero errors (setUp/fixture/import/any non-assertion exception), zero skips, zero
        expected failures / unexpected successes. A passing named test -> "survived"; anything else -> "invalid".
Writes one JSON verdict (per-test outcome) to OUT.json and prints it. Import failure -> "invalid", exit 2."""
import importlib.util, io, json, pathlib, sys, unittest


class Strict(unittest.TextTestResult):
    def __init__(self, *a, **k):
        super().__init__(*a, **k); self.outcome = {}; self.started = {}

    def _id(self, test):
        return f'{type(test).__name__}.{test._testMethodName}' if hasattr(test, '_testMethodName') else f'<{test}>'   # class/module fixture errors

    def _mark(self, test, kind):
        i = self._id(test); prev = self.outcome.get(i)
        # error dominates fail dominates pass: one error anywhere in a test (incl. a subTest) makes it an error
        rank = {'pass': 0, 'fail': 1, 'skip': 2, 'xfail': 2, 'uxpass': 2, 'error': 3}
        if prev is None or rank[kind] > rank[prev]: self.outcome[i] = kind

    def startTest(self, test):
        super().startTest(test); i = self._id(test); self.started[i] = self.started.get(i, 0) + 1

    def addSuccess(self, test): super().addSuccess(test); self._mark(test, 'pass')
    def addFailure(self, test, err): super().addFailure(test, err); self._mark(test, 'fail')
    def addError(self, test, err): super().addError(test, err); self._mark(test, 'error')
    def addSkip(self, test, reason): super().addSkip(test, reason); self._mark(test, 'skip')
    def addExpectedFailure(self, test, err): super().addExpectedFailure(test, err); self._mark(test, 'xfail')
    def addUnexpectedSuccess(self, test): super().addUnexpectedSuccess(test); self._mark(test, 'uxpass')

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        if err is not None:
            self._mark(test, 'fail' if issubclass(err[0], test.failureException) else 'error')


def main(argv):
    d, mode, out, ids = pathlib.Path(argv[1]).resolve(), argv[2], argv[3], argv[4:]
    v = {'mode': mode, 'requested': ids}
    try:
        sys.path.insert(0, str(d / 'test'))
        spec = importlib.util.spec_from_file_location('test_a2a4', d / 'test/test_a2a4.py')
        mod = importlib.util.module_from_spec(spec); sys.modules['test_a2a4'] = mod; spec.loader.exec_module(mod)
        loader = unittest.TestLoader()
        if mode == 'all-pass' and not ids:
            suite = loader.loadTestsFromModule(mod)
        elif mode == 'kill' and ids and len(set(ids)) == len(ids):
            suite = unittest.TestSuite(loader.loadTestsFromName(i, mod) for i in ids)
        else:
            raise ValueError('usage: all-pass takes no ids; kill takes >= 1 unique ids')
    except BaseException as e:                       # a load/fixture/import failure is NEVER a kill
        v.update(verdict='invalid', error=f'{type(e).__name__}: {e}'[:500])
        pathlib.Path(out).write_text(json.dumps(v, indent=1)); print(json.dumps(v)); return 2
    log = io.StringIO()
    r = unittest.TextTestRunner(stream=log, verbosity=2, resultclass=Strict).run(suite)
    sys.stderr.write(log.getvalue())
    names = sorted(r.started)
    v.update(testsRun=r.testsRun, outcomes=r.outcome, ranTwice=[i for i, n in r.started.items() if n != 1],
             errors=len(r.errors), skipped=len(r.skipped), expectedFailures=len(r.expectedFailures), unexpectedSuccesses=len(r.unexpectedSuccesses))
    clean = not v['ranTwice'] and not r.errors and not r.skipped and not r.expectedFailures and not r.unexpectedSuccesses
    if mode == 'all-pass':
        v['ran'] = names
        ok = clean and r.testsRun > 0 and r.testsRun == len(names) and all(o == 'pass' for o in r.outcome.values()) and len(r.outcome) == len(names)
        v['verdict'] = 'baseline-clean' if ok else 'baseline-NOT-clean'
    else:
        if not clean or names != sorted(ids) or r.testsRun != len(ids) or set(r.outcome) != set(ids) or any(o not in ('pass', 'fail') for o in r.outcome.values()):
            v['verdict'] = 'invalid'
        elif all(r.outcome[i] == 'fail' for i in ids):
            v['verdict'] = 'killed'
        else:
            v['verdict'] = 'survived'; v['passed'] = [i for i in ids if r.outcome[i] == 'pass']
        ok = v['verdict'] == 'killed'
    pathlib.Path(out).write_text(json.dumps(v, indent=1, sort_keys=True)); print(json.dumps({k: v[k] for k in ('mode', 'verdict', 'testsRun')}))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
