# Platform API standby forward: attested-key pin on the secure socket (RESULT, 2026-10-22)

**Status: source committed locally and tested offline. NOT deployed, NOT imaged, NOT pushed.**
- There was no production access, SSH, live RPC, wallet use or funding.
- The earlier `RESULT.md` and `native-control-attested.patch` (commit 8e77ff1e) are unchanged.
- The old 6f hardware canary does not cover this code.

## Commit and patch

| item | value |
|---|---|
| repo | `work/resume-after-checkpoint-20261022/native-control-attested/repo` (same isolated checkout) |
| commit | `ca3118202359da8ce84f5b917fcc5ed85b2c6730`, tree `8efbb74698ad31b6522ae7263ecbf121722b0a20`, parent `8e77ff1e`; author and committer SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com> |
| patch | `platform-api-forward-pin.patch` = `git diff 8e77ff1e ca311820`, sha256 `d3f7cf22aee725421e9f8f0d711df2a9c480887d901ba6433bd6fc40c143a66f` (5 files, +332/−32) |

This is a separate commit, so root can integrate it with the issuer worker's changes. That worker is in
`native-issuer-implementation/repo`, which I did not touch. Both commits change `metal/guest/platform-api-role.mjs`, so
the combined tree must regenerate `metal/guest/platform-api.bundle.mjs`; see "Bundle" below.

| file (committed blob sha256 = tested) | |
|---|---|
| `metal/guest/platform-api-role.mjs` `835ddc67ecbc489dfdaab5296ffd168a22e345f7c142c90bbc866c9ec9fabe76` | the fix (image input via the bundle) |
| `metal/guest/platform-api.bundle.mjs` `d2d89f0145da7c184c1e92b7d5c6314894a686dbfa81701801363125746fb06d` | regenerated (image input) |
| `metal/guest/platform-api.bundle.mjs.manifest.json` `3d1c6c352c36d70a65fcb8b64cbd134ec5370b419a018d332449f3855e36f08f` | the only changed input vs 8e77 is `platform-api-role.mjs` |
| `test/platform-api-forward.test.mjs` `9681a34cb64e068734d27f746018814b847069f3f537f5498f2387969fdc8210` | NEW regression |
| `docs/network/hosted-platform-api.md` | one sentence about standbys |

## The defect (pre-existing, demonstrated)

The standby forward, in old `platform-api-role.mjs:296`, used `https.request` with `rejectUnauthorized:false` and an SPKI
pin only in `checkServerIdentity`. It had three faults:
- **No pin on failure.** Node skips `checkServerIdentity` whenever chain validation already failed, which is always the
  case for a self-signed peer. Such a peer received the full request: headers, `Authorization`, body and the hop HMAC.
  - **Shown:** `logs/fw3.out` and `logs/fw4.out` run the same new test against the UNMODIFIED base role (eaea7e46),
    and it fails with "no request byte reached the impostor".
- **Wrong key on the real primary.** The https agent derived SNI from the `Host` header (`platformApi.hostname`). The
  primary's front then selected the group's WebPKI certificate, not the attested control key.
- **No bounds or cleanup.** There was no handshake bound, and an aborted client did not cancel the upstream.

## The fix

`connectPinned({host, port, spki, timeoutMs})` in `platform-api-role.mjs`:
- `tls.connect` with **no SNI**, so the front presents its attested control certificate.
- On `secureConnect`, it compares sha256(SPKI) with the key from the primary's AEAD-sealed heartbeat (`leaderInfo.spki`)
  **on that socket**, before any byte is written.
- It is bounded by `forwardConnectMs` (10 s default) and can be cancelled.

Only after a match does the standby write the original request over that socket with `http.request({ createConnection })`:
the method, the path, the hopped headers (unchanged: hop HMAC, client address, host) and the piped body. It returns the
primary's status, headers and streamed body.
- A wrong key, a refused connection or the timeout gives 503 `platform_api_unreachable` (as before for an unreachable
  primary).
- A client that leaves cancels the pending handshake or destroys the upstream.

