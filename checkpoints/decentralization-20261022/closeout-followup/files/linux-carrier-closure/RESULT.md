# Linux carrier closure: relay-mode policy carriers, the adopt harness, and the A/B/ROOT composition (2026-10-23)

**Status:** tested final SOURCE candidate, ready for final composition.
- **Not built as an image:** the final image is knowingly incomplete until B's runtime is final.
- **Not deployed or activated.** No SSH, production access, wallet action, VM change or purchase.
- **Measurement:** 3043f6ff (fec43a6a) does NOT apply to this source. Every commit here, the test-only ones included, changes
  `manifest.json` and therefore the measurement.
- **Not touched:** the previous package (`linux-runtime-release`, fec43a6a, image 3043f6ff), the D candidate and root's trees.
  They were only read, as were the A/B/ROOT repos (objects fetched).

## 1. Source pins (`repo/`, a new repo from immutable fec43a6a; `patches/` 0001–0019 + `receipts/patches.sha256`)

| ref | commit | tree | what |
|---|---|---|---|
| base | `fec43a6a08da2ac287fb3a5c42de89f096f4f678` | 13e18b08 | the packaged D+ROOT Linux release (493ee9ee + 09ff3ed5/b744ba19/f1d0666b/1086cf23) |
| `carrier-closure-on-fec` | **`65f3fb982`** (3 commits) | **6856eb43** | the exact delta to fec: carriers + harness + 2 test fixes |
| `linux-carrier-closure` | **`fad657bc5626166bde1bde4454ec4f73d23dde47`** (19 commits) | **5e2e4331** | + root's admin-CLI 0eac0d60b/dfe020abf + A dfe020abf..71448f63 (9) + B 62feb3aa/8d110101 + ROOT fd6a1762 (`cherry-pick -x`, authors kept) + the bundle rebuild 714aa0dc + a test-only boundary extension fad657bc |

All 19 commits are authored and committed as SteveDeFacto (`receipts/commits.txt`).

The carrier commits:
1. **`4cdd4622` — relay-mode platform policy carriers, end to end.** The chain is launcher → fw_cfg → gsup legacy → supervisor
   gate.
   - **One schema for both modes.** `metal/guest/measured-control.mjs` `checkPolicyCarriers` is the measured guest's existing
     `platformPolicyCarriers` validator, exported and now used by both modes: peers and/or a service-index pin; host
     directories refused; strict and canonical.
   - **New rule in both modes:** a carrier must be ANOTHER host's role. This host's own public origin, the QEMU host link
     10.0.2.2 and loopback names are refused, because its own roles serve only once it is admitted, so a cold start would
     wait on itself.
   - **Guest side.** `guestPolicyCarriers` and `withPolicyCarriersEnv` give the legacy guest exactly ONE supervisor name
     (`ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS`). It comes only from fw_cfg and is applied last, so flavor, lease-gas and
     owner-nomination channels cannot supply or override it, or any authority name.
     - An invalid setting, or an image bundle that cannot honour it, becomes a value the shipped bundle's parser refuses. The
       supervisor's existing `HOST_POLICY_GATE` catch then refuses work and service, never admitting and never silently
       running without the carriers.
   - **Launcher.** `metal/enclave-metal.mjs` checks `cfg.platformPolicyCarriers` and writes it in its checked form; a bad or
     self carrier refuses the launch. A direct guest takes carriers only inside its HOST_DATA-bound config.
   - **gsup.** `metal/guest/gsup.mjs` checks the setting again and wraps the supervisor env once.
   - **Unchanged:** carriers are untrusted transport, so authority stays the book's anchor plus its current owner's signature
     at the gate's own quorum. The supervisor's gate call is unchanged.
