#!/bin/sh
cd "$(dirname "$0")/.."
for m in m1-restart m2-write; do
  RECOVERY_PROBE=mutants/$m.py python3 -m unittest test_recovery_probe.T.test_read_only_by_ast > mutants/$m.out 2>&1; echo "$m rc=$? $(grep -o "a command outside[^']*\|a .NET member outside[^']*" mutants/$m.out | head -1)"
done
