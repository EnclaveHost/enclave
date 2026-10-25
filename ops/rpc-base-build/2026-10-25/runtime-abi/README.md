# Private pinned runtime bundle for the M7 Base binary: recipe and harness (2026-10-25)

**Status: PREPARED, validated by a HOST FIXTURE ONLY.**
- **Not tested on the real binary:** the M7 Base binary does not exist yet. Root build `exec7707` (RUN 1) is still
  compiling. **No Base smoke has run, on the build host or on the Ubuntu target.**
- **Nothing claimed:** no Base artifact hash, no symbol-version or ABI compatibility, and no target behaviour.
- **Nothing done:** nothing installed, transferred or launched. No SSH, no VM change, no download.
- **Scope:** this directory only. The parent publication (`../README.md`, `../recipe/`, `../prechecks/`,
  `../SHA256SUMS`) is unchanged.

## Why a bundle may be needed

The binary will be built on Arch (glibc 2.44, OpenSSL 3.6.5). The live target is Ubuntu x86_64 with glibc 2.39 and
OpenSSL 3.0.13 (facts verified read-only by root at 19:34).
- **When it is needed:** if the binary requires a `GLIBC_` symbol version above 2.39, or links OpenSSL with
  `OPENSSL_3.x` versions above 3.0.13, it cannot run on the target's system libraries.
- **What is unknown:** whether that is the case. `abi.py report` decides it from the finished binary.
- **What the fixture showed:** the Arch `openssl` stand-in needs `OPENSSL_3.6.0`, so it would not run on the target's
  system libcrypto. That says nothing about Base's own requirements.

## Design: the same pattern as the native verifier's glibc runtime

The pattern is `metal/chain-verifier-image.json` `glibcRuntime` plus `network/rpc-runtime.mjs` `viaGlibc`.
- **What is used:** the build host's own package-owned loader and libraries.
- **How it runs:** `lib/ld-linux-x86-64.so.2 --inhibit-cache --library-path lib bin/base …`.
- **What stays unchanged:** the binary's bytes and pin (no patchelf). The target's system libraries are not replaced.
- **Fixture loader:** `/usr/lib/ld-linux-x86-64.so.2` == `f5e11cc6…`, the loader already pinned for the verifier.

| file | role |
|---|---|
| `abi.py` | `closure` (DT_NEEDED closure, per-library sha256 and pacman owner, highest required symbol versions), `report` (compares those with the target's glibc and OpenSSL; advice only), `bundle` (refuses an existing output dir, a wrong binary pin, unresolved or unowned libraries, an unexpected interpreter, RPATH/RUNPATH), `guard` (`ld.so --list` must resolve EVERY library inside the bundle's `lib/`) |
| bundle output | `bin/base` (0555), `lib/` (loader 0555, libraries 0444), `run` (POSIX sh wrapper), `openssl.cnf` (minimal: default provider only), `MANIFEST.json` (pins and host package of every file), `SHA256SUMS` |
| `smoke.sh BUNDLE SHA` | for the real binary, on the build host and unchanged on the target. Checks: SHA256SUMS; `bin/base` == pin; guard; `--version`; `--help`; the M7 flag `BASE_NODE_L1_TRUST_RPC` in subcommand help; `update` refused. **Never run.** |
| `fixture-test.sh` | host fixture of the mechanics, with Arch `/usr/bin/openssl` and `/usr/bin/getent` as stand-ins (no compile) |
| `logs/fixture.{out,guard,rc}` | the fixture's record |
| `SOURCE-NOTICE.md` | the launcher source changes an activation would need. **Proposed only; not applied, not tested.** |

## Fixture result: HOST ONLY

**Run.** On the Arch build host, via `work/claude-test-queue.py --mib 256` (16 GiB floor), inside `unshare -rn`. rc 0,
peak 71 MiB.

**Prior failing run.** `logs/fixture.guard` also records it: rc 1, peak 65 MiB. Four defects caused it, and all were
fixed before the passing run:
- the loader was overwritten 0444 by the library loop;
- `/usr/lib/…` interpreters were rejected;
- the T4 assertion was weak;
- the T5 counting logic was flawed.