2. **`9a00b983` — tenant-provision-race harness.**
   - adopt() reads `walletVerdicts` (ROOT 1086cf23) and `releaseHold` before deciding. The harness never supplied them, so the
     case failed on every lineage (`releaseHold`, later `walletVerdicts`).
   - The harness now slices the REAL statements and functions: `_walletWithdrawn`, `walletVerdicts`, `noteWalletWithdrawn`,
     `_stateCorrupt`, `_releaseIntents`, `releaseHold`. The assertions are unchanged.
   - New pending-adopt cases: a pending stop, a wallet hold, an unresolved release or a corrupt journal never lets a second
     adoption replace the record or free/allocate its slice.
   - Root's 1086cf23 adopt guard is intact; its own suite is in G4/S5.
3. **`65f3fb98` — two PRE-EXISTING failures, fixed without weakening.** Both reproduced on fec43a6a in the control run K1/K2.
   - `metal-measured-control` byte-compares gsup's legacy launch with main. The reviewed 6f2c7da4 line `...HOST_POLICY_ENV,` is
     now asserted once and removed like the other reviewed wrappers; the rest still compares exactly.
   - `hosted-policy-cold-start` read `PRODUCTION_MIRRORS[0]`, which is undefined since 40e8ba71. It now configures the four
     former fleet fronts explicitly (still refused at the transport) and asserts the shipped default is empty.

**Composition (`receipts/union-check-final.json`, ok).** Commits 4–17 are cherry-picks.
- The only conflict was ROOT-REVIEW.md, which both root commits add:
  - 1086cf23's stays at `ROOT-REVIEW.md`;
  - fd6a1762's is kept byte-for-byte as `ROOT-REVIEW-verified-snapshot-lifecycle.md`;
  - the commit message records this.
- Union proof:
  - 71 single-side paths equal their side's blob;
  - `metal/guest/measured-control.mjs` (ours + A) is the exact line union;
  - `network/lease-reader.mjs` = B's 8d110101 blob (A made no later change to it);
  - `network/verified-chain.mjs` = ROOT fd6a1762's blob (A 71448f63 made no later change to it).
- **Commit 18 `714aa0dc`** rebuilds exactly the two policy bundles with `scripts/build-host-admission.mjs`. Their `--check`
  failed before and passes after:
  - host-admission 40e8ba71 → **`2dba0cebe450eeaeee39db6a2344f7790d549ccc6f9774f4f1bc6b5a8f39278b`**;
  - metal host-policy acfa1b00 → **`9a6aa25a1995384aa8bf6cccacd5fedc0af61d0b641c67819b0c639d0d2b1b59`**.

  These are the bytes the composed suites ran against. The lease-gas conduit 421d6584 stayed current.

## 2. Build-input closure (`receipts/input-closure-*.json`, from each commit's own overlay tool)

| commit | relay inputs | direct inputs | vs fec43a6a's 55 relay inputs | npm from base | DO literals |
|---|---|---|---|---|---|
| 65f3fb98 (carriers only) | 55 | 59 | changed: gsup 07e05839→b48e26c9, measured-control 26a8982c→bbf4f1c8 | ok | none |
| 714aa0dc (composed; fad657bc adds only a test) | **56** | **60** | **added** `app/network/verified-chain.mjs`; **changed** lease-gas-runtime 91b5e357→4ab0d467, service-index 8420b37f→0c38f700, host-admission bundle →2dba0ceb, gsup →b48e26c9, host-policy bundle →9a6aa25a, measured-control →9220919c | ok (cors 2.8.6, express 4.22.2, jose 5.10.0, viem 2.53.1, ws 8.21.1) | none |

Still stale at 714aa0dc. Full `--check` output is in `TEST-EVIDENCE.txt` t3.

These must be rebuilt in the reviewed order before the image: host-admission ✓ → lease bundles → network runtime →
platform-api / MCP / host-service packages.
- **Windows lease runtime:** stale ("Windows shared lease bundle is stale").
  - A changed `lease-gas-runtime.mjs`.
  - It is a Windows input, not a Linux one, and belongs to A's active Windows consumer closure.
