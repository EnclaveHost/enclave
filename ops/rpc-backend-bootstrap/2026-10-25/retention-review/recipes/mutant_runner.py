#!/usr/bin/python3 -I
"""Runs test_chain_service.py against the mutant named by CHAIN_SERVICE_UNDER_TEST (copied over a private chain_service)."""
import os, shutil, subprocess, sys, tempfile
d = tempfile.mkdtemp(dir=os.environ['TEST_TMP'])
shutil.copyfile(os.environ['CHAIN_SERVICE_UNDER_TEST'], os.path.join(d, 'chain_service.py'))
shutil.copyfile('test_chain_service.py', os.path.join(d, 'test_chain_service.py'))
r = subprocess.run([sys.executable, '-I', 'test_chain_service.py'], cwd=d)
shutil.rmtree(d, ignore_errors=True)
sys.exit(r.returncode)
