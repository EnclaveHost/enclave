# Custody v2 dashboard + media fallback + verified config read: composed site release (worker R, 2026-10-23)

**Status: BUILT AND VERIFIED OFFLINE.** It was not uploaded, mirrored, activated or published, and there was no wallet action.
This package is separate from the earlier one (`work/custody-v2-site-release-20261023`, commit `7681e3f`, release
`bafybeiax6ngccp7…`), which is unchanged. Its errata are recorded there in `ERRATA-20261023.txt`.

**Release `bafybeihm7f2mhw6qn5a3lddqfu4bjleqg6zo6jxset7ni4dsiaamhpgqla`** in `release/<CID>/`.

| | value |
|---|---|
| `release.json` | `b00d5acb3384b50178844da14925bc13d39f49b513ac2bcccd42ec36b1ec5022` |
| CAR | `aa5d95d4233d79489092d85ab5cb22e32c1ea94379bd96ff23892b7336603798` (47 035 092 bytes) |
| root block | `ecf974c3dbd06f41b58c702d3814ac9037b2ef26f224fed470724000c3bcd058` |
| `headers.caddy` | `73b78f44d790d655e4c94a46e0e4a801913b58dfecbee0ef88aa457d3e1bd214` |
| built | 2026-10-23T20:38:01Z |
| source | commit `a942a61f` (clean). This NEW release's footer stamp is `a942a61f · 2026-10-23`. |
| base | `bafybeig3rai3…` (live fronts). The BASE's own footer stamp is `166bf9d3 · 2026-10-19`, not the new one. |
| files | 892 |

**Custody v2 is INERT.** The book names no `secretVaultV2`. Custody v2 today is a SINGLE-SEAT bootstrap (n 1, t 1, W 1).
Nothing here is decentralized custody or full v1 parity.

## 1. Source: one immutable commit chain
Repo `work/custody-v2-dashboard-20261023/repo`, branch `custody-v2-dashboard`. Every commit is by SteveDeFacto and went through
the repo's pre-commit crypto-key scan.

```
9d97b4b003661ad4832fe703dc5649ca807739ed  Docs only, AFTER the build (§7): not in this release; the build commit stays a942a61fd
a942a61fde4a07e6237b859f6ca5f0e1e22e8c33  Site: verified multi-gateway read for pinned configs (accepted r4 bad58bd8)
278a28a7e                                  Site: app media fallback gateways (accepted 04836638)
2d3839c547bba10d31339a8f165425571782dddc  Docs: custody v2 current state (preserved; docs/ is not in the site build)
e24a47fb2                                  custody v2 panel (previous release's source)
… ff13ebe08 (reconciled site artifacts on the reviewed wallet route; includes the published main 68b82926 docs merge)
```

## 2. The "port": no conflict existed
Both accepted patches apply unchanged with `git apply`: no fuzz, no offset, no hand edit. Each result is identical to root's
reviewed result.
- **Media 04836638.** Patch sha256 `04836638e4d2…`.
  - The results match the reviewed bytes: `catalog.js` `2abe00fe`, `app-card.js` `89ebb2a8`, `app-detail.js` `f0d7b056`.
  - `config.js` and `deployments.js` differ from the reviewed bytes only by lines this branch already had (custody v2, wallet
    route). The media hunks themselves are identical:
    - config: `IPFS_IMG_FALLBACKS` = [IPFS_GATEWAY, dweb.link]; independent mode uses the profile's other replicas;
    - deployments: the card art attributes, and `hydrateMedia(body)` after the rows render.
  - These hunks do not touch the custody v2 vault binding, the Secrets panel; `custody-v2.js`, `wallet.js` or the
    ledger/SessionVault send path. The beneficial-owner semantics are unchanged: `custody-v2.js` is byte-identical to
    `e24a47fb2` (`git diff e24a47fb2 a942a61fd -- site/js/core/custody-v2.js site/js/core/wallet.js` is empty).
- **Config-read r4 bad58bd8.** Patch sha256 `bad58bd814a3…`.
  - The results equal root's reviewed results exactly: `catalog.js` `9c4ef0d1`, `storage-plan.js` `6c7d9e61`,
    `unixfs.js` `a4a5ae07`, new `ipfs-car.js` `c21ec11c`.
  - **Correction to my previous report.** The "catalog.js hunk 2 fails" result was an ORDERING artefact: r4 is layered on
    the media-patched `catalog.js`. This branch's `catalog.js` was the reviewed media base `f5e518c9`, so after 04836638 it is
    byte-identical to the reviewed media result.

