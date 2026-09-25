# Production domain release 31d117a9 (image commit d1a38994), 2026-09-25

**Release id: `31d117a95b941b78bb7d7955805431f17a4fcc9eb6723ea513cf9e95cc195815`** (= sha256 of `release.json`).
Format enclave-m4a-domain-release/1, cmdline `console=ttyS0 rdinit=/init loglevel=3`, measure snp / QEMU / family 26
model 2 stepping 1.

It SUPERSEDES bca562cc (aff21c73). enclave-d1's sign-off of the image diff 0181bce3..aff21c73 came with one
should-fix: the front's app-proxy failure log wrote the tenant's request path to the console, which is the host's
serial file. d1a38994 fixes it: the line is now a standard method or "other", plus timeout|unreachable. A test drives
the 504 and the 502 and fails on a path, query, header, raw method or address in the line; mutants were caught. That
is the only change from aff21c73: `git diff aff21c73 d1a38994` touches `front/ready.go` and its test, plus evidence docs.

Built on warden-host at 19:17:35Z by `isolation/m4/domain-release.sh`, in a clean worktree detached at d1a38994
(`status --porcelain --ignored` empty; GOFLAGS and ISOLATION_LAB_FRONT unset), go1.27.0-X:nodwarf5. The artifact is
`~/enclave-bench/prod-release-d1a38994/release-d1a38994` (read-only). It is NOT installed, pinned by any relay, or run
by any guest. INSTALL.md describes installing it.

## Checked
- **Reproducible.** A second build in a separate clean worktree with a COLD Go cache gave the same id, and every file
  was byte-identical.
- **A production front.** No build tags. It contains `api.enclave.host` and the pinned key (d6c8a959…, keyId
  06212e5df9c3779a) once each. It contains none of the lab relay name, the lab endpoint name, `.enclave.test`, the lab
  release key, or the old path-logging format string.
- **Against bca562cc:** only `template/front` differs.
- **Against the live 5c3561f9 (0181bce3):** `template/front` and `template/init` differ. The kernel (1a3a02d5…),
  firmware (142589cc…), runtime set and guest modules are byte-identical, so the third-party bytes and their
  corresponding sources are unchanged.
- front `8f28ac89c592dd478546fc23904b8701e56cf78e870c678cecb5eb05f66fb82b`, init
  `2bd54d6cf62bb0a0a969995fdb5a352df19f3917ae1dffaada33f7204659f8ba`. Everything else is in files.txt.

## One app's measurement under it (a cross-check; the relay predicts every deployment's own)
api-mcp-adapter 1.0.0, phase 2's derived bundle (AppID 94c04c0e…, record bc1ac3be…, runtime ccadb38a…, 1 vCPU):
**`ca8c0e1ee566678058bc604736cf0f4c0f628972ed8a221e9b56e8be036f45081cceba3fd933481e32c5dfb15357bcb9`**

## Secrets reach the app ONLY through config placeholders (a recorded parity gap)
The standard runtime gives the app each staged secret as its own guest `--env NAME=VALUE`
(`wasm/wasm_manager.py` at 0181bce3). This tier releases secrets only to substitute `$NAME` / `${NAME}` in the config
(appconfig), and delivers only `ENCLAVE_CONFIG`, with a 64 KiB cap and no config file. An app that reads a secret from
its environment would start WITHOUT it here (enclave-d1).

Decision for this release: do not widen the measured code. Record it per app before each app is restored:
- **a69dcbba (api-mcp-adapter).** Its public config (`bafkreifxoosjvq56tua7y325cvlfav56unskmppwtsdqgx5sa3b4ybybpi`,
  5551 bytes, fetched and CAR-verified through guestd's fetch-cid.py) references all six of its staged secrets:
  `MCP_ADAPTER_API_KEY`, `IMAGE_ENDPOINT`, `RISCBOX_ENDPOINT`, `RISCBOX_API_KEY`, `JOT_ENDPOINT`, `JOT_API_KEY`.
  Placeholder delivery serves it fully.
- **d9798e4c, a77d0c57.** They carry config and no staged secrets, per enclave-99's read-only check of 2026-09-25.
  Confirm this at S5 (the per-app secret inventory).
- An app that needs env secrets waits for a later release that adds them to the init message.
