# Custody v2 dashboard: prepared site release (worker R, 2026-10-23). BUILT + VERIFIED OFFLINE; NOT uploaded, mirrored, activated or published

**Release `bafybeiax6ngccp7bxoiex5pqv2yoz2ekfk227pthlzfrqkv32v6jt7stmi`** in `release/<CID>/`.

| | value |
|---|---|
| `release.json` | `fbcad18437465a7d38ce455097f33054cbe342e07881cc4c859c5db07e7d194a` |
| CAR `site.car` | `1552ee6cc13cf8e1d1219d9e5d78093cd9792aa4124486a1e33007ddfdbfdd98` (46 989 997 bytes) |
| root block | `17f34c213fe1bb904bf5f0aeb0ece88a2ab5afbe675e4b182abbd57c99fe5362` |
| `headers.caddy` | `079b9035eef3758228f094232bef368406632c2233c07c91a6294405a6adcab5` |
| built | 2026-10-23T20:23:43Z |
| source | commit `e24a47fb` (clean) |
| base | `bafybeig3rai3…` |
| files | 890 |

**Custody v2 is INERT in this release.** Production's address book names no `secretVaultV2`, so the panel shows "custody v2:
UNSET … No v2 action is offered" until the administrator's book activation. Custody v2 today is a SINGLE-SEAT bootstrap
(n = 1, t = 1, W = 1). Nothing here is decentralized custody or full parity with v1.

## 1. Base: established, with evidence
- **What the fronts serve.** A bounded public read through the queue (`evidence/public-read.json`, 2026-10-23T20:20:51Z) found:
  - `https://enclave.host/` and `/index.html` sha256 `d253ac83…`. This equals root's 20:05 read and
    `logo-site-hotfix/final/site/index.html`.
  - `/dashboard.html` `0da63cbf…`, equal to the same tree's; Last-Modified Tue, 20 Oct 2026 02:20:32 GMT.
  - No `/.well-known/enclave-site-release.json` (404).
  - So the fronts serve the **logo hotfix `bafybeig3rai3…`** (`work/logo-site-hotfix/final`, cid.txt). It has no ledger.
- **The IPNS pointer is currently UNKNOWN.**
  - The publisher `d9798e4c…/api/status` now reports `sequence 0`, `value ""`, `mode http-only`. It has no record since the
    NucBox restart.
  - The last known value (10-22) was `bafybeieuxt6…`. All 482 of its chunks are in the hotfix base, byte-identical (10-22
    stage coverage).
  - Root should confirm what IPNS/ENS resolves to before publishing (see §5).
- **Unpublished candidates are not the base.** The 10-22 staged release `bafybeifkfgxsjz6…` was never uploaded
  (ROOT-REVIEW.json), so it was not used.
- **Lineage rules kept.** No `--no-base`; no `--base-built-at` (ledgerless base). Every one of the base's 650 chunks is kept:
  646 inherited byte-identical plus 4 rebuilt byte-identical. All 6 CSP hashes are kept. Retained until 2026-10-25T20:23Z.

## 2. Source provenance
- `src/` = clone of `work/custody-v2-dashboard-20261023/repo` at **`e24a47fb22399b220d25f4e3b8d544083b13fdb0`**, clean before and
  after the build. The regenerated artifacts are byte-identical (`logs/post-build-status.txt` is empty), so the stamp is
  `e24a47fb · 2026-10-23` with no `*`.
- Lineage: `e24a47fb2` → … → `ff13ebe08`. That is the reconciled site artifacts on the reviewed wallet-route production line,
  which includes merge `e078490da` of published main **`68b82926`** docs.
  - The built bundle carries the wallet route's refusal strings (checked).
  - The custody v2 commits are the 10 in `work/custody-v2-dashboard-20261023/patches`.
- A later docs-only commit, `2d3839c54`, corrects docs/security/secret-custody-v2.md (below). `docs/` is not in the site
  build, so the release bytes are those of `e24a47fb2`.

## 3. Checks (all through the queue)

| check | result |
|---|---|
| `tools/build-and-check.sh` (`logs/build1.*`, 403 MiB, EXIT 0) | <ul><li>vendor bundle `--check`: match</li><li>offline `build-site`</li><li>`prepare` with "dropped as expired: 0 chunks, 0 CSP hashes"</li><li>`review`</li><li>`verify`</li></ul> |
| `tools/release-check.mjs` r3-custody (`check/release-check.json`: RELEASE-CHECK-OK, failures [], no new origins) | See below. |
| `tools/inert-smoke.mjs` (`check/inert-smoke.json`: INERT-SMOKE-OK, 391 MiB) | See below. |

