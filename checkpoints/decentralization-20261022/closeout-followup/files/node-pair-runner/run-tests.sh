#!/bin/bash
# run-tests.sh: the stubbed tests in a PRIVATE network namespace (no route anywhere), hard deadline
cd "$(dirname "$0")" || exit 2
exec timeout -k 10 300 unshare -rn sh -c 'exec python3 -u -m unittest -v test_root_node_pair.py'
