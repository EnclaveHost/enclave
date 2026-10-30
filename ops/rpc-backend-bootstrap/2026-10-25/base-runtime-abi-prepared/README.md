# Base runtime ABI for M7 artifact `5aa7b291…` — host and Ubuntu smoke passed

Root validation, 2026-10-25 21:33 UTC: the pinned bundle passed its version/help, library-resolution, hash, and self-update-refusal checks on the build host and the production Ubuntu VM. See `logs/root-host-abi-2137.*` and `guest-2134/`. The VM run used a private directory, a network namespace with no active interfaces, a 512 MiB memory cap and a 920-second service limit. Existing node services were not changed.

The informational direct invocation with Ubuntu system libraries also printed `base 1.5.1`. These checks establish CLI loading, not TLS, P2P, database compatibility, synchronization or readiness. No new node has been activated.

## Findings from the actual binary (`logs/m7-closure.json`, `logs/m7-report.json`)

**Gathered directly (read-only):** `readelf` and `pacman -Qo` only. Nothing from the artifact was executed.
- **Environment then:** 0 `LD_*` variables; `/etc/ld.so.preload` absent on the build host.

| | the binary REQUIRES (highest version node) | Ubuntu target provides (root, 19:34) |
|---|---|---|
| glibc | **`GLIBC_2.39`** | glibc 2.39: **equal**, so no margin |
| OpenSSL | **`OPENSSL_3.0.0`** (libssl/libcrypto `.so.3`) | OpenSSL 3.0.13 |
| libstdc++ | `GLIBCXX_3.4.30`, `CXXABI_1.3.15` | **not checked on the target** |
| libgcc_s | `GCC_4.2.0` | not checked |

