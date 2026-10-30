import json,sys,unittest
from pathlib import Path
suite=unittest.defaultTestLoader.discover('.',pattern='test_*.py')
r=unittest.TextTestRunner(verbosity=2).run(suite)
Path(sys.argv[1]).write_text(json.dumps({'tests':r.testsRun,'failures':len(r.failures),'errors':len(r.errors),'skips':len(r.skipped),'success':r.wasSuccessful()})+'\n')
raise SystemExit(0 if r.wasSuccessful() else 1)