## 3. Focused tests, with the prior-commit counterexample (queue 512, peak 216 MiB; `logs/focused-{new,prior}.out`)
Harness: `tools/focused.sh`.
- Each run uses a fresh real-copy tree (`git archive` of the commit plus a real node_modules copy).
- The tests are root's reviewed ones, copied unchanged into `test-inputs/` (sha256 prefixes in §6).
- The test-only multiformats oracle is copied from the config-read package; `site/` never imports it (checked).

| file | new `a942a61fd` | prior `2d3839c54` |
|---|---|---|
| media-fallback | 9/9 | 0/9 |
| car-verify-oracle (Python runtime oracle) | 2/2 | fail (no ipfs-car.js) |
| config-deadline | 6/6 | fail (no ipfs-car.js) |
| config-read-fallback | 15/15 | 0/7 |
| models-read-only | 5/5 | 5/5 |
| publish-prefill-config | 5/5 | 5/5 |
| custody-v2-dashboard (fixture; config.js interplay) | 10/10 | 10/10 |

New totals: 52/52, which includes root's reviewed set of 42/42.

The prior commit's failures are behavioural, not only missing functions:
- "forged JSON is rejected for EVERY accepted spelling": prior result "b32: forged everywhere";
- "corrupt content is rejected wherever it comes from": prior result "the first VERIFIED copy wins, not the first answer".

The mutation controls are not re-run here; they are the r4 package's own (`mut3-*`, `mut4-car-nocheck`, …,
`public-config-read-fallback/logs`).

## 4. Release build (one queue job, 1024 cap, peak 433 MiB; `logs/build1.*`)
`tools/build-and-check.sh`:
- vendor `--check` matches;
- offline `build-site`;
- `prepare --base work/logo-site-hotfix/final`: this is the CURRENTLY SERVED base `bafybeig3rai3…`, with `index.html`
  `d253ac83…` and `dashboard.html` `0da63cbf…` matching the 20:20Z public read (evidence in the prior package);
- "dropped as expired: 0 chunks, 0 CSP hashes";
- `review` and `verify`.

The base's 650 chunks: 646 inherited plus 4 rebuilt, all byte-identical; 6 CSP hashes; kept until 2026-10-25T20:38Z.

**Release check `tools/release-check.mjs` (r4-custody-composed): RELEASE-CHECK-OK, failures [], no new origins.**
It is the r3 checker with media and config-read REQUIRED again, as the 10-22 stage required them:
- the markers;
- the config reader `chunk-X4LRPLTG.js` dynamically imports the current `ipfs-car-K7FOKAAL.js` (verifyCar, carCap) and
  `storage-plan-RRHH3AF7.js` (boundedBytes).

It also checks:
- custody v2: `vendor/custody-v2.js` `e4fe3ebd…`; the panel in `chunk-ZQYU6RGM.js`, runtime-loaded with no production vault
  in page code;
- the wallet-route strings and moderation strings;
- the pages and pins;
- the reference closure;
- the ledger and retention.

The two composed features are reported under `composedFeaturesPresent` (both `true`) since checker r4.1 (§7). The r4
report called them `notInThisSourceLine`, a stale name from r3.

**Smoke `tools/inert-smoke.mjs`: INERT-SMOKE-OK.** It serves the release offline with its own headers, in a headless shell;
every external request is aborted.
- `/`, `/apps`, `/credit/`, `/recover/` and `/dashboard`: 200, no page errors, no CSP refusals, no local failures.
- The built `c-deployments` Secrets panel:
  - with production's book entries it paints "custody v2: UNSET - the EnclaveAddressBook names no secretVaultV2 (unset). No
    v2 action is offered here." with no v2 buttons;
  - control (`secretVaultV2` named, RPCs cut): UNREADABLE, no buttons.
- The CAR chunk exports `carCap`/`verifyCar`/`parseCar`/`reconstruct`/`MAX_DEPTH`; `carCap(1 MiB)` = 2 621 440; a non-CAR
  body throws "truncated CAR section".

**Not rerun (by design):**
- the custody browser and real-contract suites: `custody-v2.js` and the custody tests are unchanged since `e24a47fb2`, where
  they passed;
- the full anvil wallet-route e2e: it needs a Foundry build over 1536 MiB.

