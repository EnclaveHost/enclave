# Guest pool + attested release on metal-iso0: integration, rollout and rollback plan

**Status: a PLAN for review (d1, 99; Codex).** Nothing in it has been executed. Source and lab only: no deploy,
resize, setConfig or config change is made by writing or reviewing it. Every host number below was read
read-only on warden-host on 2026-09-25, 16:56:11Z-16:57:31Z (`date -u`). Author: enclave-63.

Components, as reviewed:

| Component | Where | State |
|---|---|---|
| Guest pool, guestd half (budget, reservations, admission) | `isolation/guest-pool-accounting-e63` 24dc334c | approved by 5d and 99 |
| Guest pool, supervisor half (mirror, claim gate) | same branch, 829ea21b + c42612c0 (the resume fix) | approved by 5d and 99 |
| Attested-release guest side (front, config, egress, release client) | 5d's `isolation/app-config-m1` (1a21d375 = 341090f2 + 5b41db37 + a merge of c42612c0); guestd host services still to come | in progress |
| Relay: U7 eligible routing | 99's `security/u7-eligible-routing` 18772bf7 | approved by d1 and 5d; own preflight |
| Relay: attested release | 99's `security/attested-release` 6e2ada52 | inert unless `SECRETS_ATTESTED_RELEASE` is set |

The deployed lineage is `isolation/portable-runtime-jit` at 77f789a6. The live tree `~/enclave-prod/iso-03be27d6`
runs 0181bce3. 4c's branch fast-forwards onto 77f789a6.

## 1. Budget recommendation: `-guest-mem-mib 16384 -guest-cpus 8` (the candidate is SAFE)

### Measured, read-only

| | Value | Source |
|---|---|---|
| Host | AMD EPYC 9115, 16 cores / 32 threads, 124.8 GiB RAM | `lscpu`, `/proc/meminfo` |
| MemAvailable | 82.0 GiB | `/proc/meminfo` |
| Host CPU, 10.05 s window | 5% user + 2% system, 93% idle (about 2.2 of 32 threads); load average 3.8-4.0 | `vmstat`, window timed by `date` |
| Control CVM (not in the pool) | `-m 6144 -smp 4`; unit 5077 MiB, 4481 MiB of it unevictable; QEMU RSS 611 MiB; 1.17% of a core | `enclave-metal-iso.service` |
| guestd | 60 MiB (peak 182 MiB); 0.13% of a core | `enclave-guestd.service` |
| Canaries (3) | see section 2 | `m2-gd*` units |
| Other resident work | 17.0 GiB anon, mostly the desktop and its sessions; `/tmp` tmpfs 13.1 GiB used, limit 62.4 GiB; Shmem 10.4 GiB; 3 GPUs idle | `/proc/meminfo`, `df`, `nvidia-smi` |
| Unevictable | 7.2 GiB: exactly the four SNP VMs' pinned RAM (4481 + 3 x 962 MiB) | `/proc/meminfo`, each unit's `memory.stat` |
| Swap | the 4 GiB device is fully held by **zswap** (3.7 GiB of cold anon, compressed into 2.2 GiB of RAM). Only 384 pages have been written to disk since boot; `oom_kill` 0; memory PSI averages 0 (4.5 s total stall since boot). | `/proc/swaps`, `/proc/vmstat`, `/proc/pressure/memory` |

### Assessment of 16384 MiB / 8 cores

- **Clears the price floor.** A 128 MB app is 1% only while B >= 12800 MiB (a69dcbba's 9 µUSDC/s cap; pinned by
  `test/isolation-guest-pool.test.mjs`). 16384 does.
- **Fits the canaries with room.** They reserve 5376 MiB / 300%, which leaves room for 5 more default guests: memory
  would allow 6, CPU allows 5. At full occupancy the CPU axis binds at 8 guests, memory at 9.
