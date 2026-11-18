# Windows host release 2026.11.18 on nucbox-k11-4 (2026-11-18)

The first release installed on that box since 2026.10.12.47 (2026-10-18). Between the two the box was changed by hand:
31 installed files unlike the release, 14 of them unlike this tree too, host binaries beside the pinned ones, launcher
scripts edited, and no updater that could run (the last attempts, 2026-10-23, timed out). This is what was done to
put the tree's own bundle on it, what the box showed, and what is left.

## What went into the tree first (75afa91df)

Each installed file was compared with the release it came from (fb6561c0) and with this tree.

- The node: a share sized against the manager's RAM pool, the in-place relaunch of a partition sized for another
  share, and a `/vms` answer without a list read as an unread manager. The box's own accounting of what the manager
  holds was not brought in: this tree's newer one stays (`test/windows-hv-memory-accounting.test.mjs`).
- The manager: three small rules (a desktop derivation without a desktop record is refused, a malformed image pin
  throws, the CPU-pool check says why). The box's desktop router is this tree's `ImageLauncher`.
- The network agent: the desktop guest's start-up forward and probe, hand-placed beside the box's agent, are in
  its source, and the bundle stages `ingress-thread.mjs`.
- The bundle: `shield-host.exe` and `runtime.bin` are the CPU-allowance builds the box has run since 2026-10-23,
  pinned by hash from the box's own files (not rebuilt); the installer sets `ENCLAVE_GUEST_CPU_ALLOWANCE=1` and its
  policy admits that runtime's measurement; the card worker is the build with `FIELD_CHAIN` (1cf852cc4).

## On the box, before the install

- Backups: `C:\ProgramData\Enclave\patch-backup-20261118-release` (launchers, configuration, the tasks as XML) and
  `C:\Users\claude\enclave-pf-backup-20261118` (all of Program Files\Enclave as it was).
- The seven `set` lines `run-node.cmd` carried by hand, and the call of the native desktop release's environment
  file that `run-node.cmd` and `run-shield.cmd` carried, went into `node-config.local.cmd` and a new
  `shield-config.local.cmd`: an install rewrites the launchers and refuses while they hold settings no hook carries.
- The box's own admitted-image policy (the release's, plus the native desktop image and its desktop block) is
  `C:\ProgramData\Enclave\native-desktop\admitted-shield-policy.json`, named by `ENCLAVE_NETWORK_SHIELD_POLICY` in
  the node's hook. The installer's default policy does not admit the desktop image.
- Its artifact gateways are `C:\ProgramData\Enclave\node\artifact-gateways.json`, named by `IPFS_GATEWAYS_FILE` in
  both hooks. The list used to sit beside `fetch-cid.py` in Program Files, where an install removes it.

## The installs

Run by hand as SYSTEM from the expanded bundle (`install-host.ps1 -Name nucbox-k11-4 -Owner ... -ManageWindowsUpdate off`),
a full install each time; nothing was published to the release channel.

1. **2026.11.18** (from 75afa91df), 09:54 to 09:58 UTC. The installer kept the roles beside the release (the lease
   relay, the network checker and the native artifact cache were stopped and started again; hs2 untouched). The
   manager recovered the ten running partitions, and then nothing moved: every lease was held (the market verdict is
   not kept across a restart), the market does not reopen without the readiness witness, and the manager launches
   no witness while a recovered VM is unreconciled. The nine app VMs were removed by hand through the manager
   (`DELETE /vms/<id>`); the witness ran, the market reopened and the node started the apps. Three launches then
   failed on `fetch-cid`: the release's default gateway (`ipfs.enclave.host`) answered 502 and 404, and the box's
   gateway list had gone with the control directory. Put back (above), they started.
2. **2026.11.18.1** (from a25f1b052, which retires the recovered VM of a deployment the box holds and does not
   start), 10:40 to 10:44 UTC. Nothing by hand: eight recovered VMs retired within thirty seconds of the attach,
   the witness and the market back, eight apps spawned by 10:51, the ninth resumed after.

## After

- `manifest.json` says 2026.11.18.1; Shield, Node, Network and Card run from it; the card worker states 427 to
  480 G products a second (173 before).
- Nine deployments run, KVM Box among them on its SVN22 image. `cron` and `depot` answer 503 for their storage:
  the app they store through (0xef514ed3) exits with status 134 a few minutes after each start. It did the same
  before the first install (09:47 and 09:52 UTC in the node's log).
- A lease is not renewed while it is held, so a restart that takes longer than a lease has left lets it lapse:
  0x7ae476a3 was claimed again after the second install.

## Left

- The release channel (`get.enclave.host/windows/`) still names 2026.10.12.47. The box's updater does nothing
  while the channel is older than what is installed.
- The per-image SVN floor (702854589) is not in this tree; the box's agent no longer enforces SVN 22 for the
  desktop image by that rule. Its measurement is still the only desktop image the box's policy admits.
- `ipfs.enclave.host` is the installer's default artifact gateway and does not serve.
- The scripts that switch the native desktop image (the SVN switches) edit `run-node.cmd`, `run-shield.cmd` and
  the policy in Program Files: on this box they now have to edit the two local hooks and the box's own policy file.
- The operator key holds no ETH, so the node's price write fails on every pass; leases are paid by the apps.
