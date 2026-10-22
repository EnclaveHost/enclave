# Native-final direct-control hardware canary: root recipe (STAGED, NOT RUN)

Prepared by Claude for root. No QEMU, VM, SSH, network, registry or signing operation was performed by this package. Root
reviews and executes ONE bounded run, using the pins in `FROZEN-PINS.json` (sha256
`280c89d36914b92c3f04668778dc3072ab0ff082e724dfc991d35feb98ad4aa7`).

This package is the root-reviewed `direct-hardware-canary` (FROZEN-PINS 6025fff2; run 20261022T205536Z PASS on the
6f2c7da4 image), adapted only for the new image. `public/SOURCE-DELTA.diff` holds every changed line, and `SOURCES.json`
holds the old and new sha256 of every file. The old package, its run evidence and the old image were only read.

## What one run does (unchanged scope)
- **Image.** It boots the exact built image `native-final-image/image/dist-direct-493ee9ee0` once, as one SNP guest:
  - commit `493ee9ee`, tree `b2116372`; root published the descendant `dfe020abf`, whose extra commits touch no canary
    path;
  - 4 vCPU and 4096 MiB guest memory.
- **Launcher.** The image commit's launcher `tree/metal/enclave-metal.mjs` (a git archive of 493ee9ee) does the boot. It
  is unchanged since 6f2c7da4.
- **Measurement.** The expected measurement is the full value from `native-final-image/public/BUILD-RECEIPT.json`:
  `fe897820f632bae497511a229f0c74465dade8841d5807f8287a3a2caa928d22c8d79c24ffa9b1f9554434b483fae38f`
  (SNP, 4 vCPUs, family 26 model 2 stepping 1, QEMU, OVMF 142589cc).
- **Owner config.** It is BARE:
  - no registry key, not selling;
  - no fleet secret, relay or tunnel;
  - no certificate or ACME input;
  - no apps, MCP, Platform API or **nativeControl** member.
- **guestd.** The guestd endpoints are `10.0.2.2:<two loopback ports with no listener>`, never production 8095/8096.
- **Network.** slirp runs with `restrict=on` (`canary/qemu-restrict.sh`, unchanged). The only forward is
  `127.0.0.1:<ephemeral>` to the guest's attested control front, port 8444.
- **Verification.** It uses the image commit's own `verifyMeasuredControl` with a fresh nonce:
  - real AMD collateral, a COPY of the public cache (Turin chain; CRL nextUpdate 2026-11-09; 1 VCEK);
  - `TCB_FLOORS` and `crl: "required"`.

## Acceptance (all REQUIRED; `result.json` names any failure)
**The verifier's `acceptance.pass`:**
- **Published verifier checks:** statement; config + HOST_DATA; TLS peer = the attested key; AMD report with the expected
  measurement fe897820…; the running supervisor holds the minted keys.
- **Archived evidence:**
  - HTTP 200; config digest and HOST_DATA = the owner config;
  - TLS peer = the statement key, from the same boot;
  - mode `snp`;
  - the runtime hashes equal the 493 build inputs:
    - `gsupSha256` 07e05839…
    - `helperSha256` 26a8982c…
    - `supervisorSha256` 2c87a36f…
  - no `mcpSha256` or `platformApiSha256`;
  - **NEW:** no `native` member in the statement.

**Harness checks (unchanged):**
- frozen pins hold at the launch boundary;
- exactly one QEMU start;
- the QEMU argv is the measured cmdline, the pinned OVMF, kernel and initrd, 4 vCPU / 4096 MiB, kernel-hashes,
  host-data = HOST_DATA, a restricted netdev with exactly one loopback forward to 8444, no drives, and the pinned QEMU;
- no-key evidence comes from the launcher's own host config and fw_cfg;
- the fw_cfg file is 0600 in a 0700 directory;
- every owned process is absent and no foreign group was signalled;
- the protected QEMU identities are unchanged: 3483499 starttime 87503396 and 3817658 starttime 32598976;
- the user services and the enclave-* MainPID identities are unchanged;
- the collateral source is unchanged;
- private/ is removed.

**Diagnostic only:**
- the registry: expected `pending`, because `https://direct-control-canary.invalid` is unregistered and `--registry off`
  is used; it is never faked;
- the operator label;
- `chipId`, newly reported by the 493 verifier.

## Root commands (in this order; nothing here was executed by Claude)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-final-canary
sha256sum FROZEN-PINS.json        # must print 280c89d36914b92c3f04668778dc3072ab0ff082e724dfc991d35feb98ad4aa7
. tools/env.sh                    # ssh/scp/sftp stubs first in PATH (shell + node child proved)
python3 canary/run-canary.py --preflight                      # read-only; must end PREFLIGHT PASS
python3 canary/run-canary.py --run --kds off --registry off   # ROOT ONLY; both queue lanes free
```

**Lanes and memory.** `--run` takes BOTH shared queue lanes without blocking. If any lane is busy it exits 98 and creates
nothing. It needs MemAvailable >= 16384 + 6144 + 1024 = 23552 MiB.

**Pins.** It re-verifies all 20 frozen pins twice: before creating `runs/<UTC stamp>` (0700, never reused), and in the
child just before the launcher starts.

**Supervision.** The run executes inside:
```
systemd-run --user --scope --expand-environment=no --unit=enclave-direct-control-canary-<stamp>-<rand> -p MemoryMax=6144M -p MemorySwapMax=0
```
followed by memory-guard (6144 MiB, floor 16384) and `timeout --kill-after=40s 330s`. The verifier deadline is 210 s, so
the wall clock is about 6 minutes at most.

**Network.** With `--kds off --registry off` the host makes no network call. If the cached VCEK does not match the chip's
current TCB, the report check fails closed (honest).

## Terminal evidence root must inspect (as for the reviewed run)
- **`terminal.json`:**
  - `cgroupEmpty: true` (observed, not unknown);
  - `scopeActiveState: inactive`;
  - `ownedAbsenceProven: true`;
  - `survivors: []`;
  - `privateAbsent: true`;
  - `code: 0`.
- **`result.json`:**
  - `ok: true`, `failed: []`;
  - `acceptance.pass: true`, including `evidence: bare roles (no native control names in the statement)`;
  - `protectedQemuIdentitiesUnchanged`, `userServicesUnchanged` and `collateralSourceUnchanged` all true.
- **`verify-result.json`:** `final.identity.measurement` equals fe897820…, and the raw evidence document is there for
  offline re-verification.

## Not covered (stated limits)
- **Bare direct control only.** The run proves:
  - the actual new image boots and its runtime starts;
  - the HOST_DATA-bound config;
  - the attested control TLS key;
  - the hardware measurement.

  It is NOT Platform API group activation or failover, MCP readiness, native-control-name issuance or TLS, registration,
  or selling. No API, MCP or native TLS success can be claimed from it.
- **One host.** One chip, one boot, 4 vCPUs. The measurement differs for other vCPU counts or CPU signatures.
- **Platform API activation is separate.** Real activation still needs the steps in
  `native-final-image/public/ACTIVATION-REQUIREMENTS.json`:
  - 3 to 7 members;
  - admins and recovery keys;
  - sealed credentials;
  - genesis;
  - the reviewed admin CLI from 0eac0d60b or later;
  - trust lists;
  - registry;
  - native CA and discovery.
