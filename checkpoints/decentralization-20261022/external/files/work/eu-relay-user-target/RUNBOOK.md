# eu-central relay -> warden-host: the USER-SERVICE target (no root, no /opt checkout)

Prepared, not executed. This workstream made no production change, read no key/env/DB, opened no port, started no
production service. Root owns the switch. Every command below runs as the local operator user `steven` (no sudo); the
eu-central side runs over the existing `eu-central` ssh alias (root on that host), with its tested root scripts.

## Why this variant
- Root's read-only readiness (`root-target-readiness.json`): warden-host, `/usr/bin/node` v22.23.3, :8549 free, no
  `/opt/enclave`, no config or unit, and no non-interactive sudo. The root-only staging plan's reviewed-checkout
  prerequisite (P4) is unmet.
- This machine already runs its Enclave services as user units (`systemctl --user`: enclave-metal.service), with
  `Linger=yes`. So the role runs the same way: unit `enclave-host-relay-eu.service`, target root
  `/home/steven/enclave-prod/host-relay-eu`, owned by `steven`, dirs 0700, files 0600.
- Same role, same admission: main's `network/host-services/lease-relay-host.mjs` and its platform host policy gate (a ban
  stops the relay; the admin's admit restarts it).
- Same moved funded key `0xC5D8…` and its stopped journal. No new key, float, address, contract or advertisement.

## What is frozen (release/)

**This freeze:**
- release `5e13596d6f2c92640e13e0527046436066bec2bb1d7e0ccd69dadfaeaf0a684e`;
- archive `release/5e13596d….tar`, sha256 `3ad23b12a0f17762d736080887fe1ba6ccdac05c1010ed27011ba61011c4cb18`;
- 11903 files;
- relay package pin `sha256:b6abfeee6765bd7fffe370ff6eab87a74345e1f98f4a030d6d957df37529a91c`;
- gate `adacaff0f86ecc44448c1e5ae230e1aa0d286bc704cee460b83f82f5d348257a`.

It was built from main (HEAD e762a9c5 plus the working tree). 22 of the 29 closure files are not committed, and they
include the integrated pinned-relay client (bd082b00). `RELEASE.json builtFrom` records the per-file hashes; an
independent second build gave the same id and archive.

