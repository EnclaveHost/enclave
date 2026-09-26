# NucBox production deployment record (nucbox-k11)

Drafted by enclave-b4 for enclave-87, 2026-09-26 (read 02:25Z). Reviewed by enclave-d1 (READINESS owner) ⟨d1: date⟩.
`⟨owner: …⟩` marks a result that is pending or that its owner has to supply. Nothing here is estimated.

**In one paragraph.** nucbox-k11 runs the node from main as an OWNER-ONLY host of Hyper-V partitions, one per app, on
the custom type-1 path. The boundary is **T0-hv with the host NOT excluded**. The partition's report is signed by the
launcher, not by hardware. Report capture (B1) is PARKED, so **nothing here is a hardware-rooted isolation claim**. The
box serves only its operator and the owners who delegated to it. It is never tenant capacity, it never takes secrets,
and each app has to opt in by its own envelope. This is functional serving, not proven isolated hosting.

## 1. What runs

| Component | Deployed now | Next (v42) | Where / how |
|---|---|---|---|
| Node | main `4ef0e862` (stage `hvnode-4ef0e862.tar.gz` `91072314…a490bb`, MANIFEST `da052054…e7ff16`, 46 files) | main **`07fc4f55e00a`** (enclave-53 build: `hvnode-07fc4f55.tar.gz` `2bd60d74cfeadf0d82ea4907d69b8184774d56c731f85eb2469622cf0ccfb985`, MANIFEST `516627931e201064534320375cc1844a26a3725e86d4f277457259163494d854`, 53 files; import closure 38/38 in it) | task `\EnclaveHvNode` (SYSTEM, boot +90 s) runs `hvnode\<c8>\windows\node\agent.mjs` in a restart loop. The engine is retired, `APPS=1`, owner-only. Staged by `stage-hvnode.sh` (ROLLOUT.md v2.3) |
| Manager, launcher, IGVM | package **v40** `15f39ae4d1fab954…` (manifest sha256 `15f39ae4…efd1df`): manager `e3acc392` (= isolation-manager `76af33b4`), IGVM `b7ba7731…` (VBS 56FBB27F, initrd `1539d5b2`), `vbslike-host.exe` `435717de…`, `runtime.json` `ccadb38a…` | package **v42** ⟨53: package id, MANIFEST sha256, control tree (pkg/control-v42-e53 `90eab896`), IGVM from guest `d9176ed5` once its canary passes⟩ | task `\EnclaveHvManager` (SYSTEM, boot +30 s), 127.0.0.1:8091, data plane :8092; it runs from a verified copy `hvnode\manager-<pkg8>\` |
| M3 host prerequisites | **DONE** by d1 before 00:36Z: `AllowFirmwareLoadFromFile=1` and the 9001 GuestCommunicationServices GUID, both permanent | — | enclave-53's `host-prereq.ps1` (`9abdc36c`, sha256 `4a72dab8…`) through d1's `m3-run.ps1` (`c2cb589e…`); prior state at `C:\Users\claude\vbs-like\host-prereq\prior-state.json` |
| Relay attach (flip A) | **ON**: `RELAY_HVNODE_ATTACH=1` on nan at 00:55:25Z; api relay invocation `a84854b3375f`; accepted at 00:57:28Z. U7 is live on all 3 relays | — | nan `/etc/nan-relay/api-relay.env` (backup `api-relay.env.bak-hvattach-on-20260926T005525Z`) |
| Relay owner-only serving (B) + `RELAY_HVNODE_OPERATORS` | **NOT LIVE.** Until it is: the node attaches host-only (attach signature v1) and the row serves nothing | B = `relay/hvnode-owner-only-v2` `e4d9098d` (GO), plus `RELAY_HVNODE_OPERATORS=0x389c3f03…dbadca` (never `TRUSTED_OPERATORS`) ⟨e3: deploy time, api-relay.js sha256⟩ | nan (and us-west for SNI ⟨e3⟩). The v42 node signs attach v2 and carries its delegations only when the relay's challenge offers `sigVersions` 2 |
| Hosting tray | in `4ef0e862`: hosting controls on 127.0.0.1:9610 (loopback only, bearer token), the caps file under `hvnode\state\` | unchanged | installed with `-HostingTrayUser` (ROLLOUT.md v2.2.5) ⟨d1: tray install record⟩ |

Identity: the registry entry `https://api.enclave.host/t/nucbox-k11` (id `0xd497d065…`), operator
`0x389C3f030a209D04D026228D2D053fEB75DbadcA` (its key is on the box only), payout wallet `0x29479Bf0…647C`.
Standing (DIRECTION.md): Secure Boot ON; the legacy task `\EnclaveWindowsNode` is Disabled (since 2026-09-25 15:56:32Z),
never deleted; the legacy `ee-engine` is never restored or signed; respawn is OFF.

