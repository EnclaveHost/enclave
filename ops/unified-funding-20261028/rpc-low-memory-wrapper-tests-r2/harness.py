import json,sys,unittest
from pathlib import Path
import test_chain_service as legacy
legacy.c.MANIFEST['binaries'].update(json.loads(Path('PROFILE.json').read_text())['exactPayloadBinaryHashes'])
suite=unittest.defaultTestLoader.discover('.',pattern='test_*.py')
r=unittest.TextTestRunner(verbosity=2).run(suite)
Path(sys.argv[1]).write_text(json.dumps({'tests':r.testsRun,'failures':len(r.failures),'errors':len(r.errors),'skips':len(r.skipped),'success':r.wasSuccessful()})+'\n')
raise SystemExit(0 if r.wasSuccessful() else 1)
