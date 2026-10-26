# canonical-integration-actual: reviewed source CANDIDATE for Helios 8250f08a (prepared 2026-10-26; nothing committed, run or imaged)

Replaces the accepted Helios cc962e2b (eeffcc9) with the ACTUAL build 8250f08a (eeffcc9 + canonical-block.patch 41667ec9;
root-canonical-helios-build-0046 rc 0) in attested-verifier-source 77d6cc859. Pin replacement plus accurate docs only.

| path | what |
|---|---|
| `candidate/` | the 5 changed files, complete (`CHANGED-FILES.txt`; before/after sha256 in `SOURCE-FILES.sha256`; `candidate.diff`) |
| `UPDATE.json`, `candidate-generator.out`, `doc-edits.out` | outputs of the FROZEN `make-source-update.py` 881df987 and of `tools/make-doc-edits.py` |
| `tests/canonical-helios-pin.test.mjs` | old refused/new accepted (with a 77d6cc859 control), one-line runtime diff, all other network/ code byte-identical (no safe/finalized or other behaviour change), image/closure field-exact diffs, inputs dir = new helios + the 6 audited files |
| `tests/test-source-updater.py` | the frozen updater refuses malformed JSON, missing fields, non-hex/old digest, binary/provenance mismatch, missing sums line, wrong base/patch, existing output (and writes nothing); real artifact regenerates the candidate byte for byte |
| `tests/test-provenance.py` | out/ sums, provenance binding (eeffcc9/2171ad2b/28f4400c, patch 41667ec9, PATCHED map, vendor 9784e20a/c9301490, epoch, dev profile, tested-by receipts), log rc 0, 21 path packages rebuilt from the build's own tree, every pin in `jobs/INPUT-PINS.sha256` |
| `jobs/integration-regression.sh` | the ONE root job (offline, queue 1024) |

Root (foreground): `./jobs/q-exit-status.sh canonical-integration-regress-1 1024 unshare -rn bash canonical-integration-actual/jobs/integration-regression.sh`
Accept only `## rc=0`. Status: lease consumers HOLD (recovery + config unresolved); v2 custody REFUSED; no image, no measurement.
