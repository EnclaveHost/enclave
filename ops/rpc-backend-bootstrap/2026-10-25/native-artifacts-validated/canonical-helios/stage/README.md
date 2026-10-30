# canonical-verifier-binary-stage (PREPARED 2026-10-25; nothing built, nothing installed)

The corrected native Helios CLI for the attested/host verifier packages: committed **eeffcc9 + canonical-block.patch
41667ec9**, i.e. the exact source that passed the canonical tests (35 named + 91 core, 12/12 required controls;
EVM 9 + 100 core + 5 EVM fault controls; `jobs/TESTED-EVIDENCE.sha256` pins those receipts). NO binary hash exists yet.

| file | role |
|---|---|
| `jobs/build-helios.sh` | the ONE root build job (queue 2560, offline, one compiler job) |
| `jobs/PINS.txt`, `jobs/TESTED-EVIDENCE.sha256` | INPUT-MANIFEST pin; the tested-evidence receipts the build refuses to run without |
| `integration/prepare-chain-verifier-inputs.sh` | AFTER the build: a NEW chain-verifier-inputs dir (old six files + new helios, new PINS.sha256) |
| `integration/make-source-update.py` | AFTER the build: exact counted edits of 3 files from 77d6cc859 + `update.diff` |
| `integration/OLD-PINS.sha256` | copy of the frozen old PINS.sha256 (cc962e2b) the prepare script checks against |

Root command (from `work/rpc-production-final-20261025`, foreground):

    ./jobs/q-exit-status.sh canonical-helios-build-1 2560 unshare -rn bash canonical-verifier-binary-stage/jobs/build-helios.sh
    # optional speed only: CANONICAL_CACHE_FROM=$PWD/verifier-canonical-stage/run/tests-20261025T234358Z (in place, locked,
    # CH0-equal; helios-cli is cleaned and the bin must be rebuilt; the cache run's target/debug/helios is then replaced)

Accept only `## rc=0` plus `fresh=false` for the helios bin; 98/99/any other rc = no artifact. The output
`run/build-*/out/{helios,provenance.json,smoke-*.txt,SHA256SUMS}` is a BUILD, not a pass and not a reproduction.

Root review (2026-10-26 00:46 UTC): compare the runtime pin-set bytes with the reviewed OLD-PINS before executing its loader, and require every discovered subcommand help smoke to exit zero. The original prepared runner is preserved. This changes no candidate product code or build flags.