- **The relay network runtime (gitignored):** must be built first. It inlines the host-admission bundle.
- **Platform API guest bundle:** cannot even be checked without that runtime ("Could not resolve ./network-runtime.bundle.mjs").
- **MCP guest bundle:** stale. It takes the host-admission bundle as an input.
- **Host-service packages:** stale ("directory-replica.mjs is stale"; A changed the roles, runner, policy-mirror and
  directory-server).

The relay-mode Linux image needs none of the last four. The direct image needs the platform API and MCP bundles.

## 3. Tests (all through the queue: 16 GiB floor, inside `unshare -r -n`, ssh/scp/sftp denial stubs; `TEST-EVIDENCE.txt`)

| job (cap) | peak | groups |
|---|---|---|
| c0 repo (512) | 114 MiB | clone + objects fetch, ok |
| **t1** (1024) on 9a00b983 | 648 MiB | see the group list below |
| **t2** (1024) | 696 MiB | see the group list below |
| t3 (512) | 325 MiB | union ok; bundle checks above; closure; `scan-crypto-keys --range fec43a6a..714aa0dc` 0; gitleaks (checkpoint config) 18 commits, no leaks |
| **t4** (1024) on **fad657bc** | 388 MiB | the carrier suite again on the final head **12/12** (the env boundary now also covers A's `ENCLAVE_CHAIN_AUTHORITY`/`_VERIFIER`); `scan-crypto-keys --range fec43a6a..fad657bc` 0; gitleaks 19 commits, no leaks; patches 0001–0019 |

**t1 groups:**
- forge subset ok;
- **G1 new carriers 12/12;**
- G2a measured-control 12/13 and G2b 25/28: the pre-existing failures, fixed in 65f3fb98 and proved in t2;
- G3 launchers 17/17;
- **G4 adopt/race 50/50;**
- C1 CONTROL: fec43a6a's harness still fails its adopt case (expected).

**t2 groups:**
- **K1/K2 CONTROL on fec43a6a: 12/13 and 2/5**, the same failures;
- **K3/K4 fixed: 13/13 and 5/5;**
- union ok;
- bundles rebuilt;
- composed **S1 carriers + gate 22/22**, **S2 A/B/ROOT 53/53**, **S3 guest/launchers 35/35**, **S4 measured-control 13/13**,
  **S5 supervisor 54/54**.

**t2 exit 9 was MY harness's stub count.**
- `b2-bundles.sh` re-sourced `env.sh`, whose own `ssh -V stub-proof` self-test was then counted.
- `stub/invocations.log` holds only stub-proof lines, so no real ssh/scp/sftp ran.
- The counting now ignores the proof line (edited after the run; t3 passed with it).

What the new carrier suite proves (`test/relay-policy-carriers.test.mjs`):
- **One schema.** The relay check IS the bound direct member, and gives byte-identical env values.
- **Refusals:** 22 malformed or self cases.
- **Env boundary.** A forged carrier from the flavor is dropped; lease-gas, owner-nomination and carrier channels emit no
  authority name; CHAIN_ID, the book and the policy names come only from the flavor.
  - On the composed tree this also covers A's new `ENCLAVE_CHAIN_AUTHORITY`/`ENCLAVE_CHAIN_VERIFIER` (provider quorum unless
    explicitly a loopback verifier). The measured direct guest's supervisor env never names them.
- **Text pins:** gsup, the launcher and the supervisor gate call.
- **The real launcher (fake QEMU):** carriers cross in their checked form; invalid or self carriers refuse the launch; absent
  stays absent; direct mode takes the bound copy only.
