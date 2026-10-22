#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/challenge-host-tls-20261021/g4 && python3 -m unittest -v test_make_upgrade_bundle_g4.py > maker-tests.out 2>&1; echo "tests exit=$?" >> maker-tests.out; rm -rf __pycache__