- **Host memory at a full pool.**
  - At full occupancy the CPU axis binds first: 8 guests reserve 14336 MiB (8 x 1792, 11.0% of RAM). Of each
    reservation, 1024/1792 = 57% is guest RAM, and about 54% (962/1792) is pinned.
  - Measured use is about 1.05 GiB per guest, so 8 guests really hold about 8.4 GiB (today's 3 hold 3.1 GiB), and
    MemAvailable would drop to about 77 GiB.
  - Even with all 8 guests at their ceilings (14336 MiB, 11132 MiB beyond today's canaries), it would be about 71 GiB.
- **CPU at a full pool.** 800% of quota is 8 of 32 threads. It is a quota CAP, not dedicated cores (no cpuset), so
  guests share cores with host work. Measured guests use 0.4-1.5% of a core each.
- **Risks, and why not larger.**
  - Guest RAM is pinned (SEV): it cannot be swapped or reclaimed.
  - The host has no swap headroom left (zswap holds the device).
  - `/tmp` is RAM-backed and can grow to 62 GiB.
  - warden-host is a shared development workstation whose heavy jobs come and go.
  - So B stays modest, and is raised only after re-measuring.
- **Why not smaller.** Under 12800 MiB, a69dcbba is refused by its own cap. 14336 MiB would also work, and gives the
  same 5 more default guests (8960 = 5 x 1792, and CPU allows 5). 16384 adds 2 GiB of room for a larger guest.

**Recommendation:** 16384 MiB / 8, with a go/no-go guard at S1: re-measure, and go only if MemAvailable >= 40 GiB and
memory PSI avg60 is 0. Lowering B later is safe: below `allocated`, the pool freezes (overcommitted) and nothing is
killed.

## 2. Real per-guest overhead: reserved ceilings vs measured use

| Per canary | Reserved (the ledger) | Measured |
|---|---|---|
| Guest RAM | 1024 MiB (`guestMemMiB`: max(1024, policy + 384)) | about 1026 MiB of memfd: 962 MiB unevictable (pinned by SEV) plus 64 MiB of it not pinned |
| QEMU and unit allowance | 768 MiB (run-domain.sh `MemoryMax = mem + 768`), a CAP | about 42 MiB (35 MiB QEMU anon plus kernel; QEMU's RSS of 121-123 MiB also counts mapped guest pages) |
| Unit total | **1792 MiB** (`MemoryMax` 1879048192) | **1068 MiB** (`memory.current`; peak 1073 MiB) |
| CPU | **100%** (CPUQuota 1 s per s, one core) | 0.40% / 1.51% / 0.52% of a core over 10 s; lifetime averages 0.50% / 1.53% / 0.65% |

The pool reserves the ceilings because the host lets each unit use them. The gap between 1792 and 1068 MiB is
headroom the unit may take, not waste to reclaim by measuring. **Pricing does not change**: the ledger is for
admission only (`isolation/m4/guestd/pool.go`). One thing is not reserved: the guest image build
(`build-app-guest.sh`) runs on the host, outside the guest's unit, during `starting`. Its transient CPU and memory are
outside the ledger, and are bounded by one build at a time per create.

## 3. Preserved, and how each is checked

No step before S6 sends a chain transaction. Record a read-only baseline at S0, and compare after every step:

| Preserved | Why it holds | Check |
|---|---|---|
| AppIDs | 4c does not touch the derivation (`isolationPolicyFor`, the bundle). The AppID is the DERIVE.md bundle id, which excludes the runtime image (99's 6e2ada52), so 5d's new guest images keep it too. | guestd `/vms` `appId` = the baseline, per deployment |
| HOST_DATA | still the deployment id | `/vms` `hostData` |
| Balances, leases | resumes keep the lease (runner = this node). The three canaries are rate 0. | chain read of each deployment's record |
| Shares | records keep what was bought. On the tier, floors against B are lower (1%) than against the CVM (3%), so no version switch or resize is newly refused. | chain read |
| Price caps, posted price | no setShares, no cap edit. SELL_CPU_PRICE6 stays unset (834). | chain read; `/v1/pricing` |
| Eligibility | 4c changes no field `computeEligible` reads (teeCpu, mode) | relay `/enclaves` row for metal-iso0 |

What does change, visibly: `/availability` `nodeRamGb`/`nodeVcpus` become B (16 GiB / 8), so "1% of the node" means
1% of B, and relay quotes and the `cheapest` ask change meaning on this host (DEPLOYMENT-PATH.md).

## 4. Order: each step with its check and its rollback

**S0. Baseline (read-only).**
- Record:
  - guestd's ExecStart and binary sha256;
  - `/health` and `/vms` (ids, names, appId, recordSha256, transportKeySha256, hostData);
  - each canary's `instance.json`;
  - `metal/config.iso.json` `dist`;
  - the relay's `METAL_ALLOWED_MEASUREMENTS` (nan, read-only);
  - the node's `/availability`;
  - each deployment's on-chain record (shares, cap, balance, appRef);
  - that the three public URLs answer and verify in trusted mode;
  - host MemAvailable and PSI;
  - who judges the control CVM's measurement, re-checked at the integration commit (S2 a).
- Go/no-go: MemAvailable >= 40 GiB.

**S1. guestd pool build AND its flags, in ONE restart.**
- A correction to "flags first": the deployed guestd (0181bce3) does not define `-guest-mem-mib`/`-guest-cpus`, and
  Go's `flag.Parse` exits on an unknown flag. So the flags cannot go in ahead of the binary; a crash-restart of the
  old binary would then fail to start. They go in together.
- Build guestd from the integration commit (section 5).
- Keep the old binary as `~/enclave-prod/bin/guestd.prev-0181bce3`.
- Add `-guest-mem-mib 16384 -guest-cpus 8` to `enclave-guestd.service`'s ExecStart, `daemon-reload`, and restart once.
- Check:
  - the log shows "adopted 3 guest(s) ... verified again as the same guest", then "guest pool: 3 guest(s) hold
    5376 MiB / 300% CPU of 16384 MiB / 800% CPU";
  - `/health.pool` shows budget non-null, `overcommitted:false` and free 11008/500;
  - each canary's `transportKeySha256` equals the baseline (the same guests);
  - the URLs serve and verify.
- The old supervisor (0181bce3) ignores the pool until S2. guestd's 507 is then the only admission: an over-budget
  claim would be taken, fail its provision and be released once. Keep S1 to S2 short.
- Rollback: restore the old binary, REMOVE the flags, `daemon-reload`, restart. It adopts again: `instance.json` is
  unchanged by 4c, and Go's JSON decoding ignores fields a later build may add. Easy to reverse; the guests outlive
  guestd (F7).

**S2. The supervisor release: a new measured control-CVM image.**
- a. Who judges the control CVM's measurement (d1). In code, only the production api-relay's tunnel attach gate does:
  `METAL_ALLOWED_MEASUREMENTS`, relay/api-relay.js:133 and :229 on main.
  - The relay's re-verifier skips tunnel rows (relay/reverify.mjs:59: `isDialed` requires `!e.tunnel`).
  - No site, CLI or vendored verifier code refers to a metal node image or its measurement (grep at 77f789a6).
  - A trusted-mode client of a tier app judges the GUEST's measurement, recomputed from the pinned domain release
    (S4), not the node image.
  - So no client pin is needed at S2. S0 re-runs this check at the integration commit, and also confirms the
    release index / TUF lists no metal node image. If anything is found, pin the new measurement there alongside
    04e953a4 BEFORE the dist switch.
- b. Build with `metal/build-image.mjs` from a CLEAN checkout at the integration commit, never a working tree:
  `git worktree add --detach` at the commit, with `git status --porcelain` empty. Include the supervisor.js overlay
  and the guestd client modules. Record the commit, the predicted measurement and `node-image-manifest.json`
  (`reproducible: true`), and rebuild once to confirm the prediction reproduces.
- c. Measurement pinning.
  - Back up `/etc/nan-relay/api-relay.env` ON nan ONLY: it holds secrets, so the copy is chmod 600, stays on nan, and
    is never copied off the host. The S2 executor records the backup's path and deletes it at the soak's end step.
  - Then ADD the new measurement to `METAL_ALLOWED_MEASUREMENTS`, keeping 04e953a4, and restart
    `enclave-api-relay.service`. That restart briefly drops EVERY tunnel node and the whole API, not only metal-iso0
    (enclave-99), so schedule it.
- Switch: back up `metal/config.iso.json`, point `dist` at `metal/dist-iso-<new>`, and
  `systemctl --user restart enclave-metal-iso` (the node CVM reboots). The guests keep running on the host, but the
  apps' public paths are down while the CVM reboots.
- Resume: every own lease is re-discovered and resumed. c42612c0 judges each resume with the room its held guest
  already reserves, so they pass even on a pool at exactly its budget. At B = 16 GiB, free is ample anyway.
- Check:
  - the ATTACHED measurement EQUALS the prediction recorded at b, and the relay lists the node serving, mode snp;
  - the log shows "[isolation] ... adopted guest ... launched from this record before the node restarted" three
    times, with NO lease released;
  - `/availability` shows `guestPool.heard:true`, `nodeRamGb` 16, `nodeVcpus` 8, and `cpuShareFree` <= 0.625;
  - the URLs serve and verify;
  - the chain records match the baseline.
- Rollback: point `dist` back at `metal/dist-iso-8ed6231f` and restart. The old supervisor adopts the same guests,
  because 4c does not change the derivation, so `recordSha256` matches. Then remove the new measurement from the
  allowlist.
- NON-CANARY CLAIMS (enclave-99): the pool supervisor's floor for a 128 MB app is 1%, the old one's 3%. A deployment
  claimed onto metal-iso0 during the soak at under 3% would, after a dist rollback, be refused at its resume ("below
  the app's minimum shares") and sit Queued.
  - Anyone can create an isolation.require deployment, so this is possible.
  - So the soak lists every guestd `/vms` name and every on-chain runner = metal-iso0 that is NOT one of the three
    canaries, at every soak check.
  - A dist rollback is performed ONLY while that list is empty. If it is not empty, the rollback holds and is
    escalated to Codex with the list, rather than stranding those deployments.
  - The same applies to a rollback of S4's ticket-fetch supervisor.
- Reversibility: operationally reversible ONLY while `dist-iso-8ed6231f` and its allowlist entry are KEPT. What cannot
  be undone: that the new measurement was admitted (relay history). Revoking it means removing it from the allowlist.
- d. The soak. Proposed: 72 h, including at least one guestd restart and one supervisor resume, owned by the S2
  executor (a section 7 decision).
  - Until it ends, BOTH images are admitted. That is intended: it is the rollback path.
  - End step, only after a clean soak: remove 04e953a4 from `METAL_ALLOWED_MEASUREMENTS` and restart the relay;
    retire `metal/dist-iso-8ed6231f`; delete the env backups from c.

**S3. Relay: U7 first, then attested release, still OFF.**
- U7 (18772bf7) goes by its own staged preflight (5d's `~/enclave-bench/u7-preflight/U7-ROLLOUT-PREFLIGHT.md`, rev 2):
  - ELIGIBILITY_API or DOMAINS_API on EVERY daemon host (https or loopback), or tenant traffic fails closed;
  - `dns.env` must configure the ledger;
  - blocker B1: us-west, which fronts every app label, gets no CI relay deploys, and its access is not ours;
  - blocker B2: env reads on the hosts;
  - metal-iso0's id join PASSES.
- The manual us-west egress script is safe to run from a current checkout: since 385bd414 and 164e7279 it refuses to
  replace differing shared modules.
- Then deploy the attested-release relay code (6e2ada52) with `SECRETS_ATTESTED_RELEASE` unset, so it is inert.
- Check:
  - metal-iso0 is eligible, and the canaries' SNI is served;
  - an ineligible box is refused;
  - the release endpoint is inert.
- Rollback: revert and redeploy (CI deploys nan-relay; us-west is manual), and unset the envs. The code is
  reversible; the blockers are access, not risk.

**S3b. Generate the relay's release signing key (the first link of S4's chain).**
- The release key's PUBLIC half is compiled into the MEASURED front: `relayReleaseKeys` in
  isolation/m2/release/verify.go:32, empty today. An image built without it refuses every release ("no pinned
  release key") and needs another image cycle.
- Generate `SECRETS_RELEASE_SIGNING_KEY` on its ONE named relay host (nan), and never move it:
  - its own key, distinct from RELAY_TXT_KEY (d1 on v1.2);
  - its env file chmod 600;
  - record the public key.
- The release stays OFF (`SECRETS_ATTESTED_RELEASE` unset).
- Check: the public key is recorded, and the private half exists only on that host.
- Rollback: discard the key before any image pins it. After S4, replacing it means re-imaging (see 6.5).

**S4. The release chain, THEN guest images carrying 5d's front (`isolation/app-config-m1` with its guestd host
services). One step, in this order (enclave-5d's correction of 14ccc893).**
- Why it is one step. The new front REQUIRES the attested release for EVERY guest whose HOST_DATA names a deployment,
  the three canaries included, although they have no config and no secrets. That is deliberate: otherwise a host
  could downgrade a config app to "no config" by withholding its ticket.
  - So a new-image guest boots only if all four links hold: the image pins the S3b key; the relay's release is ON;
    the supervisor fetches a ticket and gives it to guestd (at create, or POST /vms/<id>/ticket while the instance
    shows `awaitingTicket`); guestd runs with `-release`.
  - With any link missing, the relaunch FAILS CLOSED at boot. That is an outage, not a leak.
- Until 4e, guestd keeps launching from the OLD image source (`~/enclave-prod/iso-03be27d6`). Adoption keeps the
  running canaries as they are, and a crash-relaunch still uses the old image.
- 4a. Build the images with `relayReleaseKeys` = exactly the S3b public key. Build the new guest domain release, and
  PIN it for trusted-mode clients BEFORE any guest runs it.
  - Check: the image pins EXACTLY that key and no other; the prediction is recorded from a clean worktree (as S2 b).
- 4b. Turn the relay's release ON with its full policy, before any guest can ask:
  - SECRETS_ATTESTED_RELEASE and the S3b key;
  - SECRETS_RELEASE_MEASUREMENTS and SECRETS_RELEASE_RUNTIME_IDS naming exactly the 4a images (non-debug, reviewed);
  - the TCB floor (SECRETS_RELEASE_MIN_TCB) and VMPL 0 (SECRETS_RELEASE_VMPL).
  - S5's preconditions (g) must hold here.
  - PRECONDITION, a CODE gate (enclave-d1): the relay releases ONLY for listed deployment ids
    (SECRETS_RELEASE_DEPLOYMENTS). It is new code in 99's lane, and 4b WAITS until it has landed and been reviewed.
    - Why not a checklist: from this moment the staged secrets of any deployment whose guest runs a 4a image are
      releasable. `supports.secrets=false` does not cover deployments ALREADY leased on metal-iso0 (Steven's apps
      included, if the recovery brings them there). And the supervisor claims, relaunches (version or record change)
      and resumes (CVM reboot) on its own, with no human in that loop to run a list.
    - 4b turns the release on with the list = the canaries only.
    - Adding a deployment id is that deployment owner's explicit decision.
    - An unlisted deployment's guest gets a refusal, so it cannot boot the new front with anyone's config: it fails
      closed.
  - Check: the old-image canaries are unaffected (they never ask), and an asker outside the allowlist is refused.
  - Nothing sensitive is staged yet.
- 4c. Ship the supervisor with 5d's ticket fetch. This is a SECOND measured control-CVM image, following S2's whole
  procedure: clean build, prediction equality, allowlist add, dist switch, resumes, and its own soak.
- 4d. Restart guestd with `-release` and the new image source. The adopted canaries keep running their old image.
  - PRECONDITION (5d's lane, named here): what an UNLISTED deployment does once launches use a 4a image. Its guest is
    refused its release, so the front fails closed at boot: guestd reports the start failed (it never attests), and the
    supervisor backs off (respawn 15 s up to 300 s; a claim's failed provision 5 m up to 1 h, the lease released once).
    That is bounded, but it is an OUTAGE for that deployment, repeated on every retry.
  - So one of these must hold, defined and implemented by 5d, before 4d:
    - (i) guestd picks the image per deployment: 4a images only for listed ids, the old image for everyone else; or
    - (ii) 4d happens only while EVERY deployment leased on metal-iso0 is listed, AND the claim gate refuses to claim
      an unlisted deployment onto a box that launches only 4a images, so none arrives afterwards.
  - Neither may fall back to booting the new front without its release.
  - RECOMMENDED: (i) (enclave-d1, and this plan). It turns an unlisted deployment from a bounded outage into no change
    at all, and it keeps the allowlist the ONLY place where the owner's release decision lives. (ii) couples every
    lease on the box to the list, and needs a second gate in the claim path.
  - Either way, guestd's Start should fail fast when the unit dies: check liveness while waiting for "DOM serving". In
    release mode the boot wait is 10 minutes (21b41ff6 main.go:399), so a guest that failed closed would otherwise
    hold its pool room that long, and on a tight B that refuses healthy claims.
- 4e. Relaunch the canaries ONE AT A TIME. Each boots THROUGH a release carrying null config and no secrets: the first
  end-to-end test of the chain, with nothing sensitive in it.
  - What changes: the measurement and the transport key (a new guest).
  - What doesn't: the AppID (the DERIVE.md bundle id) and HOST_DATA.
  - Room: a relaunch DELETEs first, which frees the old guest's room, then creates, so B holds.
  - Rollback trigger: the relaunched canary is not serving and verifying within 10 minutes. Then stop and roll back
    before the next one.
- Check, per canary: it attests with the new measurement from the pinned release and verifies in trusted mode; its
  release was served with null config; its AppID matches the baseline.
- Rollback: guestd back to the old image source WITHOUT `-release`, and relaunch the affected canaries on the old
  image. 4c rolls back by S2's dist switch. The relay's release can be switched off again: nothing has been released
  that needs recalling.

**S5. Real secrets and config through the release (a separate decision; the first HARD step).**
- The release has been ON since 4b, and the canaries have used it with null config. What becomes hard here is the
  first release of anything real.
- g. Preconditions (d1's, all required, and already checked at 4b):
  - a TCB floor the handler owns (SECRETS_RELEASE_MIN_TCB) and the VMPL pin (SECRETS_RELEASE_VMPL);
  - the reviewed NON-debug image allowlist (SECRETS_RELEASE_MEASUREMENTS, SECRETS_RELEASE_RUNTIME_IDS);
  - 5d's guest side landed and reviewed: host_data = the deployment id, the measured release client,
    verify-then-open, TLS validation;
  - key custody as in S3b.
- h. For each of Steven's apps, before anything real is released: WHICH secrets it has, and WHO can rotate each one.
  The owner is Steven (secrets are relay-stored and lease-holder-only; nobody else can read their names). "Rotate" is
  a rollback only for a secret someone can actually rotate.
- The 4b list is the gate here too: a deployment with real secrets is released anything only once its owner has had it
  added to SECRETS_RELEASE_DEPLOYMENTS.
- f. Stage DUMMY secrets on the CANARY deployments first, before any real app.
  - There is no per-deployment allowlist today; 99's relay gates by image only (the two envs above). So do it
    operationally: dummy secrets on the canaries only, and the tier's `supports.secrets` kept false, so the claim gate
    claims no real secret-bearing deployment onto the tier until the canary release has passed.
  - The deployment list (4b) is the code gate that makes this safe.
- Check: a canary's dummy secret arrives only for its own measurement, AppID and HOST_DATA, and every other asker is
  refused.
- Rollback: the release can be switched off. But **a config or secret already released into a guest cannot be
  recalled**. The rollback for a released secret is ROTATING it, which is why the first ones are dummies.

**S6. The owner setConfig transactions: LAST, and NOT part of this plan's execution.**
- These are owner actions: the agent wallet for the canaries, and Steven for his apps. The tier must advertise
  configEdit by then; it is `false` today.
- **Hard to reverse:** a setConfig is a permanent, public chain transaction. It can be superseded by another, never
  erased. Config is public, so secrets never go in it (they go through the relay).
- No cap change and no setShares here.

## 5. Integration recommendation

- **Ship the pool on its own first.** Fast-forward 4c (24dc334c..c42612c0) onto `isolation/portable-runtime-jit`; it
  applies cleanly to 77f789a6. Then build S1 (guestd) and S2 (the supervisor image) from that commit.
  - It is small, independently reviewed, and does not wait on 5d's host services.
  - The pool needs nothing of the new front, while the new front cannot go live without the whole release chain (S4).
  - The cost is a SECOND supervisor release, 4c's ticket fetch, which is another CVM reboot that the resume fix
    handles.
- **The alternative:** build from 5d's integration branch once complete. One release, but S1/S2 wait, and the blast
  radius grows.
- **Holds that apply:**
  - Nothing from `windows/custom-vbs-like-hyperv` 2922294f or later enters any of these branches (d1's history hold).
  - 5d's guestd host services must keep 4c's invariants: the run-domain.sh MemoryMax/CPUQuota pin; a ticket that
    never arrives must END the guest, so its room returns; picked CIDs avoid adopted guests.

## 6. Hard to reverse, in one place

1. S2's measured image: reversible only while the old image and its allowlist entry are kept. Its admission is
   permanent history.
2. S5: a released secret or config cannot be recalled (rotate).
3. S6: setConfig transactions are permanent and public (supersede only).
4. Every CVM reboot (S2, 4c and each rollback) and every relaunch (4e) is a short outage of the affected apps. A 4e
   relaunch with any link of the release chain missing fails closed: an outage until it is rolled back.
5. The relay's release PUBLIC key is pinned in the measured guest images (S3b/S4). A leaked signing key stays trusted
   by deployed guests until they are re-imaged.
6. The S4 client pins (the domain release in the release index or TUF) are public history: superseded, never erased.
7. S3's U7 deploy is reversible as code, but it FAILS CLOSED. A missing or stale ELIGIBILITY_API or DOMAINS_API on any
   daemon host cuts tenant traffic. Rollback trigger: ANY canary URL stops serving after S3.

## 7. Decisions for Steven / Codex

- B: 16384 MiB / 8 recommended.
- S2's soak: its length (72 h proposed) and its owner.
- One pool release first (section 5), or a single combined release.
- The S3 access blockers (us-west).
- Whether and when to do S5.
- The pricing gap on this tier: a 1% share is priced at 1% of B, while its guest reserves about 1792 MiB.