The release check is the 10-22 stage's r2 checker, with these changes:
- Expected commit `e24a47fb`, clean.
- Media / config-read moved to REPORTED (both absent; see §4).
- Added the wallet-route strings and the custody v2 checks:
  - `vendor/custody-v2.js` equals its manifest `e4fe3ebd…` and the source bundle;
  - the panel is in current chunk `js/chunks/chunk-KUSLTBER.js`, with the single-seat, unset and factory-gate wording;
  - the vendor is loaded at runtime, not inlined, and its path resolves;
  - no production vault address appears in page code.
- It also re-checks:
  - the release tree against `release.json`;
  - the ledger;
  - base retention;
  - pages and pins;
  - the local reference closure;
  - platform moderation strings.

The inert smoke serves the release offline with its own headers in headless Chromium; every external request is aborted.
- `/`, `/apps`, `/credit/`, `/recover/` and `/dashboard`: 200, no page errors, no CSP refusals, no local failures.
- The **built** `c-deployments` component's own `_secretsWire` was clicked on panel markup:
  - With a book cache equal to production's entries (no `secretVaultV2`), it paints "// custody v2: UNSET - the
    EnclaveAddressBook names no secretVaultV2 (unset). No v2 action is offered here." No v2 button is shown.
  - Control (`secretVaultV2` = 0xE486…, RPCs cut): it paints UNREADABLE, with no v2 button.

**Not rerun, by design.** The source suites (passed at `e24a47fb2`: fixture 10/10, browser 2/2, real-contract 2/2, mutants
9/9) were not rerun. The anvil e2e `test/site-built-wallet-route.test.mjs` was not run either: it needs a full Foundry build
over 1536 MiB.

## 4. Composition gaps (root decision; nothing here regresses LIVE)
- **Media fallback `04836638` and verified config read r4 `bad58bd8`** are NOT in this release.
  - Both were accepted for the never-published 10-22 stage `bafybeifkfgxsjz6…`. Neither is in the live hotfix either
    (checked by marker).
  - Media applies cleanly to `e24a47fb2` (`patch --dry-run --fuzz=0`).
  - Config-read r4 FAILS: `site/js/core/catalog.js` hunk 2 at 254, against the wallet-route line. It needs a port and
    re-review.
  - Including them means a new commit and a rebuild. I did not do that: it is outside this finite scope.

## 5. Deployment (root only; nothing here was run)
1. **Approve.** Check the CID and `release.json` sha above (`site/deploy.sh review|verify release/<CID>`).
2. **Fronts.** `site/deploy.sh deliver --release release/<CID> --targets <targets file> --approve bafybeiax6ngccp7… --journal <dir>`
   (mirror to every target, then a fenced, journalled activation; or `mirror` then `activate`).
   - Probe afterwards: `/` stamp `e24a47fb · 2026-10-23`, `/.well-known/enclave-site-release.json` present, the dashboard
     Secrets panel showing custody v2 UNSET.
3. **IPNS (owner signature).** First establish the publisher's current state; it reports sequence 0 / http-only now.
   - Then run `site/deploy.sh publish-plan --release release/<CID> --publisher-config <file> --deployment
     0xd9798e4c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a --out <dir>`.
   - The owner's `setConfig` value is `/ipfs/<CID>`.
   - Check first that the publisher's lease is live and that the full DAG has a holder.
4. **Do NOT activate custody v2 as part of this.**
   - `book.set("secretVaultV2", …)` and `book.set("sessionVaultFactory", …)` stay gated, per
     `work/custody-v2-dashboard-20261023/HANDOFF.md` §4 and ROOT-NEEDS.txt.
   - Gates: lifecycle canaries on the corrected custodian image (`ab589bf8`, image `70aadf…`; startup and reopen only so far)
     and the consumer review.
5. **Rollback.**
   - Fronts: `site/deploy.sh rollback --targets <file> --to bafybeig3rai3tyoimbhb32vo6hkkw3o336wluht7owbs7mefhtiridwp6y --approve bafybeig3rai3… --journal <dir>`.
   - IPNS: the owner republishes the previous value, once it is established in step 3.
   - Book activations were not touched, so there is no custody rollback.

## 6. Doc/handoff corrections (per root 20:19)
`docs/security/secret-custody-v2.md`, commit `2d3839c54`, and `work/custody-v2-dashboard-20261023/HANDOFF.md` now state:
- **Corrected image.** `ab589bf8` (image `70aadf…`) is reproducibly built, with startup and reopen verified on AMD hardware
  at 20:16Z per root. The original `c866…` image is still live.
- **Lifecycle.** There is no release, migration or rotation lifecycle proof yet.
- **Factory.** The live book still has no `sessionVaultFactory`.
- **Policies.** In the sampled set (9 apps plus the old canary), the only policy is the old EOA canary. The exhaustive log
  scan was rate-limited and is incomplete.
- **Activation.** It remains gated.
- **Claims.** No decentralized-custody or full-parity claim.