**Unchanged:**
- the leader path (relay child);
- hop proof and client IP;
- leader selection and `leaderInfo`;
- the standby's 503 for upgrades (websockets are never forwarded);
- `defaultPost`, the AEAD-sealed peer protocol, which does not rely on TLS identity.

No new trust root, registry change or fallback. I wrote a small role-local primitive instead of importing the CLI tool
(`scripts/native-control-certificate.mjs pinnedSocket`) into the guest.

## Tests (queue, offline `unshare -r -n`, ssh/scp/sftp denial stubs proved; raw logs in `logs/`)

`test/platform-api-forward.test.mjs` runs three REAL roles behind REAL control fronts:
- Each front's SNI map also holds a WebPKI key for the API host. A forward that leaked SNI would meet that key and fail
  the pin.
- The members replicate and elect over the real peer protocol.
- The primary's relay child is a recording stand-in (`relayArgv`), and K is pre-written to the role's key file. Genesis
  and handoff are covered by the hosted suite.

| run | result |
|---|---|
| fw1 | 4/6: test-side faults (TLS server event, front abort scope), retained |
| fw2, fw3, fw4 | work tree 5/6, then 5/6. Base comparison: the wrong-key case FAILS on the old role (hang, then explicit "no request byte reached the impostor"). Retained. |
| fw5 | 5/6: abort timing (probes `logs/probe*.out` showed the test's silent server never read, so it never saw the close) |
| **fw6** | **6/6 (peak 204 MiB)** |
| **mutr** | **5/5 mutants killed**: pin skipped, SNI sent, abort ignored, unbounded handshake, request before pin (old shape) |
| pab5 | bundle built, installed, `--check` verified `d2d89f01…`; network runtime = source-regenerated pin `8399d143…` (pab4) |
| **hosted** | existing `platform-api-hosted.test.mjs` (real relay, genesis, verified handoff, standby forwarding of real accounts, failover, credentials, total-loss recovery): **6/6, peak 285 MiB** |

**fw6 cases:**
- **Positive:** POST with `Authorization` and body through a standby reaches the primary's relay with method, path,
  query, body and credential intact, `x-forwarded-for` from the hop proof (a client-written `x-enclave-client-ip` is
  dropped), and `x-forwarded-host`. A 207 streamed response arrives chunk by chunk with its headers.
- **Wrong key:**
  - a self-signed impostor on the primary's address gets TCP and the handshake but ZERO request bytes: no `Authorization`,
    body, path or hop header;
  - no SNI is sent;
  - the client gets 503;
  - the only bytes that impostor ever saw are AEAD peer posts.
- **Abort mid-request:** the standby's connection to the primary closes.
- **Silent peer:** 503 within the handshake bound. A client leaving mid-handshake closes the connection at once, before
  the 1.5 s timeout (the abort cases call the role's API port as the front does; see the finding below).
- **Upgrades on a standby:** still 503.
- **Primary change:** after the primary stops, a successor is elected, and the standby pins the successor's key from its
  heartbeat and forwards there.

## Findings (not fixed here)

- **The control front does not propagate a client's disconnect** (`createControlFront`, `req.pipe(up)` without an abort
  handler).
  - This is pre-existing, in `metal/guest/measured-control.mjs`.
  - Effect: through the front, an aborted client leaves the front→role→primary chain open until the upstream answers.
  - The role itself now cancels correctly when its own client (the front) leaves.
  - A fix is small (`res.on('close')` destroys `up`), but it is an image input owned by the 8e77 change set. Root to
    decide.
- **Integration.** Both this commit and the issuer worker's change touch `platform-api-role.mjs`. After merging, regenerate
  the bundle as follows (real node_modules copies):
  1. `node relay/build-network.mjs` must give `8399d143…`;
  2. `node scripts/build-platform-api-guest-bundle.mjs`, then `--check`.

  Every resulting bundle hash is a new image input, so the measurement must be redone with the 8e77 RESULT recipe.

## Not done

- No image build or measurement (root review of the combined patch first).
- No hardware.
- Not run: `mcp-hosted-control`, anvil or broad suites.
