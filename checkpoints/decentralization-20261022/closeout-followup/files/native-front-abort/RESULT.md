# Control front: a client's disconnect now cancels its upstream leg (RESULT, 2026-10-22)

**Status: source committed locally and tested offline. NOT bundled, NOT imaged, NOT measured, NOT pushed.**
No SSH, live RPC, keys, wallet, images or deployments.

## Source

| item | value |
|---|---|
| isolated repo | `work/resume-after-checkpoint-20261022/native-front-abort/repo` (local clone of `native-control-attested/repo`, origin removed, branch `work/native-front-abort`) |
| base | `ca3118202359da8ce84f5b917fcc5ed85b2c6730` |
| commit | `d9459aae997198342b0bf6fe9993461cd72118f0`, tree `7f77390343f951d6c0723d200cd4864a7715b987`, author and committer SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com> |
| patch | `native-front-abort.patch` = `git diff ca311820 d9459aae`, sha256 `33a043780e6a427530004049fafa6bab35fe84d5a2385047e5d42208142643db` (2 files, +230/−2) |
| `metal/guest/measured-control.mjs` | `26a8982c52497d88d7d0885f63a4b4b8056da3ac1192ab03fdac94426a6185fc` (+12/−2): **image input** |
| `test/control-front-abort.test.mjs` | `0cb7611729931e9aec703217c8c42d672ca8308e035bba80c9ede97ab984dc74` (NEW) |

Unchanged: `platform-api-role.mjs`, `metal/guest/platform-api.bundle.mjs` and its manifest, and every `network/` module.

## The bug and the fix

Both HTTP branches of `createControlFront` piped the request into its upstream with nothing tying the client to it:
- the native control names: `req.pipe(up)`;
- the supervisor, host and prefix routes.

Effects:
- **A client that left kept the upstream request open until the upstream answered.** This covers an aborted upload,
  an abandoned stream and a silent upstream. Through the front, that left the front→role→primary chain open.
- **An upstream that died mid-answer** (Content-Length promised, socket closed early) left the client waiting.

The fix is `proxyLifecycle(req, res, up, onUnreachable)`, used by both branches:
- `res` closes before it finished, or `req` errors → `up.destroy()`;
- the upstream response closes incomplete → `res.destroy()`;
- `up` errors → the existing 502 if nothing was sent, else `res.destroy()`, and nothing if the client is already gone.

Completed exchanges are untouched. The 502 bodies and every admission, routing, native-name and SNI rule are unchanged.

**Upgrades.** I first added close linkage for upgrades, then removed it. The base already propagates upgrade
disconnects: the pipe ends `up` on the client's FIN, and the error handlers cover the rest (base-3 passes that case).
The upgrade test stays as a regression guard.

## Tests (all through `work/claude-test-queue.py --mib 256`, in a private network namespace: `run-test.sh`, `unshare -rn`, loopback only)

`test/control-front-abort.test.mjs`: a real TLS front (dev mode, the real `createControlFront`) and real Node http
upstreams. The native name uses a leaf from a throwaway test CA over the front's own control key, installed through
`installNativeCertificate`. Every check observes an ACTUAL connection close (the upstream server's accepted socket
`close`, or its FIN for an upgrade, or the client's TLS socket `close`), never status text.

| run | tree | result | guard |
|---|---|---|---|
| base-1 | ca311820 + test | 11 ✖ / 6 ✔; then the process never exited (leaked upgrade sockets) → `timeout` 124; **not a result** | (killed) |
| base-2 | ca311820 + test (teardown fix) | **6 pass / 11 fail**, EXIT 1 | peak 173 MiB |
| fix-1 | fix + upgrade linkage | 16 / 1 (upgrade check counted only `close`; an http.Server upgraded socket allows half-open, so a FIN is the observable close) | 152 |
| base-3 | ca311820 + final test | **7 pass / 10 fail**: every HTTP cancellation case on all 3 branches + upstream-dies; upgrade passes on base | 165 |
| fix-2 | fix + upgrade linkage, final test | 17 / 17 | 151 |
| **fix-3** | **final commit (upgrade linkage removed)** | **17 / 17, EXIT 0** | 150 |

The 10 cases that fail on base and pass with the fix (each upstream close takes ~40-145 ms with the fix; on base the
leg stays open past the 2 s bound and indefinitely):
- on each of the supervisor route, the platform-API host route and the native name `api.enclavehost.eth`:
  - the client leaves while the upstream is silent;
  - an aborted upload (1 MiB declared, 64 KiB sent);
  - the client leaves a streamed download;
- an upstream dies mid-answer: the client connection closes (on all 3 branches).

Positive controls, passing on base and fix: on each branch, a streamed download (24 × 64 KiB) arrives byte-exact with
the upstream's answer finished, and a streamed upload (2 MiB in 32 KiB pieces) arrives byte-exact. The upgrade guard
passes too.

**Regression runs** of existing suites that construct `createControlFront`, against the fix, each at 256 MiB:

| suite | result |
|---|---|
| `platform-api-config` | 5/5 |
| `native-control-attested` | 9/9 |
| `platform-api-forward` | **6/6**: three real roles behind real control fronts, the standby→primary path |
| `platform-api-hosted` | **not a result**: first run 6/6 failed only because the clone lacked the gitignored generated `relay/network-runtime.bundle.mjs`; with that file (pin `8399d143`) the rerun was guard-stopped at 266 MiB > 256 (exit 99). It needs a larger cap; root decides |
| `mcp-hosted-control` | 2 pass, 4 skipped (need a Foundry build), 1 fail from a missing nested `sdk/sessions/node_modules` (environment, not the front) |

Test environment (untracked, not committed):
- `node_modules` and `relay/node_modules` are symlinks to `native-control-attested/base-eaea7e46` real copies. The
  package lock is unchanged since eaea7e46; they were used read-only.
- `relay/network-runtime.bundle.mjs` was copied from the same base at pin `8399d1434e0587c2`.
- `base-ca311820/` is a `git worktree` of the base, used for the reproduction.

Logs and hashes: `logs/`, `EVIDENCE.sha256`.

## For composition (root)

1. **Image input.** `metal/guest/measured-control.mjs` changes, so the image changes.
2. **Bundle.** `metal/guest/platform-api.bundle.mjs` INLINES `createControlFront`: it contains `supervisor_unreachable`
   and not `proxyLifecycle`, and its manifest lists `measured-control.mjs` as an input.
   - After composing with the issuer change, regenerate it as RESULT-forwarding.md states:
     1. real node_modules copies;
     2. `node relay/build-network.mjs` → `8399d143…`;
     3. `node scripts/build-platform-api-guest-bundle.mjs`, then `--check`.
   - Re-measure with the 8e77 RESULT recipe.
   - I did not touch the bundle, as instructed.
3. **Governance.** Admin, host-wallet and policy gates are unchanged: the change only adds lifecycle linkage after
   routing.
