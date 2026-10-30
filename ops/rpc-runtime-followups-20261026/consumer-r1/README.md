# final-consumer-composition-stage: one release-candidate SOURCE tree with reader + paid + writer (prepared; NOT run; no activation)

**Consumer tree `33e9cabcde02c6c5623786fca13588daa0d685d6`** (`FINAL-TREE`). Against base `64156dcd`: 42 added + 7 modified files, split as 32 reader + 11 paid + 6 writer (`COMPOSITION.json` lists every file with its blob and role).

| component | exact source | root receipt |
|---|---|---|
| reader | KVM `34a3c0d6d` closure = reader-runtime-composition-stage/r2 tree `9dd20e76` (the same 26 closure blobs as writer r3's `KVM-34a3-CLOSURE.blobs`) | 33/33 |
| paid | paid-derived-v3-composition-stage tree `5037054a` (r7 patch `b3b0da6b`) | full 1297 PASS, mutants 1304 12/12 |
| writer | finalized-writer-integration-stage r2 patch `eb804950` | r3 1273: 23 tests + 5 startup + 6 API checks |
| resolution | `patches/integration-resolution.patch` (4 files, below) | none yet (this job) |

**Reproducible two ways; both are checked by the job:**
- clean base + `patches/final-consumer-vs-64156.patch` (`23959323…`);
- paid-v3 tree + writer patch + resolution patch.

`git/` holds the tree objects, with read-only alternates; no commit objects were made. `work/` is the scratch export the patches were made from. It is not part of the freeze, and the job never reads it.

## The one integration conflict and its resolution
- **Conflict:** `relay/network-runtime.mjs` (the relay's generated runtime bundle, `relay/build-network.mjs`) imports `network/onchain-qualification.mjs`. Paid r7 had added an opt-in `pipeline` flag there. That would change the generated bundle, and that bundle is PINNED (`e12c5baf…`) by two committed artifacts:
  - the host-service package `network/host-services/packages/route-dns.package.json`;
  - the measured guest manifest `metal/guest/platform-api.bundle.mjs.manifest.json`.
- **Resolution:**
  - `onchain-qualification.mjs` is exactly base bytes again.
  - The pipelined attestation loop is `submitAttestationsPipelined` in the provider-only, lazily loaded `network/wg-provider/derived-runtime.mjs`. It uses the same selection rules and the base module's exports.
  - `main.mjs` calls it only on the derived send path; every other path calls the unchanged `submitAttestations`.
  - The adapter test's pipelined case follows, and it also runs against the packaged runtime.
  - No runtime semantics changed.
- **Effect:** the closures of the relay runtime, route-dns, privacy-agent, the checker and the Windows enroll entry contain NO changed file. So the generated relay bundle must equal the base build byte for byte, which the job checks.
- **Unavoidable (writer):** the measured guest bundle `metal/guest/platform-api.bundle.mjs` has `relay/api-relay.js` among its inputs, so it MUST be regenerated from this source. That is a new guest measurement.

## Deployment recipe (for a later qualified cutover; nothing here was run or deployed)
1. **Source:** commit exactly tree `33e9cabc` (root), plus the regenerated `metal/guest/platform-api.bundle.mjs{,.manifest.json}` from step 2.
2. **Generated artifacts** (deterministic; the order is the release's):
   1. `node relay/build-network.mjs` → `relay/network-runtime.bundle.mjs` (+ manifest). It must equal the base build.
   2. `node scripts/build-platform-api-guest-bundle.mjs`, then `--check` must pass.
   3. `node scripts/network/build-consumers.mjs <out>`, which produces:
      - `provider.mjs`;
      - `derived-runtime.mjs`;
      - `schedule_reader.mjs` (`688b7a1f…`);
      - `privacy-agent.mjs`, `checker.mjs`, `dns.mjs`;
      - `build-manifest.json`.
   - Host-service packages and the MCP guest bundle are unchanged: same status as base.
3. **Relay host:** `relay/deploy.sh`. Its scp list now includes `derived-writer-authority.mjs`, plus the generated runtime bundle and manifest.
   - With `ENCLAVE_WRITER_AUTHORITY_SOURCE` unset: exactly today's behavior, `writer_authority_unproven`.
   - With `=derived`: the relay refuses to start ("not composed": the relay runtime carries no reader).
4. **Measured guest image:** `metal/build-image.mjs` with the regenerated platform-api bundle. This is a new measurement and needs SNP/image qualification, which is pending.
5. **Provider hosts:** `install.sh` from a directory holding `wg-provider.mjs` (= `provider.mjs`); add `derived-runtime.mjs` + `schedule_reader.mjs` only for paid `paidFinality: "derived"`. Layout: `/opt/enclave-network/<release>/`, with `current -> <release>` and `previous` kept.
6. **Paid derived reader assets** (inside the accepted measured image, from the reader config):
   - `/opt/enclave/bin/derivation_harness_lease_v3` (`49f4d7e3…`, resultVersion 3);
   - `/opt/enclave/bin/helios` (`cc962e2b…`);
   - `/opt/enclave/policy/checkpoint.json` (pinned, 7-day expiry);
   - an optional pinned glibc runtime;
   - a private 0700 state dir;
   - loopback L1/base/witness endpoints.
7. **Windows path:** no file under `windows/` or `test/windows-*` changed; it ships exactly as base.

## Rollback
- **Provider:** `ln -sfn "$(readlink /opt/enclave-network/previous)" /opt/enclave-network/current`, then restart the provider unit. Never delete or replace the send journal.
  - `/var/lib/enclave-network/onchain-send.json` with at most one open entry is the legacy single record, which the previous attested release reads.
  - With two or more entries, the previous release refuses. Let derived anchors resolve the entries first, or keep the derived release.
  - `derived-anchor-floor.json` is ignored by older releases.
- **Relay:** redeploy the previous tree with its own `deploy.sh`. The unset-selector behavior is identical, and no relay state is migrated.
- **Guest image:** the previous measured image, with the committed base platform-api bundle.

## Root-owned bounded offline job (prepared; not run by Claude)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh final-consumer-package      768 unshare -Urn bash final-consumer-composition-stage/jobs/root-final-consumer.sh package
bash jobs/q-exit-status.sh final-consumer-integration  768 unshare -Urn bash final-consumer-composition-stage/jobs/root-final-consumer.sh integration
bash jobs/q-exit-status.sh final-consumer-relay       2560 unshare -Urn bash final-consumer-composition-stage/jobs/root-final-consumer.sh relay
bash jobs/q-exit-status.sh final-consumer-mutants      512 unshare -Urn bash final-consumer-composition-stage/jobs/root-final-consumer.sh mutants
```

**Every mode first checks:**
- all input stage sums;
- the tree reproduced two ways;
- the changed-file set and blobs;
- the Windows path unchanged;
- the reader closure = writer r3's;
- the shared module = base;
- a clean `64156dcd` checkout with lock 9ada1611;
- pinned anvil and forge.

It then exports base and consumer and builds the generated relay runtime bundle on both, which must be byte-identical.

| mode | PASS requires |
|---|---|
| package | host-service package / MCP `--check` status = base; the committed platform-api guest bundle is stale on the consumer and its `--check` passes after regeneration (new sha recorded in `RELEASE.sha256`); `build-consumers` OK; packaged provider: quorum without derived files OK, derived without them refused, derived (v3 reader config) with them OK; `node --check relay/api-relay.js`; writer r3's 5 startup cases on THIS tree's runtime; writer API composition 6/6; `relay-deploy-closure` base == consumer |
| integration | writer 23/23; KVM 33/33; paid adapter 15/15; paid packaging 5/5 plus the nested whole-suite line; 10 files base == consumer (the 9 paid regressions + `windows-node-lease-renewal-keeper`) |
| relay | the 8 candidate relay/platform-api tests whose closure includes `relay/api-relay.js`, base == consumer, with the candidate job's contract artifacts (rig-r2 manifest) and the consumer's regenerated guest bundle; counts as in `TESTS.tsv` |
| mutants | adapter 15/15, then 12/12 mutants killed |

**Not rerun:** the other 32 candidate tests, whose import closures are byte-identical to base. Their last receipt was at `debbfb37` + worktree, with known failures there, so they are **not re-qualified by this stage**.

## Known pending authority (NOT resolved by this assembly)
- **Writer:** the derived lease-writer authority stays fail-closed. The 120 s freshness ceiling is kept and an L1-finalized anchor cannot meet it; claims stay finalized-only; the relay runtime does not carry the reader. Fresh-state authority is unresolved.
- **Paid:** sends are final only at derived L1 finality. The adapter tests use labelled stand-in readers and executors. No real positive Base derivation, no live private history node.
- **Not done:** SNP or accepted-image qualification (including the regenerated guest bundle); production activation; any public or unsafe-head fallback. Feature availability is not proven.
