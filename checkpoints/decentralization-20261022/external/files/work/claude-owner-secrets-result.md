# Owner-read custody and cross-client secrets CRUD: result (claude, 2026-10-19)

**Status:** source and tests are complete and verified locally.
- This is not a production approval, a signature or an activation.
- No image was built. No commit, staging, SSH, wallet, GUI or Wine.
- Candidate `ee8beb38` and its provenance are untouched (`work/custody-candidate-source-20261020` and
  `work/custodian-shield-ee8beb38*` were not opened for writing).
- The custodian code changed, so this needs source review, a commit, a NEW measured candidate and the committee's
  `code-approve`. The old measurement cannot be reused.

**Repository:**
- `work/enclave`, HEAD `abe86262`. It moved from `45801c22` during this session; that commit touches only
  `windows/installer/*`, none of these files.
- Nothing is staged: `git diff --cached` is empty.

Interface, written first and appended twice: `work/owner-secrets-interface.txt`.
- §8 covers the browser and remote-signer usage.
- §9 covers the changes after the first write.

## Exact inventory (sha256 at the tested state; `M` = modified vs HEAD, `??` = new and untracked)

| sha256 | st | file |
|---|---|---|
| f35635aa4103f8075e3fcccc0be95b6c50f2d66240e95041509feeb17c7d694d | M | custody/rules.mjs |
| d3f857d1a75243c1262cb62b3fc44325246a7bcc35ec44ba388599f0c4c14ef9 | M | custody/v2/shield-rules.mjs |
| d30852c2b227760f95a900b2240355c507173e81f221b38219e34a3f8def38e4 | M | custody/v2/protocol.mjs |
| 9f2ed5caa4a79fc27e4ad4583abc7d5fd62cc60296bc89aa0560594cdf6d6b99 | M | custody/v2/chain.mjs |
| 30d2fc8be9e351591a23e67c064c12063bdb44be0b97259c59e073f86ba17ced | M | custody/v2/custodian.mjs |
| 541ba49b4b549ea974fb07c22c7bdca6ef0c04cde0992ce1ffa1623737e5a23c | M | custody/v2/http.mjs |
| 3237fc41160abf8bd6580d7415bb4f3aaed64cbf5dc314d772eb4925a1f3f737 | M | custody/v2/ingress.mjs |
| b47e835be86d66095a02e4f34e555c7fa6434cc7829056419d0f3f37ae147f01 | ?? | custody/v2/owner-secrets.mjs (shared client; isomorphic) |
| db712c1db5aac536914ecabfcb478256e2d7ad8522d1b9bae3ae2ebf642260f3 | ?? | cli/custody-independent.mjs (mine; adds `secrets`, `--owner-read`) |
| 5b0920c37e9ca870b9d87e01ad3ca0c3bcff3d9cff81c3308cd6f5db195708b5 | ?? | test/helpers/erc1271-owner.mjs |
| ea98f406ebd2dcb72cb48c9efb59a636941b9802e5d2939e8a8abc25e2950eef | ?? | test/helpers/owner-read-rig.mjs |
| a2372d71082b83f0fe17080dbeb64bf9f7d3197fabe85c9e6765c073529067a3 | ?? | test/custody-owner-read.test.mjs |
| 4792dae6634ac6b8200dc694ff62f713c8f32a3dbc1ad9077cfc55972bd3bcd1 | ?? | test/custody-secrets-cli-independent.test.mjs |
| 6f66e650470835cd4b58fba9c128f83f85a08d431af76fbb603b7fe6e241852b | ?? | test/custody-cli-independent.test.mjs (only the entry-point test's secrets expectation changed) |
| e0e208d42a3d80e3bf82da05d73b51fc3e274a3f896dc2a90fa653adfa1be885 | ?? | docs/security/custody-owner-read.md |
| ba8b5519c6d1740221e82d5ba7742a9ce49558cf90aa0512e1f7f6bc0f5c9672 | ?? | docs/security/custody-independent-cli.md |
| bcc8b1010096f40f027e4877aeba86c30155d5e5599451634cd8a458799e6d15 | — | work/owner-secrets-interface.txt |
| 116cb98a0be729b0c4067b86b75b9d16d21afee6e823dce2d2ca82539f003833 | — | work/owner-secrets-logs/glue/glue.patch (cli/enclave.mjs glue) |

- **HEAD blobs** of the modified custody files (unchanged since `45801c22`): rules `f92bcadd`, shield-rules `a9be4011`,
  protocol `1c7e041d`, chain `1034c5ba`, custodian `22d51913`, http `08a17ed1`, ingress `7660720e`.
- **Go:** no Go file is edited; no Go code parses rules.
- **Files the coordinator should commit together:**
  - the 7 `M` custody files;
  - `custody/v2/owner-secrets.mjs`;
  - `cli/custody-independent.mjs`;
  - the 2 helpers and 3 test files above;
  - the 2 docs.
  - Then apply the glue patch with the `cli/enclave.mjs` owner.
- **Measured custodian input:** rules, shield-rules, protocol, chain, custodian, http and ingress are in the custodian
  daemon bundle. After the commit, rebuild a NEW candidate from that commit.

**Glue patch.**
- Against `cli/enclave.mjs` sha256 `5c21db40f393806f9da44392c35174d626e580356a7b206c0f30a361e599125d` (current). `git apply --check` is clean.
- It routes independent `custody` and `secrets` to `cmdCustodyIndependent` / `cmdSecretsIndependent`, and removes both
  independent refusals.
- It supersedes `work/custody-cli-logs/glue/glue.patch`.
- I did NOT edit `cli/enclave.mjs`.

## What it does (exact semantics)

**Opt-in.**
- SNP and Shield rules gain one optional boolean, `ownerRead`. Missing means false; only `true` allows.
- Old rules bytes parse, and re-encode, byte-identically. Any other unknown key is still refused. A non-boolean is
  refused.
- `custody set --owner-read on|off` writes it explicitly. Without the flag, existing rule bytes are kept verbatim.
- `custody set` and `custody status` print the capability.

**Protocol.**
- Purpose `enclave-custody-owner-read/1`, domain `"enclave-custody-v2 owner-read\n"`.
- `ownerReadBinding` covers chain, vault, id, policyRev, secretRev, committeeId, epoch, challengeRoot, the ephemeral
  X25519 recipientKey and expiry.
- The owner signs EIP-712 `OwnerRead` with the same fields, in the vault domain. It is not `Update`/`Claim`, so it is
  never a vault write.
- The existing label proof, DLEQ partials, HPKE `sealPartials`/`openPartials` and nonce store are reused. There is no
  new primitive and no signature-derived secret.

**Custodian `ownerRead`.** All facts come from ONE agreed block (`chain.readOwnerRead`). The checks, in order:
1. Shape. Guest fields are refused.
2. The **owner-read**-purpose nonce is consumed. A guest nonce is refused, and the reverse; a release naming a purpose
   gets 422.
3. Expiry: within 300 s.
4. The early budget check.
5. The digest.
6. The agreed read and the per-deployment revision high-water (shared with release).
7. Policy, revisions, committee and epoch are current; the bundle is present; this custodian is a member and holds
   shares.
8. `ownerRead === true`, by the rules' own format.
9. **Not paused.**
10. `beneficialOwnerOf == policy.owner`.
11. The signature:
    - an EOA: 65 bytes, low-s, v 27/28 or 0/1, recovered == owner;
    - a contract owner: ERC-1271 `isValidSignature` == `0x1626ba7e` at that block.
12. The budget is counted (30 per deployment per 10 min, re-checked).
13. The label proof.
14. The partials over `ownerReadBinding`, sealed to recipientKey.

Neither the Enclave wallet nor a host operator plays any role or receives anything.

**Pause guarantee.**
- Paused means nothing is released, to the owner too.
- Refused while paused: `secrets ls`, `rm`, and a merging `set`.
- Still allowed while paused: `secrets set --replace`, `secrets clear`, `custody set` and `resume`; none of them reads.

**Transfer.** Once the ledger moves the deployment, every owner read is refused for the old and the new owner alike.
The new owner `custody claim`s, which destroys the bundle.

**Concurrency.**
- A merging `set KEY` and `rm KEY` write with `expectPolicyRev` = the revision read. The vault's `StaleRevision`
  refuses a concurrent loser, and nothing is lost.
- Every write is read back exactly through the quorum.

**Client.** `custody/v2/owner-secrets.mjs` is shared by the CLI and the browser.
- It uses one ephemeral key per read, zeroed in `finally`.
- Each partial is DLEQ-checked; exactly t are combined.
- It throws "insufficient" below t.

**CLI.** `enclave --independent … secrets ls [--show] | set KEY=… [--replace] | rm KEY… | clear --yes [--payer-key F]`.
- Values are printed only with `ls --show`. Nothing is persisted.

## Tests (serial, `test/helpers/memory-guard.mjs --max-rss-mib 512 --floor-available-mib 16384`, each started at MemAvailable ≥ 18874368 kB, foreground)

| test (tested source = the hashes above) | result | exit | peak tree | start MemAvailable kB |
|---|---|---|---|---|
| test/custody-owner-read.test.mjs (final, `or-final.log`) | 13 pass / 0 fail / 0 skip | 0 | 414 MiB | 19205380 |
| test/custody-secrets-cli-independent.test.mjs | 4/0 | 0 | 499 MiB | 19469452 |
| test/custody-cli-independent.test.mjs (in-process; entry point skipped) | 11/0, 1 skip | 0 | 417 MiB | 18973688 |
| entry point with the glue APPLIED (scratch copy of the CLI closure, `CUSTODY_GLUE_CLI`) | 1/0 | 0 | 498 MiB | 19005396 |
| test/custody-v2-protocol.test.mjs | 8/0 | 0 | 130 MiB | 18976032 |
| test/custody-v2-release-authority.test.mjs | 2/0 | 0 | <sample | 18975224 |
| test/custody-vectors.test.mjs | 2/0 | 0 | <sample | 18970176 |
| test/shield-custody.test.mjs | 8/0 | 0 | 169 MiB | 18911072 |
| test/custody-v2-shield-daemon.test.mjs | 12/0 | 0 | 190 MiB | 18891108 |
| test/custody-v2-e2e.test.mjs | 1/0 | 0 | 384 MiB | 18882768 |
| test/custody-v2-independent-lifecycle.test.mjs | 1/0 | 0 | 339 MiB | 18927244 |
| test/custody-v2-ingress-ratekey.test.mjs (real Caddy, `CADDY_BIN=work/custody-caddy/caddy`) | 1/0 | 0 | 212 MiB | 19135112 |
| test/custody-direct-ingress.test.mjs (real Caddy) | 1/0 | 0 | <sample | 19129244 |
| test/custody-direct-host.test.mjs | 4/0 | 0 | <sample | 19355760 |
| test/custody-e2e.test.mjs (v1) | 22/0 | 0 | 502 MiB | 19391840 |
| test/custody-cli.test.mjs (hosted) | 3/0 | 0 | 348 MiB | 19231888 |
| test/custody-v2-build.test.mjs (bundle/initramfs preparation, no image) | 11/0 | 0 | 399 MiB | 19136508 |

- **Owner-read file (13 tests).** Real anvil, the REAL vault, 3 real `createCustodianV2` instances behind the real
  router over loopback HTTP. Covered:
  - rules opt-in and old bytes;
  - binding domain separation;
  - an EOA read, plus an observer without the ephemeral key, replay and a wrong recipient;
  - `ownerRead` missing or false, for SNP and Shield;
  - an ERC-1271 contract owner, plus a stranger;
  - stale revision, wrong or mixed committee, stale epoch, an expired challenge, bad expiry, the wrong signer, guest
    fields, paused, transfer;
  - purpose separation in both directions;
  - lost quorum (1 down reads, 2 down fails closed);
  - two editors;
  - HTTP 404 on a legacy custodian, plus the ingress matcher;
  - a lying custodian caught by DLEQ;
  - the budget: a stranger can't spend it, and concurrent reads can't overshoot it;
  - high-water: a block rollback (the reader) and a longer fork lacking the update (the custodian).
- The earlier runs of this file were `or-run1` 10/0, `or-run2` 12/0, `or-run3` 13/0, and `or-run4` 12/1. The failure
  was my new fork assertion, before I fixed its timestamps. `or-hw` was 1/0, then `or-final` 13/0.
- `<sample` means the job finished before the guard sampled it.
- Logs are in `work/owner-secrets-logs/`.

## Mutation checks (isolated copy `work/owner-secrets-logs/iso`; each file restored and byte-compared; copy DELETED)

- The isolated baseline passed: 13/0 and 4/0. All 16 mutants were KILLED, each by the intended assertion (logs in
  `owner-secrets-logs/mutants/`).
- Kills, custodian (custodian.mjs):
  - o1 nonce purpose ignored: the signed owner read over a guest challenge was not refused.
  - o2 the `ownerReadAllowed` check bypassed.
  - o3 the paused check removed.
  - o4 the beneficial-owner check removed.
  - o5 the EOA signer check removed.
  - o6 the ERC-1271 check removed.
  - o9 a release naming a purpose was accepted.
  - o13 the custodian's owner-read high-water removed: the longer fork was not refused.
  - o14 the budget counted before the signature: the stranger's 31st request hit `rate_limited`.
  - o15 the concurrent re-check removed: 3 ok instead of 2.
  - o16 the expiry window removed.
- Kills, protocol (protocol.mjs):
  - o7 the expiry unbound from the binding.
  - o8 the recipientKey dropped from the typed data.
  - o10 DLEQ verification disabled. The lying partial then fails at decryption (`invalid ghash tag`), so it still
    fails closed.
- Kills, CLI (cli/custody-independent.mjs):
  - o12 `--owner-read` ignored.
  - o17 `ls` always shows values.
- Mutation findings that changed tests:
  - o13 first SURVIVED: the reader's block high-water hid the custodian check. Test 13 now covers a longer fork.
  - o1 first died at the signature, not the purpose check. Test 7 now leads with the signed case.

## Source-review fixes made in this session

1. **Rate budget DoS.** The per-deployment owner-read budget was spent before the signature check, so any client with a
   challenge could exhaust the owner's 30 reads per 10 min. Now only owner-signed reads count, with a re-check against
   concurrency. Tests and o14/o15 cover it.
2. **Docs and interface.** The v-byte acceptance and the two rollback layers are now documented accurately.

## Remaining blockers and limits (precise)

1. **New measurement.**
   - The custodian daemon bundle inputs changed. No custodian serves owner reads until all of these happen:
     - source review;
     - a commit;
     - a NEW candidate build from that commit;
     - the committee's `code-approve`.
   - `ee8beb38` lacks it, and its legacy router answers the new routes 404 (tested). Clients then fail closed with
     "insufficient".
2. **Glue.** The `cli/enclave.mjs` owner (the move worker or coordinator) applies `glue.patch`. It is tested applied,
   in a scratch copy only.
3. **Browser.**
   - The browser worker integrates per interface §8.
   - The custodian router sends no CORS headers. A cross-origin browser needs an ingress or same-origin decision; the
     custodian checks are origin-independent.
   - No site file was edited.
4. **Remote signer.** Worker 68341 owns the remote signing adapter. This module needs only `{ address, signTypedData }`
   with viem-shaped typed data (BigInt fields; EIP712Domain to be added for `eth_signTypedData_v4`). None of their files
   were touched.
5. **Hardware.**
   - All custodians were synthetic and in-process. No SEV-SNP or Shield hardware ran, and no guest was released by a
     real enclave.
   - The ERC-1271 owner is a local test contract on anvil, not a real wallet or passkey account.
6. **State is in memory.** The rate budget and the nonces are in-memory per custodian: a restart resets the budget.
   High-water uses the existing highWater store.
7. **EIP-7702 owners.** An EIP-7702-delegated EOA owner has code, so it takes the ERC-1271 path. It fails closed if the
   delegate lacks 1271.
8. **Ingress.** Real Caddy forwarding of the two new routes is asserted on the generated Caddyfile matcher only. The
   real-Caddy suites pass for the existing routes.
9. **Custody v1.** v1 `parseRules` now also accepts the `ownerRead` key. v1 has no owner-read path, so the key has no
   effect there.
10. **After a clear.** A merging `secrets set` after `clear` reports nothing to read; use `--replace` or `custody set`.
