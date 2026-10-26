# paid-derived-v3-composition-stage: the paid derived adapter on the qualified v3 reader runtime (prepared; NOT run; no activation)

**Final tree `5037054a3dc70ed860eb6e7599ae617727af4d33`** (`FINAL-TREE`). It is `reader-runtime-composition-stage/r2` tree `9dd20e7615ca16f69417309664f95db96640399f` plus the `paid-derived-adapter-stage/r7` patch, unchanged.

- The r2 tree is base `64156dcd` + the committed KVM v3 `34a3c0d6d` reader closure: 32 files, root-qualified 33/33.
- Versus base: 38 added + 6 modified = 32 reader + 12 paid. No other KVM, ops or main change is included.
- The ops branch `3a0179647` is NOT used.

## Provenance and pins (`COMPOSITION.json`)
- `patches/final-vs-64156.patch`: `git diff --binary --full-index 64156dcd FINAL`. It was verified, with git only, to reproduce FINAL exactly from a clean base export.
- `patches/final-vs-reader-r2.patch`: the 12-file paid delta.
- `patches/paid-derived-adapter-r7.patch`: r7's bytes, `b3b0da6b…`. It applies to the r2 tree and yields r7's PATCHED-PINS exactly (`inputs/r7-PATCHED-PINS.sha256`).
- `inputs/`: r7 and reader-r2 SHA256SUMS, plus r2 COMPOSITION.json. The job checks them against the live stages.
- `git/`: a private bare repo holding the FINAL tree object, with read-only alternates to r2's and the shared object store. No commit objects were made. The job never trusts the stored tree: it rebuilds FINAL twice.
- **Pins:**
  - native v3 `49f4d7e3…` (agrees in `config.v3.example.json` and `native.mjs`);
  - schedule reader `688b7a1f…` (provenance pin = bytes);
  - helios `cc962e2b…`;
  - package lock `9ada1611…` (viem 2.53.1).

## v3 API compatibility (checked statically on the final tree)
- **Byte-identical c66 → v3**, for everything the adapter imports: `lifecycle-finality-bridge.mjs`, `derived-reader/api.mjs`, `vendor/anchor-bootstrap.mjs`, `vendor/schedule-input-r2.mjs`, `vendor/schedule_reader.mjs`, `vendor/provenance.json`, `lifecycle.mjs`, `main.mjs`.
- **v3 `provider.mjs`** keeps `startDerivedReader(config, options)` and `readAnchor({signal})`. It adds `native.resultVersion: 3` with a private coverage store (`stateDir/coverage`) and `readDerivedLogs`, which is lease16 event coverage.
- **Coverage:** the paid adapter neither uses nor shadows coverage. It verifies its own receipts (EIP-2935 ancestry, transactionsRoot, receiptsRoot), and it passes the reader config through unchanged, so a v3 config runs v3.
- **Import closure** (all resolved):
  - the provider (`main.mjs`) has 51 local modules and **0 derived-reader modules**;
  - `derived-runtime.mjs` has 33 local modules, including v3 `coverage.mjs`/`coverage-store.mjs`;
  - its only module-relative resource is `schedule_reader.mjs`;
  - it has no main-script check.

## Actual deployment closure (no activation; install.sh was not run)
1. **Build** (on the final tree, in release order):
   1. `node relay/build-network.mjs`: the generated `relay/network-runtime.bundle.mjs`, a build input of `dns.mjs` only; it is not shipped with the provider.
   2. `node scripts/network/build-consumers.mjs <out>`, which produces:
      - `provider.mjs`;
      - `derived-runtime.mjs`;
      - `schedule_reader.mjs` (pinned);
      - `build-manifest.json`;
      - and the unchanged `privacy-agent.mjs`, `checker.mjs` and `dns.mjs`.
