# metal-iso0 node image N2 (the next chain rev's node half): plan

enclave-63, 2026-09-26, for enclave-87. This is a plan only; nothing has been built.

- Same shape as N1 (the N1 plan is 4b4f91e9).
- 87 has made N2 REQUIRED: the next chain rev ships WITH it.
- **Chain inputs, from 53's cut (finished 06:47:28Z, built twice, byte-identical):**
  - Release **R = aee2059ffcc7bd8a459001cba02a7e9139d6a4aa964fd6de68047407f8597532**.
  - Image commit: isolation/seccomp-evidence **4cd26e58** (47b7b520, bf GO, plus b4's removal of f7888d86 from the tables).
  - Release dir: `~/enclave-bench/pub-0181bce3/cut-4cd26e58/release-4cd26e58`. Against 5db18199, only front (b4f56fed) and init (b8aa8dcb) differ.
  - 53 re-cuts if b4's manifest names another head.
  - The blobs 53 sent match this plan: judge.mjs 460dda8f (sha256 650b931d), supervisor-guestcert.mjs 00a8bbd9 (sha256 1b91d464), runtime.mjs 22842ed5, snp-verify.mjs 7358e26c.
  - The judge retires f7888d86, so this tree ships only with rs-10 in place. It is: rs-10 was ACCEPTED at 06:29:45Z.

## 1. What N2 is

- **Build commit.** A MERGE of N1's 2492e683 and the chain head (4cd26e58, or the head 53 cuts from).
  - It goes on a new branch, `isolation/node-image-n2`.
  - `git merge-tree` shows it merges CLEAN, with no manual resolution. Merged tree c396ae32 for 4cd26e58.
  - Reviewers check that the merge commit's tree equals `git merge-tree --write-tree 2492e683 <chain head>`.
- **Changes in the 8 overlay files, against N1:**

| overlay file | N1 | N2 (merged) | from |
|---|---|---|---|
| supervisor.js | 82bba076 | 16ca64c4 | N1's retry + the chain's certificate log line (`runtime W^X UNMEASURED: legacy release …`) |
| isolation/m4/guestd/supervisor-guestcert.mjs | 547cd430 | 00a8bbd9 | names the relay prediction's release to the judge. This came in with the 0c087de8 part of the chain (bf+5d GO) and is unchanged since, so it is new to the NODE but not to the chain. |
| isolation/m2/judge.mjs | 13fb51ed | 460dda8f | per-release W^X (LEGACY_WX_RELEASES = the 2 KAT releases) + per-release seccomp (SECCOMP_UNSTATED_RELEASES = those 2 + 5db18199) |
| the other 5 | = | = | |

- **Not in the image:** `metal/` and `wasm/` are unchanged from N1 (gsup, prefix-map, launcher). The chain's guest and guestd changes are not in the node image either: dominit, the front, the monitor, guestd main.go.
- **Build proof, as for N1:**
  - two different-path builds, byte-identical;
  - a hand measurement equal to the manifest;
  - a cpio diff against N1 (dist-iso-2492e683) showing EXACTLY app/supervisor.js, app/isolation/m4/guestd/supervisor-guestcert.mjs, app/isolation/m2/judge.mjs and opt/metal/manifest.json;
  - a reviewer reproducing the measurement from their own path.

## 2. What the node's judge then accepts

The node's certificate pass attests each guest itself and names the release the relay prediction matched. With N2's judge:

| guest | stated form | accepted as |
|---|---|---|
| 5db18199 (today's canaries) | attest-time W^X, no seccomp | runtime-covered; seccomp NOT positively attested (listed) |
| R (next rev) | attest-time W^X + `seccomp=<hash>` | runtime-covered + stated filter |
| 5c3561f9 / 6f14ce75 (legacy-tree KAT) | legacy W^X, no seccomp | runtime-unmeasured (listed in both tables) |
| f7888d86 | – | refused (retired by rs-10 and not listed) |

- **Compatibility.** N2 tolerates the live 5db18199 guests AND R's guests, so it can go before or after S9 without breaking certificates.
- **Rollback.** Rolling N2 back to N1 (the old judge accepts all of these) is always safe.
- **The judge needs no new caller input.** The seccomp hash identifies the program and gates nothing, and the release comes from the prediction, as with 0c087de8.

## 3. Order with the chain rev (proposed)

1. **53 cuts R.** Reviewed; 5d and bf reproduce it.
2. **rs-11 (e3):** the relay's PREDICT, DOMAIN and CERT add R beside 5db18199. **Batch N2-a (the node allowlist add) into the same api-relay restart:** one restart instead of two.
3. **N2 build and review.** Can run in parallel with 1–2; it needs only the chain commit.
4. **N2-b:** node swap to N2, from N1 if N1-b has run, otherwise from f6cbd75a.
   - Preflight and post-checks as in N1.
   - Acceptance: one hookbin owner restart. The node's certificate line must read `guest attested`, with the judge naming 5db18199 (seccomp unstated, listed), and the retry timing from N1 must hold.
5. **S9 (guestd + tree switch to R):** the chain's guestd main.go refuses to start without `-isolation-release`, which is already set (N4 read, 06:3xZ).
6. **e8:** the canaries onto R, one at a time. New proof: the attested self-test states `seccomp=<64 hex>`, and the node's certificate line for each R guest comes from N2's judge.
7. **rs-12:** retire 5db18199. The paired table change (5db18199 leaves SECCOMP_UNSTATED_RELEASES) goes into the rev after, on both the guestd tree and the node image.

**Why N2 before S9:** the first R guests are then certified by the next-rev judge from the start. That is the judge.mjs pairing rule, and e8 proves it. It also keeps S9's rollback independent of the node.

**If N1-b has not run by step 4,** N2 subsumes N1 (N2 contains the retry). 87 may then skip N1-b and swap f6cbd75a → N2 directly. The default stays N1 first, as approved.

## 4. Swap mechanics, gates and rollback

Identical to N1 §3:
- output under `~/enclave-prod/dist-iso-<merge8>`;
- the config dist swap plus one node restart;
- the launcher and drop-in unchanged;
- MemAvailable − 6144 ≥ 16384 + pendingMiB, and PSI 0;
- the canaries on their current keys (lib-e7 until e8);
- rollback: restore the config backup, keeping the previous image and its allowlist entry for 72 h.

## Open

- The final chain commit, if b4's manifest moves the head (53 re-cuts and tells me; the N2 merge then uses that head).
- Whether b4's manifest adds anything node-side beyond judge.mjs and supervisor-guestcert.mjs. At 4cd26e58 it does not: no other overlay file changes.