## 2. What it claims, and what it does not

**Claims (each one bounded):**
- **Boundary: T0-hv, `host_excluded=no`.**
  - `/availability`: `isolation: hyperv-partition-per-app` and `isolationBoundary {tier: T0-hv, hostExcluded: false}`.
  - The relay's verdict on the attach: tier `hv-node`, `hvNode.hostExcluded:false`.
  - The attach proves the HOST's boot state: an EK-rooted TPM quote, Secure Boot, no test signing. It says nothing
    about a partition.
- **Owner-only.** The served owners = {the operator} ∪ {owners of valid, unexpired `enclave-host-delegation-v1`
  delegations}. The payout wallet and `OWNER_WALLET` authorize nothing.
  - The node gates claiming, the sweep's hold and restart on that set.
  - With B, the relay serves a deployment on this row only when all three hold at decision time:
    - its ledger owner is served;
    - the row holds its live lease;
    - **its own envelope requires `hyperv-partition-per-app` (E4, per-app opt-in)**.
  - Every other path is refused (tenantRoute, /t, certs, SNI).
- **Never tenant capacity.**
  - The relay: the row is never eligible, placed, priced or counted in the aggregate, and never on the relay roster.
  - The node: `claimEnabled` false (no tier meets the isolation contract), and attested capacity false.
- **Secrets refused.**
  - The node refuses, before any claim, a deployment with staged secrets. It asks the relay's lease-free
    `/v1/secrets/exists`; an unknown answer means no claim.
  - Nothing enters a partition (node-bridge, fail-closed).
  - The relay answers `/v1/secrets/fetch` 403 `host_ineligible` to an hv-node lease holder.

**Does NOT claim:**
- **Any isolation from the host, or any hardware-rooted verdict.** B1 (report capture) is PARKED. The document is
  launcher-signed; "monitor-signed" is a verdict name. The independent verifier answers `unsupported` for it
  (READINESS.md §1, §5).
