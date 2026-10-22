# Direct-control hardware canary: root recipe (NOT RUN)

Prepared by Claude for root (author/committer for any commit: SteveDeFacto). No QEMU was launched. No hardware run has
happened. Root executes once, after reviewing this exact source, by the pins in `FROZEN-PINS.json`.

## What one run does (scope)

- **Image and launcher.** It boots the exact built image `measured-image-build/image/dist-direct-6f2c7da46` once, as one
  SNP guest. The PUBLISHED launcher `tree/metal/enclave-metal.mjs` (a git archive of `6f2c7da4`) does the boot, in direct
  mode, with 4 vCPU and 4096 MiB.
- **Measurement.** The expected measurement is the receipt's full 96-hex value:
  `bdadc7bb667eac1ff783b4538991cc6dafcda9c89b80a5d4b60a0f280e32e2ee0c45dd0b4f3f3415c347c30651b597e6`
- **Config.** The owner config is BARE: no registry key, not selling, no fleet secret, no relay or tunnel, no
  certificate or ACME input, no apps, no MCP and no Platform API member.
- **guestd.** The guestd endpoints are `10.0.2.2:<two loopback ports with no listener>`. They are never production
  `8095/8096`.
- **Network.** slirp runs with `restrict=on` (`canary/qemu-restrict.sh`). The only port forward is
  `127.0.0.1:<ephemeral>` to the guest's attested control front (8444), never the plain supervisor port 8080.
- **Verification.** `canary/verify-canary.mjs` runs the published `verifyMeasuredControl` with a fresh nonce:
  - real AMD collateral (a COPY of the existing public cache; its CRL is valid until 2026-11-09);
  - the published `TCB_FLOORS` and `crl: "required"`.
- **Scope of the proof.** It covers BARE direct control only: the hardware quote, the HOST_DATA-bound config, the attested
  TLS key, the running supervisor's minted keys, and the exact runtime (gsup, helper, supervisor) of the built image. It
  is NOT MCP or Platform API service readiness, and NOT a registration.

## Acceptance (all required; the run's `result.json` lists any failure by name)

**The verifier's `acceptance.pass`:**
- **Published verifier checks:** statement; config + HOST_DATA; TLS peer = the attested key; AMD report verified with the
  expected measurement; the running supervisor holds the minted keys.
- **Archived evidence:**
  - HTTP 200; config digest and HOST_DATA equal the owner config;
  - TLS peer = the statement's key, from the same boot as the verifier;
  - mode `snp`;
  - runtime `gsupSha256` / `helperSha256` / `supervisorSha256` equal the build's inputs;
  - no `mcpSha256` or `platformApiSha256`.

**Launch and cleanup checks in the harness:**
- frozen pins hold at the launch boundary;
- exactly one QEMU start;
- the QEMU argv is the measured cmdline, the pinned OVMF, kernel and initrd, 4 vCPU / 4096 MiB, kernel-hashes, host-data =
  the config's HOST_DATA, `user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:P-:8444` only, no drives, the pinned QEMU;
- no-key evidence from the launcher's OWN host config and the fw_cfg it wrote:
  - registryKey, fleetSecret, relayUrl and tunnelToken are empty;
  - no certsApi or ACME input, no volumes, no lease gas, no nomination;
  - direct = the owner config;
  - isolation = the refused stand-ins;
- the fw_cfg file is 0600 in a 0700 directory;
- every owned process is absent and no foreign group was signalled;
- the protected QEMU identities are unchanged;
- the running user services and the enclave-* MainPID identities are unchanged;
- the collateral source is unchanged;
- private/ is removed.

**DIAGNOSTIC only:** the registry is expected to be `pending`, because `https://direct-control-canary.invalid` is not
registered. It is read read-only through the config's public RPC quorum, or not read with `--registry off`. A registry
result is never supplied or faked, and it cannot compensate for a failed check. The configured operator label is also
diagnostic.

## Commands (root)

