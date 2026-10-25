#!/usr/bin/env python3
"""Mutants of the patched sampler; each must be KILLED by the named new tests (run against the mutant)."""
import os, pathlib, shutil, subprocess, sys
HERE = pathlib.Path(__file__).resolve().parent
SRC = (HERE / 'patched' / 'readiness_sampler.py').read_text()
M = {
    'm1-generic-error-waiver': ("if e.rpc_code == PRUNED_CODE and m and m[1] == '0':\n                return 'pruned', int(m[2])",
                                "return 'pruned', int(m[2]) if m else 4000",
                                ['TestPrunedIdentity.test_other_rpc_errors_are_never_accepted']),
    'm2-no-in-gate-l1-pairing': ("el = self._paired('finalized', cl)\n", "el = self.el_block('el', hex(cl['number']))\n",
                                 ['TestPrunedIdentity.test_pruned_l1_el_not_serving_beacon_finalized_fails']),
    'm3-no-window-enforcement': ("    enforce_identity_basis(s.gates)\n", "",
                                 ['TestPrunedIdentity.test_pruned_identity_downgraded_when_pairing_later_fails',
                                  'TestPrunedIdentity.test_pruned_base_downgraded_when_l1_identity_fails']),
    'm4-no-base-derived-check': ("                if el[k] != f[k]:", "                if False:",
                                 ['TestPrunedIdentity.test_pruned_base_el_not_serving_derived_finalized_fails']),
    'm5-pruned-skips-cl-identity': ("        basis, earliest = self.genesis('el', EL_GENESIS)\n",
                                    "        basis, earliest = self.genesis('el', EL_GENESIS)\n"
                                    "        if basis == 'pruned':\n            return {'identity': {'basis': 'x', 'requires': []}}\n",
                                    ['TestPrunedIdentity.test_pruned_l1_still_requires_mainnet_identity']),
}
rc = 0
for name, (old, new, tests) in M.items():
    assert SRC.count(old) == 1, name
    d = HERE / 'tmp' / name
    shutil.rmtree(d, ignore_errors=True); d.mkdir(parents=True)
    (d / 'readiness_sampler.py').write_text(SRC.replace(old, new))
    shutil.copy(HERE / 'patched' / 'test_readiness_sampler.py', d)
    r = subprocess.run([sys.executable, '-m', 'unittest', *[f'test_readiness_sampler.{t}' for t in tests]],
                       cwd=d, capture_output=True, text=True, timeout=300)
    # an assertion failure only; a crash/import error (errors=) is not a meaningful kill
    killed = r.returncode != 0 and 'FAILED (failures=' in r.stderr and 'errors=' not in r.stderr
    print(f'{name}: {"KILLED" if killed else "SURVIVED"} (rc {r.returncode}; {r.stderr.strip().splitlines()[-1]})')
    rc |= not killed
sys.exit(rc)
