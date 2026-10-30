# r4 integration manifest: transplant ONLY after root's r4 run passes (NOT approval; HOLD below)

Base: `relay-consumer-source` `81ba668531d17151db810e14562c77a672d742e4`. **15 paths:** 6 product + 5 test + 4 generated. Full hashes:
- `integration/source-and-tests.sha256`: the 11 non-generated files, as tested. The r4 runner checks them in the candidate clone (`integration-check.out`).
- `integration/rev-before.sha256`: all 15 at REV, i.e. what the transplant replaces. Re-derived from git at REV while writing this file: unchanged.
- `integration/r3-build-bundles.reference.sha256`: the r3 build of the same inputs. It is reference only; the runner reports the comparison in `integration-bundles-vs-r3.out`.

| Path | Kind / source of the bytes | REV sha | Transplant sha |
|---|---|---|---|
| `metal/enclave-metal.mjs` | product (seams.patch) | `c71fb232e58d` | `0e6b3b582c82` |
| `metal/guest/gsup.mjs` | product (seams.patch) | `d71abd221f65` | `dba07d175066` |
| `metal/guest/measured-control.mjs` | product (seams.patch) | `9694071f33d8` | `3dec86be1af3` |
| `network/lease-gas-conduit.mjs` | product (seams.patch) | `1974ad9378a4` | `f1b9304494ad` |
| `network/lease-gas-runtime.mjs` | product (seams.patch) | `eb78a2e6838f` | `515df695ed11` |
| `windows/node/chain.mjs` | product (seams.patch) | `86c81124cca6` | `93d9a722bd7e` |
| `test/lease-seams-conduit.test.mjs` | test, stage `test/` (r1, unchanged) | `ABSENT (new)` | `e830f2b549f7` |
| `test/lease-seams-windows.test.mjs` | test, r4/test (= r3 `b9f76ec2`) | `ABSENT (new)` | `b9f76ec28573` |
| `test/lease-pinned-relay-config.test.mjs` | test, r4/work/b (r4 fixtures.patch) | `91a49d94eefa` | `bce0d69cbda5` |
| `test/metal-measured-control.test.mjs` | test, r4/work/b (= r3) | `0704204925c8` | `681d5c4bd287` |
| `test/metal-lease-gas-conduit.test.mjs` | test, r4/work/c (= r3 candidate-tests.patch) | `d07acce3f468` | `7819ebe17781` |
| `windows/node/lease-gas-runtime.bundle.mjs` | generated (rebuilt in the run) | `008cdca12403` | from the PASSING r4 run's `integration-bundles.sha256` (r3 build: `bdf8628cde75`, reference only) |
| `windows/node/lease-gas-runtime.bundle.mjs.manifest.json` | generated (rebuilt in the run) | `a7fde25eae44` | from the PASSING r4 run's `integration-bundles.sha256` (r3 build: `61a1daec0eaa`, reference only) |
| `metal/guest/lease-gas-conduit.bundle.mjs` | generated (rebuilt in the run) | `48bd059a5735` | from the PASSING r4 run's `integration-bundles.sha256` (r3 build: `7735609f3e70`, reference only) |
| `metal/guest/lease-gas-conduit.bundle.mjs.manifest.json` | generated (rebuilt in the run) | `12b9c87543bd` | from the PASSING r4 run's `integration-bundles.sha256` (r3 build: `5369de0233eb`, reference only) |

**Transplant rule:**
1. Copy the bytes from the passing run's `$OUT/work/candidate/<path>`.
2. Before copying, verify the 11 files against `integration/source-and-tests.sha256` and the 4 bundles against that run's `$OUT/integration-bundles.sha256`.
3. Do not transplant the r1 `lease-consumer-seams-stage/test/lease-seams-windows.test.mjs`; it is superseded.
4. Do not transplant any `work/base` file.
5. The Windows test names keep the "Windows r3:" prefix. The exact 9-failure list depends on those names, so they are not renamed.

**Source head drift:** `relay-consumer-source` has moved to `920a5911d`, and a mode fix is pending; it includes an independent 3-file deep-CLI patch. r4 does **not** follow it.
- The runner clones `$SRC` and checks out `81ba668531d17151db810e14562c77a672d742e4` explicitly; it asserts HEAD equals that commit.
- The 15 before-pins, the patches and the expected failures are all against `81ba`. No r4 input was changed for the drift.
- Moving onto `920a5911d` (or later) is a separate step after r4 passes: re-derive the before-pins at the new head and confirm the deep-CLI files are disjoint from the 15 paths (and from the platform-api inputs).

## Static completeness check (no execution)

- **Product files:** the `seams.patch` file list, `candidate/` and the first 6 pins are the same 6 paths. Their REV hashes equal the stage's `BASE-FILES.sha256`.
- **Tests:** `fixtures.patch` and `candidate-tests.patch` touch exactly the 3 changed existing tests. The 2 seam tests are new. The runner also runs `test/lease-gas-runtime.test.mjs` and `test/chain-authority.test.mjs`, which are unchanged at REV and not transplanted.
- **Generated files:** `scripts/build-windows-lease-runtime.mjs` and `scripts/build-metal-lease-gas.mjs` write exactly the 4 generated paths (bundle + `.manifest.json` each).
- **REV-wide pins:** across REV, the only other file that pins a pre-change hash of these paths is `metal/guest/platform-api.bundle.mjs.manifest.json`. **HOLD:** see `PENDING-platform-api-bundle.md`. This manifest is complete for the r4 tested set, but not a complete integration.
