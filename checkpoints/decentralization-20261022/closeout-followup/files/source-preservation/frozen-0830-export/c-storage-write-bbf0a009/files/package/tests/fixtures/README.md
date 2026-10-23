Test inputs for tools/cutover.py. REAL = captured output; DERIVED = assembled from real values, as stated.
- vm-state-v26-real.out: REAL production-run/state.out (vm-state.sh on the live VM before the v26->28 migration). Expected NO-GO.
- vm-state-v28-from-postcheck2.out: DERIVED: vm-state.sh key=value form holding the values production-run/v28-postcheck2.out
  verified (release/current/running 2c0e5b06, schema 28, active/running, 0 fenced, 0 CAS, no scratch/sessions, lock no); pid invented.
- backup-receipt-v26-real.json: REAL backup receipt of run 20261022T191749Z-603f3b39 (storage-production-preparation-20261022.json
  .backup): schema 26, so NOT a valid pre-enrollment backup. The tests derive a schema-28, fresh variant from it.
- l1-healthz-claim1.json, l1-fact-claim1.json, l1-account-row.txt: REAL /healthz, lease16 fixture fact and indexd account row of
  the first fenced C2 boot of 00e9cde0 on a 0.1.8 account (storage-client-interop run l1; FIXTURE backend, loopback).
- m3-*.json, m3-account-row.txt: REAL captures of the staged rehearsal run m3 (rehearsal/runs/m3/results.json; FIXTURE backend: three loopback indexers).
