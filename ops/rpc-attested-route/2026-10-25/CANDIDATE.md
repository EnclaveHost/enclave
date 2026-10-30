# Attested route composition: RESULT (source only)

**Scope.**
- Not done: no image, canary, SSH, live access, key read, commit or push.
- Every build and test ran through `work/claude-test-queue.py`: cap 1024 MiB, 16 GiB floor, peak 706 MiB.
- Jobs and logs: `attested-route-stage/jobs`, `attested-route-stage/logs`. The final run is **r5**; r4 holds the parity and
  flake controls.

## Roots and hashes (all four dependencies)

| input | value |
|---|---|
| route base | `attested-route-source` @ `94a639558` (clean route publication; branch `fix/rpc-attested-route-composition-20261025`) |
| reviewed attested source | `e0dfe98aa` (tree `f569dfee3e35`); patch `attested-verifier-stage/committed-e0dfe98aa.patch`, sha256 `6414b373f71449bf55eb3e7c1f67bd4bcde225ebd0c94d3e33563d5db1de2897` |
| image lineage for the guest-verify bundle | `git archive e0dfe98aa` → `attested-route-stage/image-src-e0dfe98aa` |
| dependencies | `node_modules`: a hard-linked REAL copy of `route-source/node_modules` inside the tree (builders refuse inputs outside it). **Not committed**; shared packages untouched |

## Composition decision (why it is NOT a blind patch apply)

The two lineages share no history:
- The route lineage's whole `metal/` tree is OLDER: every differing metal file is an older form, there are no route-only
  metal files, and it has no rpc-runtime or witness-gateway.
- So the **verifier IMAGE stays in the control lineage (`e0dfe98aa`)**, and route's metal sources are NOT overwritten
  (that is root's image composition).

The route lineage gets the EXIT/PROVIDER side:
- The image lineage's exact guest verification (statement, config canonicalization and digest, HOST_DATA, SNP via the
  unchanged `verifier/snp.mjs`) comes in as a **pinned generated bundle**: `scripts/build-attested-guest-verify.mjs`
  builds it from the e0 export, and its manifest names the image commit and every input sha.
- It is **reproducible:** an independent second export at another depth gives byte-identical output (r4, r5). It is built
  whitespace-minified with `absWorkingDir` = this repo, so the bytes do not depend on where the tree sits.
- The verifier crypto files are byte-identical in both lineages (`verifier/snp.mjs`, `collateral.mjs`, `envelope.mjs`,
  `relay/snp-verify.mjs`).

## Source delta

- **Full diff:** `attested-route-stage/logs/attested-route-source.diff`, sha256 `6453744cfb66cc718461a1a55a38bbd28004cf3b78ae2772a0d75fea362262b1`.
  It is the tracked diff plus the new files, excluding `node_modules` and the untracked host-service packages.