- **Interpreter:** `/lib64/ld-linux-x86-64.so.2`. No RPATH or RUNPATH, and nothing missing.
- **Through the closure** (the Arch libraries' own needs), the highest are `GLIBC_2.44`, `OPENSSL_3.6.0` and
  `GLIBCXX_3.4.36`. These matter only for the bundle, which carries those libraries.

**What this means:**
- **By symbol versions alone**, the binary MAY run on the target's system libraries.
- **This is necessary, not sufficient.** It says nothing about behaviour differences (for example OpenSSL 3.0 against
  3.6 defaults and providers), the target's libstdc++, or glibc 2.39 exactly at the boundary.
- **Two options remain open:** (a) the target's system libraries; (b) the private bundle. Only the guest smoke informs
  the choice, and it runs both.

## Corrections to earlier ABI statements (`ops/rpc-base-build/2026-10-25/runtime-abi/README.md`, root-committed; not edited here)

1. **"If the binary requires a `GLIBC_` version above 2.39 … it cannot run":** the actual requirement is exactly
   2.39, so it does not exceed the target.
   - **"`OPENSSL_3.6.0` stand-in … would not run":** that was the fixture `openssl`. The Base binary needs only
     `OPENSSL_3.0.0`.
   - **Consequence:** the bundle is a pinning and robustness choice, **not** a proven necessity.
2. **"Base uses rustls or OpenSSL: unknown":** Base links **libssl.so.3 and libcrypto.so.3** dynamically. Whether TLS
   goes through them, or through a Rust TLS stack, is still not established. The CA plumbing (`OPENSSL_CONF`,
   `SSL_CERT_FILE`/`DIR`) applies to the OpenSSL path.
3. **The closure:** it also includes **libstdc++** (`libstdc++ 16.2.1`) and zlib, zstd and brotli, through libcrypto.
4. **Status:** "The M7 binary does not exist yet" is superseded. It exists (`5aa7b291…`) and is a resumed RUN 1.
5. **Unchanged:** the fixture results (8 groups, host only) and the LD_* limits stand.

## Bundle (build host: `finality-stage/base-runtime-abi/bundle-5aa7b2919870/`; NOT committed, about 305 MB)

**Bundle `SHA256SUMS` = `7c11d6a0433c37228c5894e36eb804b5090d8bd4b46d80facf39481efb0bab75`.** A copy is in
`bundle-meta/`, together with `MANIFEST.json` `044b602b…`, `run` `567a8551…` and `openssl.cnf` `bb99ad5a…`.

| file | sha256 | Arch package |
|---|---|---|
| `bin/base` | `5aa7b2919870950f1dd90249d3900730184e3ce6b5a54048b3dbca2a72ef430c` | (the M7 artifact) |
| `lib/ld-linux-x86-64.so.2` | `f5e11cc62f8f2c24dff532982559f4303dba3b17e7450551372a88c8e7ea8757` | glibc 2.44+r50+g1848099f063e-1 (== the native verifier's pinned loader) |
| `lib/libc.so.6` | `02c8c3d06180beee9c7d0392aa85736c7d19f274a81e7f8f0b3d9e28e0641524` | glibc (== the verifier pin) |
| `lib/libm.so.6` | `965106704753eefe8c31ae7da6daba3ead3d18c52b19b5fcc41178bcc4aa999d` | glibc (== the verifier pin) |
| `lib/libgcc_s.so.1` | `e618cb9c90c2eb3a1dad1cfea5b6c1eebcf2e799ad805976f4ae47bdd61c716a` | libgcc 16.2.1+r23 (== the verifier pin) |
| `lib/libstdc++.so.6` | `f5fc7380f2ae46fa4053a64be04e7b98109f1066a4bbfff3c37042488aa0be0e` | libstdc++ 16.2.1+r23+gd564253eb6c8-1 |
| `lib/libssl.so.3` | `f6409e9f083faae79a622c9534be6ed2456d0102cd8ea2b52eb18c9d72f1f41e` | openssl 3.6.5-1 |
| `lib/libcrypto.so.3` | `a75a864dcda6ef9e4dc29fad4b7988ca832b904c3915a63c920062c40763dae1` | openssl 3.6.5-1 |
| `lib/libz.so.1` | `6c78c5e58c3bb49a1cd151a95cdf1a17fe07a91a57a59e0279b984c533075ca9` | zlib 1:1.3.2-4 |
| `lib/libzstd.so.1` | `f023d49e85fb22057bfdd21857263d2638b73356c06f3b342f678a75212379f8` | zstd 1.5.7-3 |
| `lib/libbrotli{common,dec,enc}.so.1` | `4f895094…`, `0883fb05…`, `8dbc5391…` | brotli 1.2.0-1 |

**Provenance:** the libraries are signed Arch distribution bytes, attributed by `pacman -Qo` here. The glibc and libgcc
package signatures were verified earlier (native-provenance audit). For openssl, libstdc++, zlib, zstd and brotli,
package-signature verification is **not done here**; root can use `pacman-key --verify` on the cached packages.

**Source notice:** any distribution of the bundle must carry the licences (LGPL-2.1+ glibc, GPL-3.0+ with the GCC
Runtime Library Exception for libgcc and libstdc++, Apache-2.0 OpenSSL, zlib, BSD zstd, MIT brotli) and point to the
corresponding sources for these exact versions.

## Environment safety: what is and is not covered (no hermeticity claim)

**Parent environment:**
- `guest-smoke.sh` **refuses** if any `LD_*` variable is present, or if `/etc/ld.so.preload` exists. Both the system
  loader (for the shell itself) and the bundled Arch loader honour these before any script line runs.
- The parent must therefore already be clean. The commands below start from `env -i`.
- **Root's own login shell must have no `LD_*`**, because `env`, `unshare` and `timeout` are loaded by the system
  loader with that environment. Check with `env | grep -c '^LD_'` = 0.

**What is pinned:** only the dynamic-library closure, verified by the `--list` guard: every library must resolve inside
`lib/`.

**Still taken from the machine:**
- the kernel, `/proc` and `/sys`;
- `/etc/hosts`, `nsswitch.conf` and `resolv.conf`;
- `/etc/ssl/certs`;
- the locale (`C.UTF-8` is built in);
- gconv;
- `/bin/sh`, `awk` and `dirname` for the wrapper;
- `python3` and coreutils for the scripts.

**NSS modules beyond `files`/`dns`** are not in the bundle, so they behave as unavailable.

**Pin bypass:** none is intended.
- `bin/base` is checked against the MANIFEST, the SHA256SUMS and the expected sha.
- The system-library run in `guest-smoke.sh` is **informational only**, and labelled as not the deployment path.

## Host smoke (passed; earlier queue refusals retained)

`host-smoke.sh` reuses the existing bundle after `sha256sum -c` and runs **the same `guest-smoke.sh`**:
- the pins, the MANIFEST and the guard;
- an informational direct run on the system libraries;
- `smoke.sh`: SHA256SUMS, the binary pin, the guard, `--version`, `--help`, the M7 flag in the subcommand help, and
  `update` refused.

Root command:

```sh
A=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/base-runtime-abi
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $A/logs/host-smoke.guard -- env -i PATH=/usr/bin:/bin LANG=C.UTF-8 HOME=/nonexistent unshare -rn bash $A/host-smoke.sh > $A/logs/host-smoke.out 2>&1; echo $? > $A/logs/host-smoke.rc
```

## Guest smoke (ready to run by root; read-only; private temp path; no DB, no network, no service)

Transfer set: `bundle-5aa7b2919870/` (whole directory), `abi.py` `3c5edab1`, `smoke.sh` `e3f14390`, and
`guest-smoke.sh` `57acc693`. Root chooses the reviewed transfer method.

```sh
# on the Ubuntu guest, as root, from a shell with NO LD_* variables:
env | grep -c '^LD_'                                   # must print 0
D=$(mktemp -d /root/base-abi-smoke.XXXXXX)             # private 0700; nothing under /opt, /etc, /usr is written
#   copy bundle-5aa7b2919870/, abi.py, smoke.sh, guest-smoke.sh into "$D" (preserve modes), then:
(cd "$D/bundle-5aa7b2919870" && sha256sum -c --quiet SHA256SUMS) && mkdir "$D/home"
env -i PATH=/usr/bin:/bin LANG=C.UTF-8 HOME="$D/home" unshare -n timeout 900 \
  bash "$D/guest-smoke.sh" "$D" 5aa7b2919870950f1dd90249d3900730184e3ce6b5a54048b3dbca2a72ef430c \
  7c11d6a0433c37228c5894e36eb804b5090d8bd4b46d80facf39481efb0bab75 > "$D/guest-smoke.out" 2>&1; echo $? > "$D/guest-smoke.rc"
#   copy guest-smoke.out/.rc back for review, then: rm -rf "$D"
```

**What it does:** with no interface up (`unshare -n`), it runs only `--version`, `--help` and the subcommands' `--help`
(30 s each). It uses no datadir, starts no service, and opens no network.

**What a pass shows:** only that the binary starts and parses its CLI on the guest under the bundle. The extra line
`direct system-library run` shows whether the target's own libraries also load it.

**What a pass does not show:** TLS, P2P, sync, database compatibility, or readiness.

## Files

- `abi.py` and `smoke.sh` are unchanged from the fixture-tested versions.
- `guest-smoke.sh` and `host-smoke.sh` were executed by root; their evidence is included.
- `fixture-test.sh` and `logs/fixture.*` are the earlier host fixture.
- `logs/m7-*`: the direct metadata derivation. The first attempt failed only because `/usr/bin/time` is absent (rc 127,
  nothing produced), and that record is kept.
- `logs/host-smoke-attempt*-NOTSTARTED.*` are the not-started queue records.
- `bundle-meta/` holds the non-binary bundle files.