```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/direct-hardware-canary
sha256sum FROZEN-PINS.json        # must print 6025fff2c77f368f797c93c0ea0676eaaded7dac9902db07012507946f877cf5
. tools/env.sh                    # ssh/scp/sftp stubs first in PATH (proved: shell + node child)
python3 canary/run-canary.py --preflight          # read-only; must end PREFLIGHT PASS
python3 canary/run-canary.py --run                # [--kds on|off] [--registry on|off]; default on/on
```

- **Memory.** `--run` takes BOTH shared queue lanes non-blocking (exit 98, nothing created, if any queue job is running:
  storage interop currently holds the large lane, so wait for a quiet window). It needs MemAvailable >= 16384 + 6144 +
  1024 = 23552 MiB.
- **Pins.** It re-verifies all 20 frozen pins: before creating the run, and again in the child just before the launcher
  starts.
- **Run directory.** It creates `runs/<UTC stamp>` (0700, never reused).
- **Supervision.** It runs:
  `systemd-run --user --scope --expand-environment=no --unit=enclave-direct-control-canary-<stamp>-<rand> -p MemoryMax=6144M -p MemorySwapMax=0`
  followed by memory-guard (6144 MiB, floor 16384) and `timeout --kill-after=40s 330s`, around the child.
- **Bounds.** Wall clock is about 6 minutes at most (verifier deadline 210 s).
- **Cap.** The QEMU cap is MemoryMax 6144 MiB (the 4096 MiB guest plus 2048 MiB of QEMU, launcher and verifier overhead).
  Root coordinates it before execution.
- **Zero network.** `--kds off --registry off` makes no network call from the host. If the cached VCEK does not match the
  chip's current TCB, the hardware check then fails closed (honest), and the registry stays `pending: no reader`.

## Cleanup guarantees (code paths, tested on disposable processes)

- **Child.** It signals the launcher's process group only while an owned (pid, starttime) identity is alive AND still in
  that group (a group id cannot be reused while a member lives). The sequence is SIGTERM, bounded waits, then SIGKILL. It
  then proves every owned identity (the launcher and every process it spawned) absent, and removes private/ (fw_cfg, test
  pairing key, host config, collateral copy).
- **Parent `supervise()`.** On every exit path (normal end, exception, SIGTERM/SIGINT/SIGHUP) it:
  - stops ONLY its uniquely named transient scope;
  - proves the scope inactive, its cgroup empty, and that no process names the run directory;
  - only then scrubs a leftover private/ (for example after memory-guard SIGKILLed the child);
  - keeps logs and results, and writes `terminal.json`.
- Nothing is killed by name; the protected QEMUs (3483499, 3817658) are only read.

## Outputs (runs/<stamp>/, public, sanitized)

- **Run record:** `attempt.json`, `preflight.txt`, `command.json`, `launcher.json`, `protected-before.json` /
  `protected-after.json`.
- **Configs:** `owner-config.json` (the bound public config) and `host-config.public.json` (the key path redacted).
- **Launch evidence:** `qemu-argv.json`, `serial.sanitized.log`.
- **Verifier:** `verify.log`, `verify-result.json` (with the raw evidence document for offline re-verification) and
  `verify-result.json.acceptance.json`.
- **Outcome:** `result.json`, `terminal.json`, `memory.log`, `execution.log`.

## Not covered (stated limits)

- **Platform API / MCP roles.** Their prerequisites are not exercised:
  - Platform API: 3 to 7 registered members with distinct operators, admins/recovery keys, sealed credentials after boot,
    genesis;
  - MCP: a nonzero `sessionVaultFactory`, directories, a port.
  Their bundles' presence and closure were verified in the image build.
- **Registration and selling:** no registration, no selling, no app launch, no guestd.
- **Production:** no allowlist, DNS or production config change.
- **One chip only:** one chip, one boot, 4 vCPUs. The measurement differs for other vCPU counts or CPU signatures.