## 5. Deployment (root only; nothing here was run)
1. Approve the CID and the `release.json` sha above (`site/deploy.sh review|verify release/<CID>`).
2. **Fronts:** `site/deploy.sh deliver --release release/bafybeihm7f2mhw6qn5a3lddqfu4bjleqg6zo6jxset7ni4dsiaamhpgqla --targets <targets file> --approve bafybeihm7f2mhw6qn5a3lddqfu4bjleqg6zo6jxset7ni4dsiaamhpgqla --journal <dir>`.
   Then probe:
   - the stamp `a942a61f · 2026-10-23`;
   - `/.well-known/enclave-site-release.json`;
   - the Secrets panel showing custody v2 UNSET.
3. **IPNS: BLOCKED.**
   - The ipns-publisher reports `sequence 0`, `value ""`, `mode http-only`. Publication through it is not possible until root
     diagnoses and repairs it (after the current custody tests).
   - Its status says nothing about what the IPNS name currently resolves to, so this release must not be called published.
   - When it is repaired, the plan is:
     `site/deploy.sh publish-plan --release release/<CID> --publisher-config <file> --deployment 0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a --out <dir>`
     (a 32-byte id: `0x` + 64 hex). The owner signs `setConfig` value `/ipfs/<CID>`.
4. **Custody v2 activation is NOT part of this.** `book.set("secretVaultV2")` and `book.set("sessionVaultFactory")` stay gated
   (`work/custody-v2-dashboard-20261023/HANDOFF.md`, ROOT-NEEDS.txt).
5. **Rollback.** Fronts: `site/deploy.sh rollback --targets <file> --to bafybeig3rai3tyoimbhb32vo6hkkw3o336wluht7owbs7mefhtiridwp6y --approve bafybeig3rai3tyoimbhb32vo6hkkw3o336wluht7owbs7mefhtiridwp6y --journal <dir>`.
   Probe for the base's own stamp `166bf9d3 · 2026-10-19`. IPNS is untouched.

## 6. Files (sha256 prefixes)
- **tools:** `build-and-check.sh`, `release-check.mjs` (r4), `release-check.r3.mjs`, `inert-smoke.mjs`, `focused.sh`.
- **test-inputs (copied unchanged):**
  - `media-fallback.test.mjs` `ffae0902`
  - `config-read-fallback.test.mjs` `79df8fe0`
  - `config-deadline.test.mjs` `28e6d0cf`
  - `car-verify-oracle.test.mjs` `ea0be01a`
  - `car-fixtures.mjs` `d8f418fc`
- **check:** `release-check.json` `00b491bf` (r4.1), `release-check.r4.json` `13fc6f76` (the original r4 report, kept),
  `inert-smoke.json` `3a57ec29`.
- **tools (§7):** `release-check.mjs` r4.1 `2866a251`, `release-check.r4.mjs` `31b8202c` (r4, kept), `recheck.sh` `8921fd6d`.

## 7. Final doc review cleanup (per root `ROOT-FINAL-DOC-REVIEW.txt`; metadata and docs only, no rebuild)
The release bytes are unchanged. `tools/recheck.sh` hashes the whole release tree before and after the check; both are
`3e9ce9c6…`.
1. **Stale report field.**
   - Checker r4.1 renames only the report key, to `composedFeaturesPresent`. No check changed: both features were
     already `need()`-ed in r4.
   - It was rerun ALONE through the queue: 512 cap, peak 89 MiB, rc 0, RELEASE-CHECK-OK, failures [] (`logs/recheck.*`).
   - The new report equals the r4 report except for the checker name and that key. `asset-paths.txt` is unchanged. The
     inert smoke only reads `custodyV2Chunks`, so it was not rerun.
2. **Stamps.** The base `bafybeig3rai3…` footer is `166bf9d3 · 2026-10-19`. Only this release carries
   `a942a61f · 2026-10-23`. After a rollback to the base, the fronts show `166bf9d3 · 2026-10-19` again.
3. **Docs §4.1 / §2 / §9** (`ROOT-DOC-ACCURACY.txt`). Dashboard repo commit `9d97b4b00`, on top of `a942a61fd`, changes
   only `docs/security/secret-custody-v2.md` (now `84cd9f51…`). `docs/` is not in the site build.
   - §4.1: with `t = 1`, the full committee scalar `x` exists inside the single Enclave seat's SNP custodian guest, sealed
     and never in host plaintext. Threshold distribution starts only after a multi-seat handover. Below 3 seats, the
     Enclave seat can still reconstruct `x`.
   - §2: the goals are multi-seat targets, not the current state. The admin and business controls are stated as kept:
     the book administrator chooses `secretVaultV2` and `sessionVaultFactory`.
   - §9: "Gives" is scoped to `n >= 3`.
   - The dated 2026-10-14 table and the 2026-10-23 current-state section are unchanged.
