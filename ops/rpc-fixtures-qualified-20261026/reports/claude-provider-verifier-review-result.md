# Provider-verifier composition review: G5 result

Stage: `provider-verifier-composition-review-stage/` (patch/, work/a, work/b, jobs/). The r12 ACTIVE run `rpc-runtime-composition-stage/r12/run/r4-20261026T031250Z` was read only. I ran no tests, builds, queue jobs, network, SSH, live actions or commits.

## Verdict: the fixture message is stale. This is not a security regression.

- **Failure** (`logs/final--verifier--test_attested-chain-verifier.test.mjs.out:75-91`): `not ok 13 - G5`, `trees/final/test/attested-chain-verifier.test.mjs:381`. The case is `{"chainVerifier":"http://127.0.0.1:1/"}`. The code threw `provider chain authority: chainVerifier is not used with chainAuthority "attested-verifier" (a local verifier is a different authority): remove it`, which does not match `/chainVerifier \(a local verifier\)/`.
- **Source**: the verifier lineage `attested-authority.mjs` (069b98e6…, the same in image-a, image-b and trees/verifier) said `chainVerifier (a local verifier) is not used with…`. The final source (6ee6dc6e…, from the route lineage) rewords it to the text above. The gate is unchanged:
  - same predicate (`cfg.chainVerifier !== undefined`);
  - same position, after the `rpc` refusal and before the paid, `txBackend` and `attestedVerifier` parsing;
  - still synchronous, and it throws before `createAttestedVerifier`, so no client exists and no fallback can be called.
- **Paid case**: the gate changed on purpose. The old rule was "paid always refused". Now a paid provider is refused unless it has `txBackend` (the operator's own node, used for submission only), as documented in the source header. The old regex `/paid provider/` still matches the new message, so it is not the failure. The patch makes it the exact documented cause.
- **Documented gate**: the final route test asserts the same new messages (`trees/final/test/attested-route-composition.test.mjs:99-100`: `/chainVerifier is not used/` and `/paid provider with chainAuthority "attested-verifier" needs txBackend/`). It passed 7/7 against final in r12.

These protections are all unchanged in final:
- one authority, with no mixed RPC, local verifier or policy RPCs;
- the host-policy refusal under `verifier`, plus the refusals for attested `platformHostPolicyRpcs` and `platformHostPolicy.{rpcs,minAgree,chainAuthority,chainVerifier}`;
- admin, ban and policy checks, which still go through one verified snapshot;
- the refusals for paid-without-`txBackend`, unpaid-with-`txBackend`, and `txBackend` outside attested mode;
- no configurable roots (`roots` field, per-replica `roots`).

No product fix is needed.

## Patch (test only)

`patch/g5-exact-cause.patch`: one hunk in `test/attested-chain-verifier.test.mjs` @@ -372,14 +372,15 @@.
1. The chainVerifier case now asserts the exact documented cause, ending in `…(a local verifier is a different authority\): remove it`. Its URL changes from `:1` to the recording upstream's port (`up.port`).
2. The paid case now asserts `/a paid provider with chainAuthority "attested-verifier" needs txBackend/` instead of `/paid provider/`.
3. A new assertion follows the refusal loop: `assert.equal(up.seen.length, 0, …)`. No refused config reached the upstream or the named local verifier. `up.seen` exists in `recordingUpstream` (line 123-130).

No assertion is weakened, and none is made a generic throw. All the other cases are byte-identical.

| file | sha256 |
|---|---|
| before: work/a/test/attested-chain-verifier.test.mjs (459 lines), the same as trees/final, trees/verifier and image-a/b | e439642ae156b00c0d69114627b424e36539a30376bc6d23e2cb63b2b515f957 |
| after: work/b/test/attested-chain-verifier.test.mjs (460 lines) | 2a2968e64205f5ab00ac770ea4d3adeebf9f7f7f3f6e5ce1393aff67b538cf9b |
| patch/g5-exact-cause.patch | 478bc424a2d431928962a3d4e48280e398d571b37cf7695609b0254dc0ffc652 |
| trees/final/network/wg-provider/attested-authority.mjs (pinned, not modified) | 6ee6dc6edda978b306f8363ffcb30174bd9fca3e3670b5d26b8387d121b884eb |
| trees/final/test/attested-route-composition.test.mjs (pinned, not modified) | f4fd60a8b77b47d65a6a29220c71687fcdb0fda4d9fe6d0dd31367cd6daa6387 |

## Root runner: `provider-verifier-composition-review-stage/jobs/root-run.sh`

The runner:
1. Checks every input hash and hashes the frozen final tree.
2. Copies it to `jobs/scratch-<ts>`.
3. Runs a negative control on the unpatched copy. It expects 14 pass and 1 fail, the failing subtest must be G5, and the actual error must be the documented message.
4. Applies the patch (dry run first), checks the after-hash, and checks that only that one file differs.
5. Runs the patched tests and checks the frozen tree is unchanged afterwards.

Expected counts in step 5:

| test | expected |
|---|---|
| attested-chain-verifier | 15 pass, 0 fail |
| attested-route-composition | 7 pass, 0 fail |
| metal-measured-control | 15 pass, 0 fail |
| attested-paid-provider | 11 pass, 0 fail |
| attested-provider-collateral | 8 pass, 0 fail |
| host-services-agent-verifier | 5 pass, 0 fail |

Any mismatch exits non-zero. Outputs go to `jobs/out-<ts>/SUMMARY.txt` and the `*.tap` files.

## Claims I could not verify (nothing was run)

- I have not confirmed the patched G5 passes, or the 15/0 and 7/0 counts. That is the root run's job.
- I don't know whether `guest()` boot or the refused constructions send traffic to `up`. Code reading says no: every refusal is synchronous and comes before the client exists. If the new `up.seen.length === 0` check fails, it means a refused path or the guest made a call. Diagnose that; don't delete the check. The check is synchronous, so it cannot catch a delayed async call. That cannot happen here, because no client is created.
- The runner uses `node --test --test-reporter=tap <file>` from the scratch root. I did not see the exact r12 invocation, so its flags or env may differ.
- I have not confirmed `cp -a --reflink=auto` of trees/final into the scratch copy, including whether node_modules or links resolve there (esbuild is needed by the packaging subtest).
- The stack choice is mine: the verifier and route rows from RESULTS.tsv. I did not include the leaseRelay `lease-relay-host-policy` row, which has BASELINE-NOT-CLEAN at 0/9 in both component and final. That is a separate issue I did not investigate.
- I did not review the earlier session's work/ and patch/ files beyond the diff and hashes above. They match each other exactly.

## Manifest

`provider-verifier-composition-review-stage/MANIFEST.sha256` (relative to the stage):

```
478bc424a2d431928962a3d4e48280e398d571b37cf7695609b0254dc0ffc652  patch/g5-exact-cause.patch
e439642ae156b00c0d69114627b424e36539a30376bc6d23e2cb63b2b515f957  work/a/test/attested-chain-verifier.test.mjs
2a2968e64205f5ab00ac770ea4d3adeebf9f7f7f3f6e5ce1393aff67b538cf9b  work/b/test/attested-chain-verifier.test.mjs
b395d65d928f9b5871bd5c27c1f9e77ec96adab3dd50bfb959e1fb1abf63af90  jobs/root-run.sh
```
The runner script passed a syntax check (`bash -n`). It was not executed.
