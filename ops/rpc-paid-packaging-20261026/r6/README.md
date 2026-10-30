# paid-derived-adapter-stage/r5: packaging repair of the r4 freeze (NOT yet run; root owns qualification)

r4 failed root full-1268. Its new suite passed 15/15 and its config matrix 5/5, but `attested-route-composition` test 6 failed: pristine 7/7, patched 6/7. The packaged provider died with ENOENT on `schedule_reader.mjs` at load, in EVERY mode. The receipt is preserved in `receipts/`; the r4 stage files are unchanged and serve as this job's control.

## Root cause
- **1. Static import of the derived reader.**
  - r4 `main.mjs` statically imported the derived reader.
  - KVM `network/derived-reader/vendor/schedule-input-r2.mjs` (pinned, unchanged) runs `verifyReaderPin()` at module load on `new URL('./schedule_reader.mjs', import.meta.url)` and then `await import(READER_PATH)`.
  - In a bundle, `import.meta.url` is the bundle's location, and esbuild cannot inline the computed import.
- **2. Reader CLI inside the bundle** (latent in r4, same class): KVM `derived-reader/main.mjs` has a "main script" check. Inside the provider bundle it would be TRUE, and the reader's CLI would run with provider.json as its config.

## Fix (provider packaging only; no KVM file edited; `verifyReaderPin` and the pinned reader bytes kept)
| file | change |
|---|---|
| `network/wg-provider/main.mjs` | Loads `./derived-runtime.mjs` through a module-relative URL (never bundled), ONLY when `paidFinality` is `"derived"`. That includes `--check-config`, which reports `derivedRuntime` and refuses explicitly if the runtime does not load. |
| `network/wg-provider/derived-runtime.mjs` (new) | `startDerivedReader` + `serveDerivedReader` (= KVM `runDerivedReader`, without its CLI check), `createDerivedSubmitter`, `openDerivedAnchorFloor`. |
| `scripts/network/build-consumers.mjs` (the actual release pipeline) | Also emits `derived-runtime.mjs` (its own bundle, `checkBundle`) and copies `schedule_reader.mjs` byte for byte after checking `vendor/provenance.json` (`688b7a1f…`), recording it in `build-manifest.json`. It FAILS the build if `provider.mjs` bundles any derived input. |
| `network/wg-provider/install.sh` | Installs `derived-runtime.mjs` + `schedule_reader.mjs` beside `wg-provider.mjs`, both or neither. The existing `--check-config` then refuses a derived configuration without them, or with altered reader bytes. |

The derived closure (31 local modules) has exactly one module-relative resource, and this holds at c66 and at KVM's committed v3 `34a3c0d6d`.

## Production deploy paths (install.sh layout)
- `/opt/enclave-network/<release>/wg-provider.mjs` (`provider.mjs` from build-consumers);
- `/opt/enclave-network/<release>/derived-runtime.mjs` and `/opt/enclave-network/<release>/schedule_reader.mjs`, for paidFinality "derived" only;
- `/opt/enclave-network/current -> <release>`; `ExecStart=node /opt/enclave-network/current/wg-provider.mjs /etc/enclave-network/provider.json`.

Node realpaths the main module, so the siblings resolve inside `<release>`. A quorum or attested provider ships and loads neither file.

## Root-owned commands (from rpc-production-final-20261025; no test of r5 has been run by Claude)
```
bash jobs/q-exit-status.sh paid-derived-adapter-r5-full    768 unshare -Urn bash paid-derived-adapter-stage/r5/jobs/paid-derived-adapter-r5.sh full
bash jobs/q-exit-status.sh paid-derived-adapter-r5-mutants 512 unshare -Urn bash paid-derived-adapter-stage/r5/jobs/paid-derived-adapter-r5.sh mutants
```

**full PASS requires:**
- adapter suite 15/15;
- NEW `test/paid-derived-packaging.test.mjs` 5/5:
  1. the real pipeline builds; `provider.mjs` has no derived inputs; the resource is pinned;
  2. a packaged provider alone runs quorum and local-verifier `--check-config`, and refuses derived explicitly;
  3. the release layout through a `current` symlink: derived OK; an altered reader gives `reader_pin`; a missing reader gives ENOENT; quorum still OK;
  4. the source entry resolves the source runtime;
  5. the adapter journal cases (back-to-back, advancement, restart/re-broadcast, forged history, gap/conflict) run against the RELEASE `derived-runtime.mjs`.
- all 9 regression files with pristine == patched (attested-route-composition must be 7/7 patched);
- the **r4 control** (r4 patch composed) must FAIL attested-route-composition with the schedule_reader ENOENT;
- the check-config matrix;
- packaging mutants `static-derived-import` and `no-reader-resource` killed.

**mutants PASS requires:** an unmutated adapter baseline of 15/15, then all 12 mutants (`../jobs/mutants.json`) killed. A failed baseline invalidates the run.

## Frozen
- `patches/paid-derived-adapter-r5.patch`: 12 files against baseline `64156dc` + KVM `c66b087` inputs. It applies to a fresh export and yields `PATCHED-PINS.sha256` exactly.
- `BASE-PINS.txt`: the 6 baseline blobs.
- Inputs and the control come from the r4 stage (its `SHA256SUMS` and `INPUT-PINS` are checked).

Still pending (unchanged from r4):
- real positive Base derivation;
- SNP qualification;
- a private history node;
- composition onto the root lineage (`3a0179647` lacks the attested modules).

No production or self-hosted RPC claim is made.