- `host_excluded` (B2 PARKED), neighbour denial (B3), or a domain's inability to reach the 9001 signer (U5; P1 paused).
- Confidentiality against the NucBox's operator or host.
- A trusted public certificate before B is live.
  - Until then an app serves the guest's self-signed certificate, and R4 compares keys with `-k`.
  - The node half of M4 (it relays the partition's CSR) is on main (`bab1e36b`, `e1c665fd`).
  - The relay issues to an hv-node row only under B's served-owner + lease + E4 rule (certs.js).
- **Sensitive apps on the v40 guest.** v40 carries the front's logging leak and domexec's app-stdio leak. Both are
  fixed on the guest candidate (`4cdd5169`, `683798d0`, `139c3fdd`, `d9176ed5`), which is not yet deployed.
- The guest RNG is seeded with host-supplied entropy (READINESS.md §1.1).

## 3. Evidence index

"ws:" = warden-host; "box:" = nucbox-k11.

| # | Acceptance | When (UTC) | Result | Evidence |
|---|---|---|---|---|
| E1 | M3 host prerequisites | before 00:36Z | DONE | box: `C:\Users\claude\vbs-like\host-prereq\prior-state.json`; ⟨d1: m3-run record⟩ |
| E2 | Stage + preflight + install, node `013deb51` (ROLLOUT v2.2) | ⟨d1⟩ | ⟨d1⟩ | ws: `~/enclave-bench/hvnode-stage-013deb51/SHA256SUMS.txt` (`fd145fca…`); ⟨d1: box install log⟩ |
| E3 | Relay flip A | 00:55:25–00:57:28Z | ACCEPTED | ws: `~/enclave-bench/hvnode-attach-20260925/flip.log`, `accept-on.txt`. The latter also has one FAIL outside the hv-node attach, on the SNP release-ticket (403, expected 503) ⟨63: disposition⟩ |
| E4 | A-series A1–A9 (A8 kill-recovery on the EMPTY node) | ⟨d1⟩ | ⟨d1⟩ | ⟨d1⟩ |
| E5 | Pre-claim defect, live: test 1 `0x31136008…` claimed at 01:00:29Z (tx `0x0340540e…`), then held 2 s later ("hasSecrets … not known") | 01:00:29Z | defect → fixed in `c5d2266a` (verdict before any claim) | ⟨d1: node.log excerpt⟩; `test/windows-node-preclaim.test.mjs` |
| E6 | Price-once defect, live at `013deb51`: "card price now 0" sent twice (`0xe4368ba9…` 00:55:04, `0x79ebd389…` 00:55:33) | 00:55Z | defect → fixed in `c5d2266a` (one tx, persisted) | ⟨d1: post-`4ef0e862` start shows no price tx⟩; `test/windows-node-price-once.test.mjs` |
| E7 | Redeploy node `4ef0e862` (v2.2.5, `-HostingTrayUser`) | ⟨d1⟩ | ⟨d1⟩ | ws: `~/enclave-bench/hvnode-stage-4ef0e862/SHA256SUMS.txt` |
| E8 | Tray UI proof | ⟨d1⟩ | ⟨d1⟩ | ws: `~/enclave-bench/nucbox-tray/d1-tray-ui.ps1`; ⟨d1: result⟩ |
| E9 | Test 1 (operator-owned hello-world 1.0.4, `0x31136008aa0cf1d8…eeeee3`): A7 + R4 over loopback (the guest's key = the manager's `transportKeySha256`) | ⟨d1⟩ | PASS ⟨d1: confirm⟩ | ⟨d1⟩ |
| E10 | v41 candidate canary `252602c8` (guest `4cdd5169`, package v41 `23a41fbd`): production node paused for it (`hvnode-rollback.ps1`: both tasks disabled, test 1's VM `hv9e568cd8…` destroyed through the manager), resumed 02:04:41Z | 01:43:33–02:04:41Z | **FAILED**: every domain `DOM1 ERROR runtime exited status=126` | ws: `~/enclave-bench/canary-252602c8/` (`harness-output.txt`, `pause.txt`, `resume.txt`); box: `C:\Users\claude\vbs-evidence\mgraccept-20260926-014333\` |
| E10a | ↳ cause: domexec opened `/dev/null` inside a chroot that has no `/dev`. Fix `683798d0f`: the monitor hands the null device on fd 3. Plus `139c3fdd4`: the front is non-dumpable and Yama ≥ 2 | 02:00–02:13Z | reviewed GO (b4, bf) | b4's reproduction (userns chroot, runtime fds = null only; control = status 126): ws scratch `domexec-683/` ⟨b4: copy into evidence/ if kept⟩ |
| E11 | Rebuilt candidate canary (guest `d9176ed5`), CANARY-v41.md §0 | ⟨pending⟩ | ⟨pending⟩ | ⟨d1⟩ |
| E12 | R4 PUBLIC: `https://<id8>.app.enclave.host/` answers 200 through the relay, on the guest's key (needs B + v42) | ⟨pending⟩ | ⟨pending⟩ | ⟨d1: `hvnode-accept-remote.sh` output⟩ |
| E13 | Soak: test 1 for 12 h, then stopped (`enclave refund`) | ⟨start⟩ | ⟨pending⟩ | ⟨d1⟩ |
| E14 | Reboot acceptance (REBOOT.md; the manager-only variant first) | ⟨pending⟩ | ⟨pending⟩ | box: `C:\Users\claude\vbs-like\hvnode\reboot-<stamp>\capture-{pre,post}.json` |

Source-side (no box): every windows-node suite passes at `07fc4f55`, 307/307 under the warden-host guards. The node's
own attach against the real relay (`test/windows-node-hv-attach-relay.test.mjs`) gives v1 host-only on today's relay
and v2 owner-only on main+B. b4's node landings were each pushed alone and detect-only (Deploy 36205813636,
36208165412, 36208281464, 36208809559, 36209446162, 36210014221) ⟨5d: the recovery and hvcert landings' runs⟩.

## 4. Operations

**Rollback, per component:**

| Component | How | Leaves |
|---|---|---|
| Node + manager | box: `hvnode-rollback.ps1 [-Unregister]`: node task first, VMs through the manager, then the manager task; leftover tagged VMs only under `uefi-probe.lock` | nothing serving; `hvnode\` kept; held leases lapse on the ledger's clock. Resume: re-enable both tasks (as at 02:04:41Z) ⟨d1: resume steps⟩ |
| Node version | `hvnode-install.ps1 -Replace` stages a new tree beside the old; roll back by pointing `run-node.cmd` at the previous tree | the same `state\` |
| Package (manager, IGVM) | ⟨53: v42 → v40 rollback; v40 stays staged at `pkg\15f39ae4d1fab954\`⟩ | |
| M3 | `host-prereq.ps1 -Rollback`: restores the recorded prior state only where it is still what `-Install` set, else "LEFT: …" (exit 4) | |
| Relay flip A | nan: `relay-hvnode-attach-off.sh` (line-wise, one restart); the node's next attach is refused by name | |
| B / `RELAY_HVNODE_OPERATORS` | ⟨e3⟩. Without the operator in the list, every attach is host-only (the list is read at relay start) | |
| Tray | ⟨87/d1⟩. Lowering a cap never evicts | |

**Gas and renewal** (GAS.md, read 00:01:45Z):
- Operator balance: 0.001456565 ETH, with no stuck nonce. The floor is 0.0005 ETH; below it, top up from the operator
  gas tank (approved).
- Heartbeat: every 10 min.
- Renewal: every 30 min per live lease, inside a 15-min lead.
- Checkpoints: every 5 min per CHARGED lease; skipped at rate 0 (payout-wallet-owned = free self-hosting).
- Test 1 is charged: about 0.00027 ETH/day including heartbeats, so about 5 days on the current balance.
- The card price is 0 (engine retired). It is sent at most once and remembered across restarts for a 10-min settle.
- **Not renewed while not serving:**
  - held on the plan (`planHeld`);
  - held and not running (`isolationHeld`);
  - a failed reboot recovery (`rebootHeld`).
  At lapse such a lease is retired locally, and nothing is released on chain (`30659bf8`, `fa4284db`).
- **An unserved owner** (delegation removed or expired): the lease is held, not renewed, and served until it lapses.
  A TRANSFER stops the app at once.
- **Reboot recovery** (`fa4284db`): the recovered VM is retired, and ONE fresh partition starts on a new key in the same
  lease. A failure holds the lease until a forced relaunch, or the owner's resize or config edit.

**Owner levers (delegations):**
- Create: `node scripts/host-delegation.mjs text --owner 0x… --operator 0x389c… --box nucbox-k11 [--days 90]`, sign it
  in the owner's own wallet, and check it with `verify`. The relay refuses an expiry beyond 180 days, and at most 8
  delegations ride one attach.
- Install the `{message, signature}` file in `hvnode\state\delegations\` (ACL SYSTEM + Administrators).
  - The node re-reads that directory every tick.
  - It re-attaches, at most every 2 min, when the set changes (v42).
  - The relay learns a delegation only at attach, re-verifies it every minute, and checks its expiry at every decision.
- **There is no revocation list.** The owner's levers:
  1. `setConfig` to drop `isolation.require`: the app stops being served here at once;
  2. the delegation's expiry;
  3. transfer or cancel the deployment.
  The operator's lever is deleting the file: the lease is held until it lapses.

**Known residuals and backlog:**

| Item | State | Owner |
|---|---|---|
| KAT cert set | The relay certifies against every INSTALLED release. After rs-6 (02:11:58Z) the installed set is {`5c3561f9`, `6f14ce75`, `52156652`}. `5c3561f9` and `6f14ce75` are the canaries' 09-24 legacy images, kept ONLY because they carry the relay's known-answer-test vectors, so a guest on either can still obtain a CERTIFICATE (never secrets: admitted = {`52156652`}). Fix: a certificate set separate from the KAT set, branch `cert-set-separate` `6e301b16`; lands after B, bf reviews | e3 |
| ownerOf grace | In B as reviewed (`e4d9098d`, `relay/tunnel.js`): the relay re-reads the name's on-chain owner every 60 s (`recheckOwnerOnly`, :216-236). An RPC failure returns the CACHED owner (:264, "fail closed against a known owner"), so a failed read does not end serving; a name with no cached owner reads as none. A CHANGED owner (or one no longer in `RELAY_HVNODE_OPERATORS`) ends owner-only serving at once, until the node attaches again under the new owner's signature (:227). bf's earlier should-fix was worded differently. ⟨e3: confirm this is the B that is deployed⟩ | e3 |
| Separate front uid | The runtime and the front share the domain's uid. `139c3fdd4` makes the front non-dumpable and raises Yama to ≥ 2 (verified: a same-uid process is refused the front's maps, fd links and `pidfd_getfd`). Still open: its own uid, and the startup window (domexec spawns the runtime before the front; open only without Yama) | 5d |
| SNP front hardening | `dumpable.go` is shared with the SNP front. The current SNP release does not carry it; the next one does | 5d / 53 |
| Pre-warm | `relay/release-prewarm` `f0759181` (bf GO on `73662f6b` + `dc3a3ede`; the KAT-recovery follow-up in review). Not on main; lands after B. Until then each relay restart costs about 60-90 s of "warming" per cache key (fail-closed, retried) | e3 |
| Reboot capture S1/S2 | Required by 87: the recovery line bound to the pre instance, and pre requires the one tagged VM. In `c040c9ce` ⟨b4: review⟩ | 5d |
| Logs | `node.log` and `manager.log` grow without bound; rotation later | 5d |
| B1 / B2 / B3, P1, U5 | parked or paused (READINESS.md §4, §5); they gate any isolation claim | Steven / provider |
