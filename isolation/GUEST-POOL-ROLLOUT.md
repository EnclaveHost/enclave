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
  - The ceilings reserve 16 GiB, 12.8% of RAM, of which about 57% is pinned guest RAM.
  - Measured use is about 1.05 GiB per guest, so 8 guests really hold about 8.4 GiB (today's 3 hold 3.1 GiB), and
    MemAvailable would drop to about 77 GiB.
  - Even with every guest at its ceilings (16384 MiB, 13180 MiB beyond today's canaries), it would be about 69 GiB.
- **CPU at a full pool.** 800% of quota is 8 of 32 threads. It is a quota CAP, not dedicated cores (no cpuset), so
  guests share cores with host work. Measured guests use 0.4-1.5% of a core each.
- **Risks, and why not larger.**
  - Guest RAM is pinned (SEV): it cannot be swapped or reclaimed.
  - The host has no swap headroom left (zswap holds the device).
  - `/tmp` is RAM-backed and can grow to 62 GiB.
  - warden-host is a shared development workstation whose heavy jobs come and go.
  - So B stays modest, and is raised only after re-measuring.
- **Why not smaller.** Under 12800 MiB, a69dcbba is refused by its own cap. 14 GiB would also work, but leaves room
  for only 4 more guests.

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
  - host MemAvailable and PSI.
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
- Build with `metal/build-image.mjs` from the integration commit: the supervisor.js overlay plus the guestd client
  modules. Record the prediction, and rebuild once to confirm it reproduces.
- Measurement pinning: back up `/etc/nan-relay/api-relay.env` on nan, then ADD the new measurement to
  `METAL_ALLOWED_MEASUREMENTS`, keeping 04e953a4. Restart `enclave-api-relay.service`. That is a brief blip of the
  production API relay, so schedule it.
- Switch: back up `metal/config.iso.json`, point `dist` at `metal/dist-iso-<new>`, and
  `systemctl --user restart enclave-metal-iso` (the node CVM reboots). The guests keep running on the host, but the
  apps' public paths are down while the CVM reboots.
- Resume: every own lease is re-discovered and resumed. c42612c0 judges each resume with the room its held guest
  already reserves, so they pass even on a pool at exactly its budget. At B = 16 GiB, free is ample anyway.
- Check:
  - the node attaches via attestation with the NEW measurement, and the relay lists it serving, mode snp;
  - the log shows "[isolation] ... adopted guest ... launched from this record before the node restarted" three
    times, with NO lease released;
  - `/availability` shows `guestPool.heard:true`, `nodeRamGb` 16, `nodeVcpus` 8, and `cpuShareFree` <= 0.625;
  - the URLs serve and verify;
  - the chain records match the baseline.
- Rollback: point `dist` back at `metal/dist-iso-8ed6231f` and restart. The old supervisor adopts the same guests,
  because 4c does not change the derivation, so `recordSha256` matches. Then remove the new measurement from the
  allowlist.
- Reversibility: operationally reversible ONLY while `dist-iso-8ed6231f` and its allowlist entry are KEPT; keep both
  through a soak. What cannot be undone: that the new measurement was admitted (relay history). Revoking it means
  removing it from the allowlist.

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

**S4. Guest images carrying 5d's front (`isolation/app-config-m1`, once its guestd host services land).**
- Build the new guest domain release, and PIN it for trusted-mode clients BEFORE any guest runs it.
- Restart guestd with 5d's `-release` flag and the new release. It adopts the old-image canaries, which keep running.
- New launches use the new image. Each canary moves on its next relaunch, because the supervisor's spawn compares
  `recordSha256` and the derivation carries the runtime id.
- What changes and what doesn't:
  - the AppID and HOST_DATA are unchanged;
  - the measurement and the transport key change (a new guest).
- Room: a relaunch DELETEs first, which frees the old guest's room, then creates, so B holds.
- The relay's release stays OFF, so no config or secret flows yet.
- Check:
  - each relaunched canary attests with the new measurement from the pinned release, and verifies in trusted mode;
  - AppIDs match the baseline.
- Rollback: guestd back to the previous release, and relaunch the canaries on the old image. Keep the old release
  pinned in clients through the window. Reversible: no secret has been released.

**S5. Switch attested release ON at the relay (a separate decision; the first HARD step).**
- Set `SECRETS_ATTESTED_RELEASE` with its signing key (its own key, d1 on v1.2), the TCB floor and the VMPL pin.
- Check: a guest's release succeeds only for its own measurement, AppID and HOST_DATA, and every other asker is refused.
- Rollback: unset it. But **a config or secret already released into a guest cannot be recalled**. The rollback for
  a released secret is ROTATING it.

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
  - The cost is a SECOND supervisor release later, for 5d's supervisor ticket fetch (another CVM reboot, which the
    resume fix handles).
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
4. Every CVM reboot (S2 and each rollback) and every relaunch (S4) is a short outage of the affected apps.

## 7. Decisions for Steven / Codex

- B: 16384 MiB / 8 recommended.
- One pool release first (section 5), or a single combined release.
- The S3 access blockers (us-west).
- Whether and when to do S5.
- The pricing gap on this tier: a 1% share is priced at 1% of B, while its guest reserves about 1792 MiB.
