> **Superseded FOR THE NEXT TREE SWITCH by 79c5ecf2 (aa6c985c, init links musl), 2026-09-25.** a4f22748 is
> installed and is production guestd's -isolation tree since 4d; it stays live, and the rollback, until enclave-63's
> reviewed switch. See `../production-release-aa6c985c/`.

# Production domain release a4f22748 (image commit 17e182a8), 2026-09-25

**Release id: `a4f227482df4830ab69b52e38dc5d6e2abea9e5c5fb71f5469f0c30e6b1cb784`** (= sha256 of `release.json`).
Format enclave-m4a-domain-release/1, cmdline `console=ttyS0 rdinit=/init loglevel=3`, measure snp / QEMU / family 26
model 2 stepping 1.

It SUPERSEDES 0839ac3a (ecf02384), which is installed inert on warden-host (enclave-63) and stays inactive.

## The change: an app's output never reaches the host (Codex's decision)
In 0839ac3a, dominit started the app and wasmtime with PID 1's stdin, stdout and stderr, which is the serial console, a
file the host reads. A request an app logged, its config, a panic or a runtime trap reached the host, and the host could
type into the app's stdin. Codex: fix it before real tenant secrets are released on this tier; discard the output where
no owner-only log path exists; keep the control lines the host needs.
- **77cf2d78.** `spawn(..., quiet)`: the app child gets /dev/null for fds 0-2 before exec. It keeps a close-on-exec
  console copy only to report its own exec failure, and exits 126 if /dev/null cannot be opened. The front keeps the
  console for its `DOM ...` lines. Only `template/init` changes; the front is 0839ac3a's (bd066066…).
- **Verified on real SNP, with a positive control** (`isolation/m2/lab-release/evidence/output-2026-09-25/`, 17e182a8):
  - a sentinel app printing run-tagged lines (start, each request's path, a panic) on stdout and stderr;
  - 0181bce3's image on the same lab guestd shows every sentinel in its serial;
  - the new image's serial shows none, and keeps DOM serving / started / app config / ERROR app exited;
  - the requests sent only to the new guest appear nowhere on the host;
  - that lab guest's AppID and measurement (6b16ffec… / 2dfde452…) equal `expected-measurement.sh --pin a4f22748…` on its
    bundle, so the lab ran THIS release's image.
- **Owners get no app logs** from a per-app SNP guest: the output is discarded, since this tier has no owner-only log
  channel. Kernel console messages at loglevel <= 3 still reach the serial; they carry no tenant data.

Built on warden-host at 19:51:58Z by `isolation/m4/domain-release.sh`, in a clean worktree detached at 17e182a8
(`status --porcelain --ignored` empty; GOFLAGS and ISOLATION_LAB_FRONT unset), go1.27.0-X:nodwarf5. The artifact is
`~/enclave-bench/prod-release-17e182a8/release-17e182a8`. It is owner-writable: the manifest pins contents, not modes. It
is NOT installed, pinned by any relay, or run by any guest.

## Checked
- **Reproducible.** A second build in a separate clean worktree with a COLD Go cache gave the same id, and every file
  was byte-identical.
- **A production front** (unchanged from 0839ac3a). No build tags. It contains `api.enclave.host` and the pinned key
  (d6c8a959…, keyId 06212e5df9c3779a) once each, and no lab strings. It contains the "HOST_DATA unreadable" refusal.
- **Against 0839ac3a:** only `template/init` differs.
- **Against the live 5c3561f9 (0181bce3):** `template/front` and `template/init` differ. The kernel, firmware, runtime
  set and guest modules are byte-identical.
- front `bd066066d573b9978af3ac7ed456deae9c6e8392976c2a473530979be8e87bd1`, init
  `3ae4c7e502122d99215d327ff43b00553105d34baa4ce3b2d9335608fc8f19d0`. Everything else is in files.txt.

## One app's measurement under it (a cross-check; the relay predicts every deployment's own)
api-mcp-adapter 1.0.0, phase 2's derived bundle (AppID 94c04c0e…, runtime ccadb38a…, 1 vCPU):
**`38b90458cf061ea5a6716f1a1201a5aa5b971ab31e91cec1707939a65f01f1809ddf3fe2ed8d764bc586c21353be2a93`**

## Carried over from 0839ac3a (see ../production-release-ecf02384/RELEASE.md)
- Secrets reach the app ONLY through config placeholders (the recorded parity gap). The per-app S5 checks are in
  `isolation/restore/inventory-2026-09-25/INVENTORY.md`.
- e3's accepted lows: the post-substitution size check, the parse-error character, aef54ff7's M3-only fallback, and
  the CPUID `snp` bit.

## Reviews
- The front is ecf02384's, which enclave-d1 and enclave-e3 APPROVED (e3's image sign-off over 0181bce3..ecf02384 is
  complete).
- **enclave-d1: APPROVED 77cf2d78 and release a4f22748.** d1 checked the raw lab files: the control's serial has 11
  tagged lines, the new one's has 0, and the new-only paths appear in no host file and on no journal line. d1 also
  reproduced the release independently: a clean worktree, a fresh GOCACHE, byte-identical `diff -r`.
- **enclave-e3 (for enclave-99): APPROVED 77cf2d78.** e3 found no other path from the app to the console:
  - /app.run is closed before any spawn;
  - the init pipe is O_CLOEXEC, and PID 1 closes both ends after reading;
  - at the app's spawn, PID 1 holds only fds 0-2, and those become /dev/null;
  - WASI grants only /data and loopback sockets.
  The image diff ecf02384..17e182a8 is dominit.c alone.
- **The relay's predictor agrees, ON NAN.** e3 ran it in a transient unit with the api-relay's own sandbox
  (DynamicUser, ProtectSystem=strict, MemoryMax=768M), through the relay's predictorEnv path, with two agreeing RPCs:
  known answers 2/2, then api-mcp-adapter under a4f22748 = 38b90458…2a93, the value above. It is staged at
  /opt/enclave-predict/829c09adb176 on nan; nothing else changed there.
- **So a4f22748 is fully reviewed** (d1 and e3), with the image sign-off over 0181bce3..17e182a8 complete.
