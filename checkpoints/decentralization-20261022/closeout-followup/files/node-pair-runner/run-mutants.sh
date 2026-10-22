#!/bin/bash
cd "$(dirname "$0")" || exit 2
exec timeout -k 10 400 unshare -rn sh -c 'exec python3 -u mutants.py'