It is CANDIDATE-CURRENT: it equals main's bytes at build time (the freshness test re-checks this). If root's final main
changes any closure file, refresh with the command below and re-pin the archive.
`build-release.mjs` takes the role's EXACT runtime closure from the repository (esbuild metafile: static and literal
dynamic imports). It does not bundle or rewrite anything: each module keeps its own `import.meta.url`, so `runner.mjs`'s
own CLI main-check cannot fire inside the role.
- **app/:** the 29 source files byte for byte, plus 13 npm packages at their package-lock versions.
- **packages/:** the relay child package, built by the repo's `build-lease-relay-host-package.mjs`.
- **gate/:** the migration verifier, built by `build-lease-relay-migration-check.mjs`.
- **forwarder/, units/, verify-release.mjs, RELEASE.json:** the fixed forwarder, the two unit templates, and the
  verifier with its manifest (every file's sha256; the release id is sha256 of the manifest body).
- The tar is deterministic: sorted names, mtime 0, numeric ids.
- `verify-release.mjs` runs at install and before EVERY start (`ExecStartPre`). It requires exactly the listed files,
  no symlinks, the operator's uid, and owner-only modes.
- The configuration, key and journal live OUTSIDE the release (`etc/`, `state/`).

**Refresh** (deterministic; run when root's main is final, through the queue):

```
cd work/eu-relay-user-target
python3 ../claude-test-queue.py --mib 256 --log logs/refresh.guard.log -- \
  node build-release.mjs --repo ../enclave --out "$PWD/release-$(date -u +%Y%m%dT%H%M%SZ)"
```

`RELEASE.json builtFrom.sources` lists each closure file's sha256. `test/release.test.mjs` refuses a release whose
sources differ from main's current bytes.

## Layout (target root /home/steven/enclave-prod/host-relay-eu)

| path | what |
| --- | --- |
| `releases/<id>/` | the immutable release (0700/0600) |
| `etc/host-relay.json` | 0600, `user/user-render-config.mjs` output, CAS-pinned at stage |
| `etc/lease-gas-deployment.json` | 0600, 1665c218 |
| `etc/platform-policy-import/` | 0700, the policy carrier importDir |
| `state/lease-relay/` | 0700: `relay.key`, `relay-send.json` (moved), `relay.address` (written at activation) |
| `state/host-policy/` | the gate's own state |
| `migration/` | 0700: release-id, config.sha256, the rendered units (`*.staged`), receipts, target-ever-started, progress.log |
| `~/.config/systemd/user/enclave-host-relay-eu.service` | installed ONLY by `user-activate.sh` (and `-lan.service` only by `user-forwarder.sh`) |

## The unit (units/enclave-host-relay-eu.service.in, rendered at stage)
- `ExecStartPre=` runs verify-release, then `lease-relay-host.mjs check`. There is NO `init`, so the unit can never
  generate a key.
- `ExecStart=… lease-relay-host.mjs run`.
- Bounds and sandbox:
  - `MemoryMax=512M`, `MemorySwapMax=0`, `TasksMax=64`;
  - `Restart=on-failure`, `RestartSec=10`, `StartLimitBurst=5`/600 s, `UMask=0077`;
  - `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome=read-only` with `ReadWritePaths=<target>/state`;
  - `RestrictAddressFamilies`, `LockPersonality`, `RestrictRealtime`, `RestrictSUIDSGID`, native syscall
    architecture only;
  - `UnsetEnvironment=NODE_OPTIONS …`.
- **Support check** (bounded, read-only): `user@1000.service` delegates the `cpu memory pids` controllers.
  `test/user-unit-fixture.test.mjs` runs the frozen role as a TRANSIENT user unit with exactly these settings and reads
  the kernel's `memory.max`/`memory.swap.max`/`pids.max` back.
- **Bind:** 127.0.0.1:8549 (the configuration). The control CVM reaches it as `http://10.0.2.2:8549` (QEMU user-net),
  using main's integrated pinned-relay mode.

## Windows fallback listener (units/enclave-host-relay-eu-lan.service.in + forwarder/lan-forwarder.mjs)
- A per-user manager does not apply `IPAddressAllow/IPAddressDeny`, and this is MEASURED on this machine
  (`evidence/user-unit-fixture.json`):
  - a transient user unit with `IPAddressDeny=any IPAddressAllow=127.0.0.2/32` showed both properties set;
  - it still answered a peer from 127.0.0.3 (`enforced: false`).
  The man page says the lists "will have no effect" without eBPF cgroup support. So the peer is enforced by a fixed
  forwarder:
  - listen ONLY 192.168.8.249:8549, accept ONLY 192.168.8.238, forward ONLY 127.0.0.1:8549, all constants in the code;
  - any CLI argument exits 2; it reads no environment, file or name;
  - bounds: 8 connections, 5 s connect, 15 s idle, 60 s total, 256 KiB each way; the unit has `MemoryMax=64M`,
    `TasksMax=16`, heap 32 MiB.
- No existing tested fixed-target forwarder exists in the repo (the egress/SOCKS routers are different), hence this
  small one.
- This host holds 192.168.8.249 on `enp162s0u1u3` (read-only check). The forwarder is a separate step after the relay
  is live. It is within the human's DO-removal authorization; this workstream only prepares it.

## Commands (root, as `steven` on warden-host unless marked eu-central)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/eu-relay-user-target
REL=release/<id>; TAR=release/<id>.tar; SHA=<pinned tar sha256>      # from inventory.json
# 0. preflight (read-only)
loginctl show-user steven -p Linger                                  # Linger=yes
ss -Hltn 'sport = :8549'                                             # empty
systemctl --user show enclave-host-relay-eu.service -p LoadState     # not-found
# 1. render and check the configuration (relay.env = eu-central's reviewed 7c05d44a; only 4 public names are read)
mkdir -m 0700 stage && cp config/lease-gas-deployment.json stage/
node user/user-render-config.mjs <reviewed relay.env> "$REL" stage/host-relay.json
bash user/user-stage.sh --check "$TAR" "$SHA" stage
# 2. stage (nothing starts: no unit is installed; the state dir is empty)
bash user/user-stage.sh --stage "$TAR" "$SHA" stage
# --- gate: root's composed Linux image with pinnedRelays http://10.0.2.2:8549 is canaried (pinned-relay ACTIVATION.md step 4)
# 3. eu-central: copy the TESTED source scripts and the gate there, then the established stop
ssh eu-central 'mkdir -m 0700 /root/eu-relay-move'                  # create-only: refuses if it exists
scp source/eu-source-*.sh "$REL/gate/lease-relay-migration-check.mjs" eu-central:/root/eu-relay-move/
ssh eu-central bash /root/eu-relay-move/eu-source-stop.sh --check
ssh eu-central bash /root/eu-relay-move/eu-source-stop.sh --stop
# 4. transfer (source marker first; journal, then key; create-only; only intact/MISMATCH/refusals printed)
bash user/user-transfer.sh eu-central
# 5. activate (gate, ever-started marker, unit, bounded identity check, enable)
bash user/user-activate.sh --check
bash user/user-activate.sh --activate
# 6. acceptance: the CVM supervisor logs "landed ... via http://10.0.2.2:8549"; the read-only LeaseGasPaid audit to 0xC5D8...
# 7. later, separately: the Windows fallback
bash user/user-forwarder.sh --check && bash user/user-forwarder.sh --activate
```

**Rollback.**
- **Before step 4:** `bash user/user-stage.sh --unstage` (moved aside, never deleted), then
  `ssh eu-central bash /root/eu-relay-move/eu-source-restore.sh --abort-before-transfer`.
- **After step 4** (the key may have run here; the source NEVER restarts from its own record):
  1. `bash user/user-out-of-service.sh`
  2. `bash user/user-journal-back.sh eu-central`
  3. `ssh eu-central bash /root/eu-relay-move/eu-source-restore.sh --after-target-start --target-out-of-service /root/eu-relay-move/lease-relay-migration-check.mjs`
- **A transfer that failed before the key arrived** is recorded as `transfer-key-not-delivered` on the source, which
  alone re-allows `--abort-before-transfer` there.