| test | observed on the host fixture |
|---|---|
| T1 | complete closure, all package-owned; loader sha == `f5e11cc6`; `report` gives `OPENSSL_3.6.0` > 3.0.13, `GLIBC_2.38` ≤ 2.39 |
| T2 | bundle built; SHA256SUMS verify; a wrong binary pin refused |
| T3 | through the wrapper the program reports OpenSSL 3.6.5 (the bundled libraries); guard OK |
| T4 | with `libcrypto.so.3` removed, the loader silently falls back to `/usr/lib/libcrypto.so.3`. The guard reports it and the wrapper exits 65. This is the reason for the guard: `--inhibit-cache` does NOT stop the loader's built-in default dirs. |
| T5 | see "LD_* scrub" below |
| T6 | with a local test CA: `SSL_CERT_FILE` honoured; verification fails without it; the pinned `openssl.cnf` loads the default provider |
| T7 | bundled getent: `localhost` resolves via `/etc/hosts` (glibc's built-in `files` NSS) |
| T8 | `run update` refused (64) |

**What the fixture does NOT show:**
- anything about the Base binary's closure, versions, startup, TLS stack or networking;
- anything on Ubuntu, under Ubuntu's `nsswitch.conf`, `/etc/ssl`, locale or gconv layout, or as user `rpcbase`.

## LD_* scrub: limited scope (read this before relying on the wrapper)

The `run` wrapper's `unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT …` only affects processes the wrapper starts after that
line: its helpers, the bundled loader's `--list`, and the final `exec`.
- **It does NOT protect the wrapper's own start.** `/bin/sh` is loaded by the system loader, which honours `LD_*`
  before any wrapper line runs. The fixture observed this: exactly one preload warning, from the shell itself, against
  4 for an unscrubbed control copy. The same holds for any interpreter (for example `python3` running
  `chain_service.py`).
- **What is actually required:** a trusted parent (the systemd unit or service manager) must launch with `LD_*`
  ABSENT. Nothing here makes an arbitrary parent environment safe, and the tests do NOT prove that.
- **Root check on the target (read-only):**
  - no `Environment=LD_*` in the units;
  - no `LD_` entry in `systemctl show-environment`;
  - `/etc/ld.so.preload` absent. Both the system loader AND the bundled Arch loader read that file, and
    `--inhibit-cache` does not disable it. This was **not tested.**

## Pitfalls reviewed (to check with the real binary)

- **Library fallback:** a library missing from the bundle falls back to the loader's default dirs (Arch-compiled:
  `/usr/lib`). The guard covers this. On Ubuntu `/usr/lib` mostly lacks those sonames, but resolution still must not be
  assumed.
- **OpenSSL:** applies only if the closure contains libcrypto/libssl. The Arch libcrypto has OPENSSLDIR `/etc/ssl` and
  default cert `/etc/ssl/cert.pem`, which Ubuntu lacks. The wrapper therefore sets `OPENSSL_CONF=<bundle>/openssl.cnf`
  and `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`, `SSL_CERT_DIR=/etc/ssl/certs` (Ubuntu paths, overridable).
  - If Base uses rustls instead (webpki or native roots), the CA behaviour is different and must be checked.
  - The snapshot download (`stage_backend.py:65`) is the HTTPS user.
- **NSS:** `files` and `dns` are built into glibc ≥ 2.34. Other modules listed in the target's `nsswitch.conf` (for
  example `resolve`, `mdns4_minimal`, `systemd`) are not found by the bundled glibc and are treated as unavailable. The
  effect depends on the target's action specs and was **not tested.**
- **Locale and gconv:** the service sets `LANG=C.UTF-8`, which is built into glibc ≥ 2.35. Other locales and iconv
  modules would be looked up at Arch-compiled paths. Not tested.
- **Process identity:** under an explicit loader `/proc/PID/exe` is the loader, not `bin/base`, and `current_exe()`
  names the loader.
  - `base update` (`bin/base/src/commands/update.rs`) would update the wrong file, so the wrapper refuses it (64).
  - No `/proc/PID/exe` matching was found in `rpc-backend-bootstrap`. External monitoring was not reviewed.
- **Service user:** units run as `rpcbase`. The bundle files are root-owned 0555/0444 in 0755 dirs, readable but not
  writable by the service.

## Exact commands for root (NOT run; for after RUN 1 closes and root confirms its hash)

On the build host:

```sh
W=/home/steven/Documents/Codex/2026-10-18/wo/work; P=$W/rpc-production-final-20261025
R=$P/source/ops/rpc-base-build/2026-10-25/runtime-abi; S=$P/finality-stage/base-runtime-abi
BIN=$P/finality-stage/client-integrity-next/production-build/out-1/base
H=<64-hex sha256 of out-1/base from the CLOSED build-1 log, root-confirmed>   # never taken from this package
(cd $R && sha256sum -c SHA256SUMS) && [ "$(sha256sum < $BIN | cut -c1-64)" = "$H" ]
Q="python3 $W/claude-test-queue.py --mib 256"     # the queue prints its own lines on stdout: write results INSIDE the job
$Q --log $S/logs/closure.guard -- unshare -rn sh -c 'python3 -I "$0" closure "$1" > "$2"' $R/abi.py $BIN $S/logs/closure.json
python3 -I $R/abi.py report $S/logs/closure.json --target-glibc 2.39 --target-openssl 3.0.13 | tee $S/logs/report.json
$Q --log $S/logs/bundle.guard -- unshare -rn python3 -I $R/abi.py bundle $BIN --expect-sha $H --out $S/bundle-${H:0:12} --name base
$Q --log $S/logs/smoke-host.guard -- unshare -rn sh -c 'bash "$0" "$1" "$2" > "$3" 2>&1' $R/smoke.sh $S/bundle-${H:0:12} $H $S/logs/smoke-host.out
```

- **Cap:** 256 MiB should suffice (`--help` only). On exit 99 (guard kill), do not count it as a pass. Rerun at 512 MiB
  only with that justification.
- **On a failed build-host smoke:** stop; do not take the bundle to the target.

On the target (root, through root's own reviewed transfer of `bundle-<h12>/` plus `abi.py` and `smoke.sh`). This
installs into a NEW directory only: no service, manifest, unit, app or admin control changes.

```sh
install -d -m 0755 -o root -g root /opt/enclave-rpc/runtime
cp -a bundle-<h12> /opt/enclave-rpc/runtime/base-<h12> && chown -R root:root /opt/enclave-rpc/runtime/base-<h12>
(cd /opt/enclave-rpc/runtime/base-<h12> && sha256sum -c SHA256SUMS)
test ! -e /etc/ld.so.preload; systemctl show-environment | grep -c '^LD_' || true     # expect: no LD_ entries
env -i PATH=/usr/bin:/bin LANG=C.UTF-8 bash ./smoke.sh /opt/enclave-rpc/runtime/base-<h12> $H
env -i PATH=/usr/bin:/bin LANG=C.UTF-8 runuser -u rpcbase -- bash ./smoke.sh /opt/enclave-rpc/runtime/base-<h12> $H
```

- **Second smoke:** the `rpcbase` run needs `abi.py` and `smoke.sh` readable by `rpcbase`.
- **What a pass means:** only that the binary starts and parses arguments under the bundle on the target. It is not
  sync, networking, TLS, or Base readiness.
- **Rollback of this step:** `rm -rf /opt/enclave-rpc/runtime/base-<h12>`. Nothing references it until the activation
  change in `SOURCE-NOTICE.md` is reviewed and applied.

## Activation and rollback (outline; needs the source change and root review)

See `SOURCE-NOTICE.md`.
- **Prerequisite:** activation needs a reviewed `chain_service.py` change and a separate runtime pin file.
- **Do not add the runtime pin to `/opt/enclave-rpc/manifest.json`.** The coverage receipt binds the sha256 of those
  exact bytes (`chain_service.py:282-283`).
- **Unchanged:** `/opt/enclave-rpc/bin/base` and `binaries.base` stay as they are.
- **Rollback:** restore the previous `chain_service.py` from its backup, remove the runtime pin file, and restart the
  base chain unit. The old exec path (`binary('base')` directly) is then used again.

## Source notices

- **Bundle contents:** the bundle redistributes Arch packages' binaries (glibc: LGPL-2.1-or-later; and, if in the
  closure, openssl: Apache-2.0, libgcc: GPL-3.0-or-later with the GCC Runtime Library Exception, zlib, zstd, brotli,
  and so on).
- **Recorded per file:** `MANIFEST.json` records each library's Arch package and version.
  - Corresponding source is available from the Arch package sources for those exact versions.
  - Root should keep the package list (or the cached signed packages, `pacman-key --verify`) with any distributed
    bundle.
- **Licence texts:** none are included here; nothing is distributed by this package.
