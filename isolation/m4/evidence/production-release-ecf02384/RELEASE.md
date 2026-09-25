> **SUPERSEDED by a4f22748 (17e182a8), 2026-09-25.** Codex decided that the app's output (PID 1's serial console,
> which the host reads) must not reach the host; 77cf2d78 gives the app /dev/null. 0839ac3a is installed inert and stays
> inactive. See `../production-release-17e182a8/`.

# Production domain release 0839ac3a (image commit ecf02384), 2026-09-25

**Release id: `0839ac3a859b7025abe261c56449d72f19fc8c4ed19ee50c63ab290718dfdb02`** (= sha256 of `release.json`).
Format enclave-m4a-domain-release/1, cmdline `console=ttyS0 rdinit=/init loglevel=3`, measure snp / QEMU / family 26
model 2 stepping 1.

It SUPERSEDES 31d117a9 (d1a38994), which superseded bca562cc (aff21c73). enclave-e3's second pass over the image
diff (for enclave-99) found one MEDIUM fail-open in 7de792bc, which enclave-d1 confirmed.
- **The flaw.** On the M2 SNP path, a HOST_DATA read that FAILED was taken for "no deployment", and the app started
  with no config, secrets or allowlist. The guest's later reports carried the right measurement and HOST_DATA.
- **The fix, ecf02384.** A failed read ends the domain, and init is handed nothing. Only a successful all-zero read
  means "none". The decision now lives in `releaseForInit`, and a test with a failing read fails on the old
  fall-through; that mutant was caught.
- That is the only change from d1a38994: `front/main.go` and a new test.

Built on warden-host at 19:35:36Z by `isolation/m4/domain-release.sh`, in a clean worktree detached at ecf02384
(`status --porcelain --ignored` empty; GOFLAGS and ISOLATION_LAB_FRONT unset), go1.27.0-X:nodwarf5. The artifact is
`~/enclave-bench/prod-release-ecf02384/release-ecf02384`. It is owner-writable: the manifest pins contents, not modes
(INSTALL.md 1a). It is NOT installed, pinned by any relay, or run by any guest.

## Checked
- **Reproducible.** A second build in a separate clean worktree with a COLD Go cache gave the same id, and every file
  was byte-identical.
- **A production front.** No build tags. It contains `api.enclave.host` and the pinned key (d6c8a959…, keyId
  06212e5df9c3779a) once each. It contains none of the lab relay name, the lab endpoint, `.enclave.test`, the lab key or
  the old path-logging format. It does contain the new "HOST_DATA unreadable" refusal.
- **Against 31d117a9:** only `template/front` differs.
- **Against the live 5c3561f9 (0181bce3):** `template/front` and `template/init` differ. The kernel, firmware, runtime
  set and guest modules are byte-identical.
- front `bd066066d573b9978af3ac7ed456deae9c6e8392976c2a473530979be8e87bd1`, init
  `2bd54d6cf62bb0a0a969995fdb5a352df19f3917ae1dffaada33f7204659f8ba` (unchanged). Everything else is in files.txt.

## One app's measurement under it (a cross-check; the relay predicts every deployment's own)
api-mcp-adapter 1.0.0, phase 2's derived bundle (AppID 94c04c0e…, runtime ccadb38a…, 1 vCPU):
**`75317f83601dcd040f64f34ff4120d8a697d9ef7c2671b6fcff08d350090dc623f955240b00ad71e46620e264880da29`**

## Secrets reach the app ONLY through config placeholders (recorded parity gap; unchanged from 31d117a9)
The standard runtime also gives the app each staged secret as its own `--env NAME=VALUE`. This tier does not. An app
that reads a secret from its environment would start without it. Record it per app before each app is restored (the
inventory: `isolation/restore/`). The per-app S5 checks:
- the staged set equals the names the config references;
- no staged name equals one of the app's own `$tokens` (enclave-d1).

## Known properties, recorded (not changed by this release)
- **App output reaches the host.** dominit starts the app and wasmtime with PID 1's stdout/stderr, which is the serial
  file the host reads. An app that logs a request, its config or a panic sends that to the host. It was the same at
  0181bce3. It belongs in the tenant docs, and a later release may redirect it (enclave-e3). This is a decision for
  Codex.
- **Accepted lows (enclave-e3):**
  - appconfig checks the resolved size only after substitution, as the standard runtime does. An oversized result
    exhausts only the owner's own guest, which fails closed.
  - A config parse error can echo one character to the console. The parse runs on the config BEFORE substitution,
    which comes from the chain or public IPFS and holds placeholders, not secret values.
  - aef54ff7's certificate-name fallback is keyed on a failed HOST_DATA read rather than on "not SNP". It is
    unreachable in this image (dominit passes no `-cert-name-file`); it matters only for M3.
  - `snp` comes from a host-supplied CPUID leaf. A host that clears it gets a guest with no SNP report at all, which
    trusted clients and the certificate gate refuse (enclave-d1).

## Reviews
- enclave-d1 approved d1a38994 and signed off 0181bce3..aff21c73 (see `../production-release-d1a38994/RELEASE.md`).
- enclave-e3 (for enclave-99) APPROVED 936ce3fe, 0e9a6f08/666674d7, 5b41db37, 020f76e7, 63b2b276, aef54ff7 and
  aeb3d328+d1a38994, with the medium above.
- **enclave-d1: APPROVED ecf02384 and release 0839ac3a.** d1 reproduced it independently (a clean worktree, a fresh
  GOCACHE, byte-identical `diff -r`). d1's own mutant (dropping the length check) is caught.
- **enclave-e3 (for enclave-99): APPROVED ecf02384.** The image sign-off over 0181bce3..ecf02384 is COMPLETE. e3's
  predictor (known-answer test first, the chain read through two agreeing RPCs, the component CAR-verified)
  computes the same api-mcp-adapter measurement, 75317f83…da29. None of the recorded lows blocks.
