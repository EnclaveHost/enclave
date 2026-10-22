# eu-central relay -> warden-host user service: fresh preflight (2026-10-21 ~11:12Z) and root's commands

The machine-readable verdict is `gates.json`: 10 READY, 2 BLOCKED.
- **Stage A** (user-stage): READY.
- **Cutover** (the eu-central stop): BLOCKED by one gate, `linux-pinned-client-canary`.

All evidence was collected fresh, read-only, through the queue (`preflight.json`, `gate-probe-1.json`). No mutation was
made anywhere: no key, env or journal content was read (hashes and stat only), nothing was transferred, and no service,
port or firewall was touched.

## The one actual blocker
The RUNNING control is `enclave-metal.service` from `/home/steven/enclave-prod/metal-deabf8f90` (measurement ed918…).
- Its client is `5193da71…`, and its conduit bundle has no pinned-relay support.
- Its host config `leaseGas` names only `relays: ["https://134.209.248.172"]` and no `pinnedRelays`.
- So the CVM cannot use a warden relay yet. Stopping eu-central now would leave Linux NotRelayed.

The candidate is worker 5a's `linux-combined-release/stage3/metal-e68067d24`:
- measurement `a940e71ec8d85a06…`;
- client `bd082b00…` and conduit bundle `c46c65d7…`, both with pinned support;
- STAGED_NOT_ADMITTED_NOT_ACTIVATED, and not copied into enclave-prod.

Root is reconciling source. The image is root's choice: stage3 or its reconciled successor.

## READY now (fresh evidence)
- **package-bytes:** release `5e13596d…`, archive `3ad23b12…` verified; workspace unchanged since the reviewed inventory.
- **closure-equals-work-enclave:** all 29 files equal work/enclave now.
- **target-user-service:**
  - steven, `Linger=yes`, user manager degraded-but-running;
  - `/usr/bin/node` v22.23.3, systemd 262;
  - user@1000 delegates `cpu memory pids` (the enable list includes memory and pids).
- **target-clean-and-free:** no `enclave-host-relay-eu*` unit, no target root, nothing on :8549 (any address), unit dir
  and parent owned by steven and not group/other writable, enough disk.
- **cvm-slirp-path-to-host-loopback:**
  - the running QEMU uses `-netdev user,id=net0` with no `restrict=`;
  - the guest already uses host loopback services 127.0.0.1:8095/8096 through 10.0.2.2.
  - So `http://10.0.2.2:8549` will reach the relay's 127.0.0.1:8549 listener. Proof of the actual pinned call is the
    canary.
- **target-role-platform-admission:** the FROZEN release's own gate, run against production policy, ADMITS
  `https://api.enclave.host/t/metal0` (hostId 0x4dde6d1b…): `not-activated`, no anchor, at block 52895914.
- **source-lifecycle-as-reviewed** (eu-central, read-only over its alias):
  - `enclave-lease-relay.service` active, enabled, NRestarts 0 since 2026-10-21 00:02:01Z, one process, listening on
    127.0.0.1:8549 only;
  - its local `/v1/info` answers as payee `0xC5D8…`;
  - unit `4b3e5ac7…` and relay.env `7c05d44a…` are the reviewed hashes;
  - key: regular file 0600 root, 67 B (never opened); send record: regular file 0600, 2 B (never read);
  - no migration dir and no `/root/eu-relay-move`; node v22.23.3; 6.7 GiB free.
- **public-payee-identity:** `https://134.209.248.172/v1/info` is TLS-verified (IP certificate), with payee `0xC5D8…`
  and chain, reserve and executor equal to record 1665c218.
  - The deployed source artifact (94f4ebdf) serves NO signed statement (it is a pre-statement build).
  - The warden package signs statements, and the pinned client requires them.
- **payee-nothing-in-flight** (point-in-time): nonce latest = pending = 16 on publicnode, mainnet.base.org and blastapi
  (block 52895893); balance 0.0000999954 ETH. This is the float the source relays with today; the min/max thresholds
  move unchanged via relay.env.

## Not blocking the cutover
- **closure-equals-published-main** (freshness): published `7752a4239`, against the frozen closure: 6 files have the
  same bytes, 22 are ABSENT, and `network/route-record.mjs` differs.
  - Published main does not carry this workstream's unpushed source yet.
  - The package is current for work/enclave. When root publishes reconciled main, refresh (below) and re-pin only if a
    closure byte changed.
- **windows-fallback-address:** this host holds 192.168.8.249 on `enp162s0u1u3`. The forwarder is a later step.
  - Until then, Windows keeps its local relay 0x51ff, and its eu-central fallback ends at the stop.

## Commands (root; local user steven, eu-central over its ssh alias)