| file | HEAD → new blob | change |
|---|---|---|
| network/lease-reader.mjs | d77dbf772c → ce157773ac | e0's hunk (same base blob): attested label, `localProof: false` |
| network/verified-chain.mjs | 258ea3f14e → 9cebf6e70d | e0's label hunks, applied surgically onto route's newer copy |
| network/service-index.mjs | d7350364a4 → 1af8893527 | the explicit bootstrap's "two or more RPCs" rule is skipped ONLY for `chainAuthority: "attested-verifier"` (otherwise unchanged) |
| network/wg-provider/main.mjs | 1c497f7de7 → 6d119a7fac | details below |
| network/wg-provider/attested-authority.mjs | new 4973d78e2e | details below |
| network/attested-verifier-client.mjs | new e1e0d0abcc | e0's client; imports the image-lineage verification from the bundle; adds a programmatic-only `verifyNow` clock (for the CRL-expiry test) |
| network/attested-verifier-brand.mjs | new 7372f053bb | e0 copy |
| scripts/build-attested-guest-verify.mjs | new 669e1177d8 | the reproducible builder, with `--check` |
| network/attested-guest-verify.bundle.mjs (+ manifest) | sha256 86a3e099dd5163e3276187106c6aee9de80a33536851269c8e60342c65dfa2f4 (manifest 4a979a7e53a064387beb3a73f9580e6a18bd612eda67547fed3b21d96472af53) | generated, image commit e0dfe98aa |
| test/fixtures/attested-guest-image.bundle.mjs (+ manifest) | sha256 a9476d411c01c32f9bd9e9c7f37e85e17e71618c85d6bcf62b4c1a0a379b571d | generated; guest side for tests only |
| windows/node/host-admission.bundle.mjs | sha256 9825a9a2… → d18f88b0466f27d490a2d1ecc79df545ee89b13d603f579eb13ae96019e97eb8 | REGENERATED: `--check` was stale on the candidate only and current on HEAD |
| metal/guest/host-policy.bundle.mjs | sha256 228d4cf0… → 651a18efe64b83f8f732bea0e1b577a19b99ed55577e6481bbc0af2aaf413cd4 | regenerated, same reason |
| test/attested-route-composition.test.mjs | new 9e5793ec97 | 7 tests |

`network/wg-provider/main.mjs` uses `providerChainAuthority` for the `LeaseReader` and `providerHostPolicyRuntime` for
host-services admission. Raw RPC clients exist only under the quorum. Messages and quorum behaviour are unchanged.

`network/wg-provider/attested-authority.mjs` (route G5):
- **Choices:** quorum (unchanged) or attested-verifier. One client serves BOTH the LeaseReader (registry, app leases, owner
  signatures: EOA/ERC-1271/SessionVault) AND the host-services admission runtime (anchor, current owner, ban/unban,
  sequence/rollback, persisted state) through `verifiedHostSnapshot`.
- **Refused:** `rpc`, `chainVerifier`, paid providers, unknown/root/status fields, relative paths, policy RPCs, and a
  policy-level chain authority.
- **Collateral:** the pre-seeded files (`fileCollateral`), optionally layered over KDS.
- **Policy documents:** still from the mirrors (untrusted transport).

## Generated bundles: --check on the candidate and on a clean HEAD worktree (r5)

| builder | candidate | HEAD |
|---|---|---|
| host-admission | stale → **regenerated, current** | current |
| metal-lease-gas | current | current |
| windows-lease-runtime | fails | fails identically |
| platform-api-guest | fails | fails identically |
| mcp-guest | fails | fails identically |

The last three fail identically on HEAD: pre-existing in this lineage, not caused by this change, and not regenerated.
Untracked build outputs `relay/network-runtime.bundle.mjs` and `network/host-service-packages` were built for the tests
only.

## Tests (strict per-file runner: any fail, cancel or skip fails the file)

**`test/attested-route-composition.test.mjs`, r5: PASS 7/7, 0 skipped.**
1. **One explicit authority:**
   - quorum unchanged;
   - the "verifier" mode is refused (not offered by this lineage's provider);
   - refused alongside the attested authority: `rpc`, `chainVerifier`, paid, roots/status, relative paths,
     `platformHostPolicyRpcs`, and a policy-level rpcs/chainAuthority;
   - "off" stays the explicit development switch.
2. **Host-services ADMISSION through the attested verifier with every public provider DOWN:**
   - admit, admin ban, unban;
   - after an owner rotation, a document the PREVIOUS owner signed and anchored never admits; the current owner's ban and
     unban apply;
   - an anchored ROLLBACK is refused, and the re-anchor admits;
   - zero public-provider requests;
   - a verifier outage or failed proof gives no admit, still with zero public requests (no fallback), then recovery.
   - *Note:* the runtime's 30 s production decision cache is disabled in the test (`ttlMs: 0`) so that each step is a
     fresh decision.
3. **PARITY:** the attested runtime and the legacy QUORUM runtime (the same `createHostPolicyRuntime` over the world's own
   RPCs) give **identical decisions at all 8 steps**: admit T, ban F, unban T, previous-owner document F, current-owner ban F,
   current-owner unban T, rollback F, re-anchor T.
4. **Owner reads through the provider's reader, built as main.mjs builds it:** ERC-1271 owner true / other message false;
   SessionVault via `factory.isVault` → `owner()` → ERC-1271 true / wrong factory false; a verifier proof fault gives false
   (no fallback); real minimal contracts on anvil.
5. **Collateral PRE-SEED:**
   - the provider's own `fileCollateral` dir (`amd/Genoa-cert_chain.pem`, `amd/Genoa-crl.der`,
     `vcek/<product>-<chip>-<tcb>.der`) gives a FULL attestation;
   - the SAME files judged past the CRL's `nextUpdate` (programmatic clock) REFUSE (fail closed) and requests are refused;
   - relative and malformed collateral configs are refused.
