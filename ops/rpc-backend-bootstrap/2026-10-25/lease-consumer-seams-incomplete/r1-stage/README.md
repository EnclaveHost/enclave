# Lease-consumer seams (PREPARED; NOT run; NOT production approval)

- **Base:** an exact `relay-consumer-source` `81ba668531d17151db810e14562c77a672d742e4`. The actual branch is not edited; `base/` holds byte copies (`BASE-FILES.sha256`).
- **Not done:** no tests, queue use, builds, SSH, live access or commits. Checks done: `node --check` parse only, plus the anchor-exact patch generation.

## Findings that shaped the seams (from reviewing the existing constructors first)

1. **The Windows node has no host chain authority:** its public client is `fallback(BASE RPCS)` (`windows/node/chain.mjs:138`). Its lease config also used only `LEASE_GAS_*` names (`:258-259`), with no `chainAuthority` (`:272`), so `ENCLAVE_CHAIN_AUTHORITY` (`network/chain-authority.mjs:21`) could never reach it.
2. **The committed Windows bundle is stale:** its manifest pins `network/lease-gas-runtime.mjs` at `91b5e357…`, the source is `eb78a2e6…`, and the bundle has 0 occurrences of `chain-authority`/`ENCLAVE_CHAIN_AUTHORITY`. It was last rebuilt on 2026-10-22; the authority landed on 2026-10-23. **So Windows needs a rebuilt bundle, not only a source change.**
3. **The Metal conduit (also bundled: `metal/guest/lease-gas-conduit.bundle.mjs`) requires ≥ 2 public `rpcs`** (`network/lease-gas-conduit.mjs:51`). Under a bound verifier the supervisor never contacts them (`lease-gas-runtime.mjs:52-54`), but they were mandatory configuration.

## Seams (`seams.patch` = `base/` → `candidate/`; 6 files)

| File | Change |
|---|---|
| `network/lease-gas-runtime.mjs` | Re-export the **existing** `chainAuthorityFromEnv` and `refusingChainAuthority`, so the Windows bundle carries the same constructors. Nothing new is invented. |
| `windows/node/chain.mjs` | `LEASE_CHAIN_AUTHORITY` is built **exactly as `supervisor.js:327-331`**: `chainAuthorityFromEnv(process.env, {chain: base})`; an invalid selection gives `refusingChainAuthority`. It is passed to `loadLeaseGasConfig({…, chainAuthority})`, as `supervisor.js:10211` does. With the env unset it is `null`, so the legacy behaviour is unchanged. |
| `network/lease-gas-conduit.mjs` | A `verifierBound` option on `leaseGasTransit`/`checkTransit`/`leaseGasGuest`. When bound, `rpcs` must be absent or `[]` and `quorum` absent; anything else is **refused** (the mixed-configuration error). No `ENCLAVE_LEASE_GAS_RPCS`/`QUORUM` is installed. Unbound (legacy) is unchanged: a bound transit there refuses, since rpcs are required (no silent fallback). Relays, pinned relays, the reserve, the record and the digest (funding) are untouched. |
| `metal/enclave-metal.mjs` | Host: `verifierBound` = `cfg.chainVerifier` present (it is checked at `:265`; invalid stops the launch) |
| `metal/guest/gsup.mjs` | Legacy guest: `verifierBound` = `fw.chainVerifier` present. An invalid verifier gives the refusing verifier env (`chain-verifier.mjs:160`), so leases refuse. |
| `metal/guest/measured-control.mjs` | Direct config: `directLeaseGas(raw, {verifierBound: chainVerifier !== null})` and both `leaseGasGuest` calls. No admin, owner, policy or other member is touched. |

**Bundles:** both are **rebuilt by the job** (`scripts/build-windows-lease-runtime.mjs`, `scripts/build-metal-lease-gas.mjs`, then `--check`). They are not committed here. The rebuilt bundle bytes and manifests become part of the reviewed change.

## Regressions (`test/`; real modules, no anvil, no skips)

- **`lease-seams-conduit.test.mjs`:** run against both the source conduit and the rebuilt bundle. It covers:
  - legacy unchanged;
  - a bound config with no rpcs accepted, installing no RPC name, with relays kept;
  - mixed configurations refused at the host, the transit and the guest;
  - a bound transit in an unbound guest refused;
  - the runtime loading the bound env as **one** client, `=== authority.client`, quorum 1, and refusing without the authority (never a default provider);
  - legacy env keeping its quorum.
- **`lease-seams-windows.test.mjs`:** the **real** `windows/node/chain.mjs` with the **real rebuilt bundle** and a recording `fetch`. It checks:
  - verifier mode: a claim contacts the verifier and **never** the `ENCLAVE_LEASE_GAS_RPCS` hosts;
  - an invalid selection: refuses, with no lease RPC host contacted;
  - legacy: the lease RPC hosts **are** contacted. This also validates that the observer sees lease reads.

## Job (`jobs/root-seams-test.sh`; root runs it; offline under `unshare -rn`)

```
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/lease-consumer-seams-stage
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $S/root-seams-test.guard -- unshare -rn bash $S/jobs/root-seams-test.sh > $S/root-seams-test.out 2>&1; echo $? > $S/root-seams-test.rc
```

- **Clones:** two private clones (`git clone --no-local`, then checkout `81ba66853`), with a copy of `node_modules`. The source repo is only read.
- **Base run:** committed bundles, with their `--check` result recorded (Windows is expected stale). Runs the existing `lease-gas-runtime`, `metal-lease-gas-conduit`, `chain-authority`, `lease-pinned-relay-config` and any `*measured-control*` tests, plus the seam tests.
- **Candidate run:** the patch applied and verified equal to `candidate/`; both bundles rebuilt and `--check`'ed; then the same tests.
- **PASS only if:**
  - the candidate shows 0 fail/skip/todo/cancelled;
  - the base shows 0 skips and fails **exactly** the 9 expected seam tests (listed in the job). That proves the gap exists on base.
- **Memory lane:** 1024 MiB, inferred (not measured).

## Not fixed and not claimed

- **Deep receipts:** a landed lease receipt more than 256 blocks below the head, under a sole verifier, still cannot be verified. It is relabelled `gone`/`gave-up` (supervisor) or `consumed`/`expired` (Windows) instead of `released`, under exactly the adverse conditions root requires: outages and restarts (`canonical-consumer-depth-audit/ROOT-REVIEW.md`, `LEASE-OUTCOME-TRACE.md`). **These seams do not change that.**
- **Windows non-lease reads:** Windows chain reads other than leases (`chain.mjs:138`, `BASE_RPCS`) remain on public RPCs. A host-wide Windows cutover is a separate seam.
- **Releases and measured images:** changing `metal/guest/*` changes the measured guest image (a new measurement and release are required). The Windows change needs a new Windows release.
- **No claims:** no finality or production claim, and no live config. HOLD stays until root runs this job, reviews, releases and prepares the configs.
