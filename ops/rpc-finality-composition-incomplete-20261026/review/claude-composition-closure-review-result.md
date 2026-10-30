# Composition closure review (r4 actual) → r5 runner corrections (prepared only; nothing run)

r4 and the r3 candidate are frozen and untouched. This prepared: `closure-review/` (SHA256SUMS `68c065f4fffa3b02…`) and `r5/` (SHA256SUMS `71f0dfe035a31e3a…`, runner `f0e360bbe963cddc…`).
- **Nothing executed:** no test, build, queue job, network access, SSH or commit. Only git reads, sha256, `bash -n`, the read-only native-input precheck line, and a synthetic check of the path filter.
- **No product or test code changed:** every real failure below is a **runner omission**, not a runtime-code defect.

## r4 actual result (root-composition-r4-0154, rc 1, before any test)
**r4's own fixes worked:**
- the precheck passed in full (deps identity, inventories 10/4/2/4/6, 8 stack tests, disk);
- the closures were copied into all 6 trees;
- **attested-guest-verify reproduced from BOTH independent image exports** (00b88784…, d954ecf8…).

**The failing path:** `build-host-service-packages` → route-dns → `relay/dns-relay.js` imports `./network-runtime.bundle.mjs`.
- That file is gitignored. It must be built by `node relay/build-network.mjs` **before** the packages; the generator itself says "run node relay/build-network.mjs first".
- r4 never ran it. Route's passing jobs b1, b3 and p5 did.
- **Classification:** a runner omission present on every tree, so a baseline condition, **not a candidate regression**.

## What r4 left out (the "all bundles checked" claim was inaccurate)
| gap | evidence | r5 |
|---|---|---|
| network-runtime never built | above; it is the first step in 50cf's order | built first in both passes; its bundle and manifest must be byte-identical |
| **Windows lease runtime** (`scripts/build-windows-lease-runtime.mjs`) omitted | its manifest is **stale for 4 composed inputs** in the candidate (client/lease-executor-client.mjs, network/rpc-identity.mjs, network/service-index.mjs, network/verified-chain.mjs) and clean at the seam. **Without regeneration the Windows node would ship the pre-composition verified-chain/lease client code** | regenerated; `--check` after |
| site vendor bundles (host-policy, management, aa, custody, credit-vault, host-capacity) and relay/vendor/enclave-verifier-node not covered | statically 0 stale tracked inputs in every head and in the candidate | `--check` must pass (check-only, never regenerated); relay/vendor must equal its copiedFrom verifier/dist file |
| "nothing else touched" was a suffix filter (any `*.bundle.mjs`/`*.manifest.json`) | it would accept an unexpected bundle change | **exact allowlist of 20 tracked paths** (GENERATED.txt), including untracked and ignored files; only relay/network-runtime.bundle.mjs(.manifest.json) may appear ignored |
| output manifests were checked only by each generator's own `--check`, and only for listed generators | — | after regeneration, a static check of **every** committed manifest (18) must find 0 stale inputs and no absent tracked inputs. The 2 guest-verify manifests are excluded because their inputs are the image commit's, checked against both exports |
| native-input tests skipped (`test/metal-control-overlay.test.py`, 2 tests env-gated on CHAIN_VERIFIER_INPUTS) | 50cf's stage explicitly allows these 2 skips | run with CHAIN_VERIFIER_INPUTS = root 0104's `canonical-integration-actual/run/regress-20261026T005955Z/chain-verifier-inputs` (precheck: PINS verify and all 7 files equal the candidate's `metal/chain-verifier-image.json`, helios 8250f08a; checked read-only now: OK). **The last line must be exactly `OK`; any skip fails** |

## Baseline vs composition (`closure-review/BASELINE-VS-COMPOSITION.md`, static)
- **Composition-induced** (stale only in the candidate, so regeneration is required):
  - Windows lease runtime: 4 inputs;
  - metal lease conduit: 2 inputs;
  - mcp-server: 10 stale (2 at baseline);
  - platform-api: 20 stale (3 at baseline). It also pins the conduit and measured-control.
- **Baseline-stale** (already stale at the owning head, unchanged by the composition): the host-service packages credit-vault-submitter, directory-replica and route-dns (2-3 each) and policy-mirror (7). They are regenerated and must then pass `--check`.
- **Image-commit inputs** (guest-verify): checked against the exports, and they pass.
- **Guards:** no guard was weakened. A builder failure, a stale check, a non-deterministic pass, an unexpected path, a stale manifest, a changed closure, or any failing, skipped or 0-test stack or native run all FAIL. A dirty component baseline is INCOMPLETE.

## Comparison with platform-bundle-closure-stage (50cf, read only)
- **Agreements:** its 16-path list and order match r5. r5 adds what that stage did not cover in the composed runtime:
  - the 5 host-service packages, their manifests and the gitignored-runtime dependency;
  - the guest-verify image-commit check;
  - 4 more site vendors (aa, custody, credit-vault, host-capacity);
  - relay/vendor;
  - no allowed skips.
- **Its own limits** (still true): no image build, overlay, SNP measurement, live hosts or chain-verifier guest e2e. No test counts are pinned.
- **Avoiding duplicate rebuilds:** r5 is the single builder for the integrated tree. Running 50cf's job on the same tree too would duplicate the work, so choose one. r5 is the superset for this candidate.

## Root command (shared queue, 2560 MiB, offline; nothing was queued here)
    ./jobs/q-exit-status.sh rpc-runtime-composition-r5-1 2560 unshare -rn bash rpc-runtime-composition-stage/r5/jobs/r5-build-validate.sh [--precheck-only]

## Still unproven
- whether the regenerated platform-api, mcp and Windows bundles pass their consumer tests;
- the r3 stack tests' first run, and the stricter-config and authority-union risks;
- whether the 4 extra vendor `--check`s pass offline;
- image, packages, SNP, live and push.
