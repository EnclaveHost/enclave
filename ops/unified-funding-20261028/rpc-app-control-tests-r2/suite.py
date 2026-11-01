import os,subprocess,unittest,sys
os.umask(0o077)
subprocess.run(['/usr/sbin/ip','link','set','lo','up'],check=True,timeout=2)
os.mkdir('/private/regress',0o700)
os.environ['RPC_TEST_PRIVATE']='/private/tests'
os.environ['RPC_TEST_ROOT']='/private/regress'
sys.path.insert(0,'/src/test/rpc-server')
suite=unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromName(n) for n in ['test_startup_export.Composition.test_app_control_is_bound_into_exact_prepared_contract'])
r=unittest.TextTestRunner(verbosity=2).run(suite)
raise SystemExit(0 if r.wasSuccessful() else 1)