```
P=/home/steven/Documents/Codex/2026-10-18/wo/work
cd $P/eu-relay-user-target
REL=release/5e13596d6f2c92640e13e0527046436066bec2bb1d7e0ccd69dadfaeaf0a684e
TAR=$REL.tar; SHA=3ad23b12a0f17762d736080887fe1ba6ccdac05c1010ed27011ba61011c4cb18
```

**1. Stage A (READY; nothing runs afterwards).**
- The reviewed relay.env copy is `$P/lease-relay-activation/final-94f4ebdf/relay.env`. Its hash equals the source's
  current 7c05d44a (preflight).

```
mkdir -m 0700 stage && cp config/lease-gas-deployment.json stage/
node user/user-render-config.mjs $P/lease-relay-activation/final-94f4ebdf/relay.env "$REL" stage/host-relay.json
bash user/user-stage.sh --check "$TAR" "$SHA" stage
bash user/user-stage.sh --stage "$TAR" "$SHA" stage
```

- Rollback: `bash user/user-stage.sh --unstage` (moved aside, never deleted).

**2. Linux canary (THE prerequisite; root's lane, worker 5a's activation procedure in linux-combined-release/RESULT.txt).**
- Stage, admit (additively) and activate stage3 (or its reconciled successor).
- The host config `leaseGas` (`/home/steven/Projects/enclave/metal/config.json`, legacy fw_cfg path) ADDS, in the
  checked form, and keeps `relays` unchanged:

  ```
  "pinnedRelays": [{ "origin": "http://10.0.2.2:8549", "payee": "0xC5D88d2D1c898fCACDCe965Cbe2f1C3cD38Bb26a",
                     "operator": "0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB" }]
  ```

- Nothing listens on 127.0.0.1:8549 yet, so the pinned entry is refused at connect, and every claim and renewal still
  lands via eu-central.
- Keep the image only after an app-paid renewal under it. The supervisor log must show the pinned relay was tried and
  refused, with no signature (expected).
- Rollback: 5a's previous-control procedure (deabf8f90/ed918), or drop `pinnedRelays` (byte-identical transit).

**3. Re-run this preflight right before the stop** (point-in-time gates; read-only; queue):

```
cd $P/resume-20261021/relay-preflight
python3 ../../claude-test-queue.py --mib 256 --log preflight-N.guard.log -- python3 preflight.py
python3 ../../claude-test-queue.py --mib 256 --log gate-probe-N.guard.log -- node gate-probe.mjs
```

- Every gate must be READY except `closure-equals-published-main` (freshness) and the canary gate.
- The canary gate turns READY once the running control carries pinned support and `pinnedRelays` 10.0.2.2:8549.

**4. Cutover** (only after 2 and 3):

```
cd $P/eu-relay-user-target
ssh eu-central 'mkdir -m 0700 /root/eu-relay-move'
scp source/eu-source-*.sh "$REL/gate/lease-relay-migration-check.mjs" eu-central:/root/eu-relay-move/
ssh eu-central bash /root/eu-relay-move/eu-source-stop.sh --check
ssh eu-central bash /root/eu-relay-move/eu-source-stop.sh --stop
bash user/user-transfer.sh eu-central
bash user/user-activate.sh --check
bash user/user-activate.sh --activate
```

- Acceptance:
  - the CVM supervisor logs "landed … via http://10.0.2.2:8549";
  - a quorum-verified `LeaseGasPaid` to `0xC5D8…` after the activation block;
  - the warden relay log has the matching `[relay] success` lines.

**Rollback.**
- **Before the transfer:**
  - `bash user/user-stage.sh --unstage`
  - `ssh eu-central bash /root/eu-relay-move/eu-source-restore.sh --abort-before-transfer`
- **After the transfer began:**
  - `bash user/user-out-of-service.sh`
  - `bash user/user-journal-back.sh eu-central`
  - `ssh eu-central bash /root/eu-relay-move/eu-source-restore.sh --after-target-start --target-out-of-service /root/eu-relay-move/lease-relay-migration-check.mjs`
- The source never restarts from its own record once the key may have run here.

**5. Later:** `bash user/user-forwarder.sh --check && bash user/user-forwarder.sh --activate`, then the minipc pinned
entry `http://192.168.8.249:8549,0xC5D8…,0xC9D0…` (rebuilt Windows lease runtime).

## Refresh (only if published/reconciled main changes a closure byte)
```
cd $P/eu-relay-user-target
python3 ../claude-test-queue.py --mib 256 --log logs/refresh.guard.log -- node build-release.mjs --repo <reconciled main checkout> --out "$PWD/release-<stamp>"
```
Re-pin the archive and release id in these commands. The package tests then run against the new archive.