6. **The PACKAGED provider:** the source `main.mjs` AND an esbuild bundle of it (as install ships `wg-provider.mjs`), with
   the explicit bootstrap shape:
   - `--check-config` reports `attested-verifier`;
   - a mixed config exits non-zero with the refusal;
   - the quorum config still reports `quorum`;
   - the bundle carries exactly one brand registry.
7. **Packaging:** separately bundled reader and client share one brand; a plain object stays `local-verifier`.

**Existing affected route suites, r5: 25 files, 227 tests, 204 pass, 7 fail, 16 skipped.**
- Every failing or skipping file was re-run on a clean HEAD worktree (`--tree`, same real dependencies). **All of them fail or
  skip identically there:**

  | file | candidate and HEAD |
  |---|---|
  | host-services-carriers | 3/9 |
  | lease-reader-verifier | 8/9 (settlement quorum) |
  | host-service-verifier-roles | 3 skipped |
  | hosted-policy-cold-start | 5 skipped |
  | public-rpc-https | 5 skipped |
  | lease-relay-host-policy | 3 skipped |

- These are pre-existing in this lineage's environment. They are NOT counted as passes, and their causes were not
  investigated in this task.
- Everything else passes: `service-index` 15/15 (including install.sh and `--check-config` with the explicit-bootstrap
  change), lease-reader 31/31, verified-chain 9/9, host-admission-retry 9/9 (the regenerated bundle), management-plane
  39/39, platform-host-policy 11/11, and the rest.
- **platform-host-policy** failed one case once (r3: "an older signed one"). Its r4 control passed 3/3 on the candidate and
  3/3 on HEAD, so it is classified as an intermittent failure, not a regression, and is still reported.
- The **t5 service-index baseline failure** of the e0 tree (a missing historical object) does not occur in this route
  lineage: 15/15 here. No fixture change was needed.

## NOT done / limitations (explicit)

1. **Paid providers are NOT supported with the attested authority:** refused at config, never silently degraded.
   Reusing a bound own-backend submission route was not implemented: a receipt/nonce-tested submission path is needed
   first. Not a completion.
2. **Synthetic only:** the SNP chain is synthetic (the real AMD pin refuses it). The verifier stand-in checks NO MPT
   proofs. The policy chain is the scripted policy world. The ERC-1271/SessionVault contracts are minimal hand-assembled
   ones with the real call shapes. The supervisor behind the guest front is a stand-in (the REAL supervisor's verifier-only
   boot is tested in the image lineage, e0dfe98aa).
3. **Image composition is root's.** The route lineage's metal sources are untouched; the relay worker's measured-control
   changes live in its own tree.
4. **Exit reachability and AMD seeding are ops work:** the static WireGuard carve-out, and seeding the real AMD collateral
   files and refreshing CRLs. An expired CRL fails closed, and the refresh operation is not built.
5. **Generated bundles that fail on HEAD too:** windows-lease-runtime, platform-api-guest and mcp-guest `--check` fail
   identically on HEAD and were not regenerated.
