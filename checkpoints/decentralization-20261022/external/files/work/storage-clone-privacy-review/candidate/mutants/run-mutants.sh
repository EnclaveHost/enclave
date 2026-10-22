#!/bin/bash
# run-mutants.sh: for each mutant, restore the fix, apply the mutant, run every clone_privacy case (run-cases.sh);
# then restore and print the restored files' hashes. A mutant is KILLED when at least one case fails.
cd "$(dirname "$0")/.." || exit 2
S=sia-s3/vendor/sia-sdk-rs/sia_storage/src
cp $S/erasure_coding.rs mutants/erasure_coding.rs.orig && cp $S/object_encryption.rs mutants/object_encryption.rs.orig || exit 2
restore() { cp mutants/erasure_coding.rs.orig $S/erasure_coding.rs; cp mutants/object_encryption.rs.orig $S/object_encryption.rs; }
trap restore EXIT
for m in M1 M2 M3 M4 M5; do
  restore
  python3 mutants/mutate.py $m || { echo "$m NOT APPLIED"; continue; }
  ./run-cases.sh mut-$m > logs/mut-$m.summary 2>&1
  rc=$?
  if [ $rc -eq 1 ]; then echo "$m KILLED"; elif [ $rc -eq 0 ]; then echo "$m SURVIVED"; else echo "$m ERROR rc=$rc"; fi
  grep "^case" logs/mut-$m.summary | grep -v "rc=0"
done
restore
sha256sum $S/erasure_coding.rs $S/object_encryption.rs mutants/*.orig