2. **Provider host** (install.sh layout):
   - `/opt/enclave-network/<release>/{wg-provider.mjs (= provider.mjs), derived-runtime.mjs, schedule_reader.mjs}`;
   - `/opt/enclave-network/current -> <release>`;
   - `ExecStart=node /opt/enclave-network/current/wg-provider.mjs /etc/enclave-network/provider.json`.
   - The derived pair is installed both or neither, only for paidFinality "derived".
3. **Reader runtime assets.** These come from `derivedFinality.readerConfigFile` (v3: `config.v3.example.json` shape), live inside the accepted measured image, and are NOT shipped by install.sh:
   - `/opt/enclave/bin/derivation_harness_lease_v3` (sha256 `49f4d7e3…`, resultVersion 3);
   - `/opt/enclave/bin/helios` (`cc962e2b…`);
   - `/opt/enclave/policy/checkpoint.json` (pinned checkpoint);
   - an optional pinned glibc runtime;
   - a private 0700 state dir (e.g. `/var/lib/enclave/derived-reader-v3`; `initializeState` true only at enrollment);
   - loopback L1 consensus/execution;
   - loopback `baseUrl` (untrusted candidate headers);
   - loopback witness `apiPort` (never authority).
4. **Provider config:**
   - `chainAuthority` "attested-verifier" (branded executor) or "verifier" (loopback executor);
   - `txBackend` (the operator's own node: broadcast only);
   - `paidFinality: "derived"`;
   - `derivedFinality {readerConfigFile, floorFile?, historyUrl? (private read-only eth), maxPending?}`.
   - State: `/var/lib/enclave-network/onchain-send.json` (+ `.lock`) and `derived-anchor-floor.json`.
5. **Admin controls and no public fallback:**
   - no contract or admin change; registry, host policy, lease reads and custody freshness are untouched;
   - under derived mode no paid read or send uses `cfg.rpc`;
   - refused: a public `txBackend` or `historyUrl`; quorum + derived; `derivedFinality` without the opt-in;
   - final success only with a receipt proven at derived finality; pool acceptance is never success.

## Root-owned jobs (prepared, not run by Claude)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh paid-v3-composition-packaging 768 unshare -Urn bash paid-derived-v3-composition-stage/jobs/root-paid-v3-composition.sh packaging
bash jobs/q-exit-status.sh paid-v3-composition-full      768 unshare -Urn bash paid-derived-v3-composition-stage/jobs/root-paid-v3-composition.sh full
bash jobs/q-exit-status.sh paid-v3-composition-mutants   512 unshare -Urn bash paid-derived-v3-composition-stage/jobs/root-paid-v3-composition.sh mutants
```

**Every mode first:**
- reproduces FINAL twice in a private `$OUT/git`: r2 tree + r7 patch, and base + `final-vs-64156.patch`;
- checks that FINAL differs from r2 in exactly the 12 paid files;
- checks the r2, r7 and r4 stage sums;
- checks the candidate checkout is clean `64156dcd` with lock 9ada1611.

Pristine = the r2 tree; patched = FINAL.

**packaging PASS requires:**
- adapter 15/15;
- packaging 5/5, including the nested whole adapter suite against the RELEASE runtime (diagnostic line required) and the real prerequisite `node relay/build-network.mjs`;
- 3 packaging mutants killed;
- the no-prerequisite control FAILS explicitly, with 0 skipped;
- the `--check-config` matrix, including **valid-v3** (the v3 reader config).

**full PASS requires:** packaging PASS, plus the 9 paid regression files pristine == patched, plus **KVM's 33 reader tests, 33/33 exact on both sides**.

**mutants PASS requires:** adapter 15/15 unmutated, then 12/12 mutants killed.

c66 is not re-tested here; that work is superseded. If the r7 packaging run (root 1292) fails, its diagnostics apply here too. Nothing is inferred as PASS.

## Not claimed
- No positive real Base derivation.
- No SNP or accepted image.
- No live private history node.
- No activation.
- No self-hosted RPC in production.
- The adapter suite's reader and executor are labelled stand-ins.
