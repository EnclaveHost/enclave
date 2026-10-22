#!/usr/bin/env python3
"""mutants.py - sensitivity of test_policy_regeneration.py: each mutant MUST make the named test FAIL (exit 1 if any survives)."""
import io, pathlib, shutil, sys, tempfile, unittest
sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent; sys.path.insert(0, str(HERE)); import test_policy_regeneration as t
SRC = t.MERGED.read_text(); POL = 'set ENCLAVE_PLATFORM_HOST_POLICY=production\n'; CALL = 'if exist "$PD\\node-config.local.cmd" call "$PD\\node-config.local.cmd"\n'
assert SRC.count(POL) == 1 and SRC.count(CALL) == 1
def inst(text):
    d = pathlib.Path(tempfile.mkdtemp(prefix='ipc-mut-')); p = d / 'install-host.ps1'; p.write_text(text); return p
MUT = {   # name -> (installer text or None, rc patch or None, test)
    'policy line after the hook call': (SRC.replace(POL, '').replace(CALL, CALL + POL), None, 'test_migrate_then_rc_then_merged_regeneration_keeps_six_and_rc_three'),
    'policy line dropped (= r6)':       (SRC.replace(POL, ''), None, 'test_control_r6_alone_leaves_the_gate_off_merged_alone_sets_production_only'),
    'hook call dropped':                (SRC.replace(CALL, ''), None, 'test_migrate_then_rc_then_merged_regeneration_keeps_six_and_rc_three'),
    # (the guard's call site + refusal flow are exercised by regress_r6.py guard; tp.guard evaluates its two functions)
    'guard reports nothing':            (SRC.replace('{ $out += "$($pair[0]):$($s.name)" }', '{ }'), None, 'test_pre_fixture_is_the_live_shape'),
    'policy line forced off after hook':(SRC.replace(CALL, CALL + 'set ENCLAVE_PLATFORM_HOST_POLICY=off\n'), None, 'test_migrate_then_rc_then_merged_regeneration_keeps_six_and_rc_three'),
    'RC append is a no-op':             (None, lambda s: s.replace('[IO.File]::WriteAllBytes($LOCAL, $prepared);', ''), 'test_migrate_then_rc_then_merged_regeneration_keeps_six_and_rc_three'),
}
survived = []
orig_merged, orig_r6, orig_driver = t.MERGED, t.tp.R6, t.RC_DRIVER
for name, (text, rcp, test) in MUT.items():
    p = inst(text) if text is not None else orig_merged
    if text is not None: assert text != SRC, name
    t.MERGED = p; t.tp.R6 = p; t.RC_DRIVER = rcp(orig_driver) if rcp else orig_driver
    if rcp: assert t.RC_DRIVER != orig_driver, name
    r = unittest.TextTestRunner(stream=io.StringIO(), verbosity=0).run(unittest.defaultTestLoader.loadTestsFromName(test, t.PolicyRegeneration))
    killed = not r.wasSuccessful(); print('KILLED' if killed else 'SURVIVED', name, '->', test, flush=True)
    if not killed: survived.append(name)
    if text is not None: shutil.rmtree(p.parent, ignore_errors=True)
    t.MERGED, t.tp.R6, t.RC_DRIVER = orig_merged, orig_r6, orig_driver
print('MUTANTS', 'ALL KILLED' if not survived else f'SURVIVED {survived}'); sys.exit(1 if survived else 0)
