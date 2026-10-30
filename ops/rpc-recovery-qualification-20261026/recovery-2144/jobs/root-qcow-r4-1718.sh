#!/bin/bash
set -e
python3 jobs/root-qcow-r4-1718.py
bash qcow-allocation-nbd-stage/r4/jobs/tests.sh