- **The supervisor's own gate block, sliced from supervisor.js, on the SHIPPED bundle, on a real local chain.** The chain is
  anvil with the rig's registry, a deployed EnclaveAddressBook owned by the admin, and EnclaveHostOwnership; ANOTHER host's
  real policy-mirror role is the only carrier.
  - Unanchored: admits with and without carriers (today's behaviour).
  - The admin's anchored policy: admits from empty state, while every former DO front is refused at the transport.
  - The old fec43a6a launcher plus gsup composition: the setting is dropped and the gate never admits (negative control).
  - The admin's anchored ban: refuses, sticky, and a fresh gate loads it too; the next anchored document readmits.
  - Stale and substituted carrier bytes never admit; an invalid setting refuses work and service.

**Fixture vs physical.** All of this runs on a local chain, loopback listeners and a scripted transport.
- It is not a guest boot, not production policy data and not proof of non-DO carrier availability.
- The production book is UNANCHORED (root's 05:51Z preflight). No signed production envelope exists.

**Not re-run here (unchanged, disclosed):**
- the 11 egress phase-2 skips (patched wasmtime) from the fec package stand; egress.js is unchanged;
- A's reth/Helios proof e2es (`policy-verifier.e2e`, `lease-reader-verifier.e2e`, `helios-*.e2e`), which need reth `--dev` and
  the Helios binaries; S2 ran A's, B's and ROOT's unit and lifecycle suites only;
- the full repository suite and physical guestd/hardware.

## 4. Readiness and the exact missing pins (root composes once, then one final image build)

**Ready:** the carrier closure (65f3fb98) and its composition with A 71448f63, B 8d110101 and ROOT fd6a1762 (714aa0dc; final head
fad657bc adds one test-only commit).
- Tested at source level, with the Linux image's own bundles current.
- C2 legacy attestation path, D stop/hold/adopt, app-funded leases, owner nomination, admin book resolution and the off-chain
  heartbeat path are unchanged: no `supervisor.js`, `egress.js` or `registry-reconcile` byte changed after fec43a6a.

**Missing before the final image:**
1. **B's final runtime/helper release.** `rpc-runtime-composition` is still active (HEAD b9a0eb6d, mutable, tests running).
   - It must integrate ROOT's kernel lock 794d2ff3/336ea56a, ROOT fd6a1762, A 71448f63 and P 9e838ba7 (helper 4fe0cd3b on
     Helios ef320298).
   - It must not ship the obsolete 26fbc35a.
   - **No Linux guest launches a local verifier yet.** Shipping A's optional reader code is not verified RPC: the default
     provider-quorum authority is unchanged in every image input.
2. **Rebuild the remaining bundles** (section 2) from the composed source plus B's final, in the reviewed order.
3. **Then one image build per mode** (`linux-runtime-release/RECIPE.md`), from the final commit, which gives a new
   measurement:
   - relay mode for metal0 (successor to ed918e4b);
   - direct mode for the native control image (successor to fe897820, which still carries the pre-D supervisor).

**Remaining hardware / wallet / root actions (none done):**
- **Admin wallet:** sign the platform policy and publish it to real non-DO carriers (other hosts' policy-mirror roles or
  service-index policy ads) BEFORE anchoring it with `setMany`. The existing book, no new contract. Root owns this.
- **metal0 host config:** `platformPolicyCarriers` naming those carriers (not this host itself); then the relay allowlist
  admission of the new measurement and the cutover via a new instance of the post-adoption activation harness
  (`linux-runtime-release/public/ACTIVATION-REQUIREMENTS.json`), with rollback to ed918e4b.
- **The EU DO lease relay:** retired separately by root using the existing host-local relay role (`pinnedRelays`); no DO app
  service is kept.
- **Hardware:** the canary and cutover are root's. No anti-admin test exists; the admin ban and readmission are enforced.

## 5. Files

- `repo/` (branches above);
- `patches/` 0001–0019;
- `receipts/`: union-check-final, input-closure-head/carrier-only, gitleaks-range, patches.sha256, commits.txt, t1/t2 rc;
- `TEST-EVIDENCE.txt` (digest; raw logs in `rawlogs/` stay local);
- `tools/`: c0/t1/t2/t3 jobs, b2-bundles, union-check, input-closure, make-test-evidence;
- `PROGRESS.txt`.

`draft/` holds the pre-commit test draft; the committed copy in `repo/test/` is authoritative.
