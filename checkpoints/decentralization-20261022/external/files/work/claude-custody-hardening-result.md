# Custody Shield hardening (section 6 follow-up): result

**Repository:** `wo/work/enclave` (main working tree, at `3fdbb1d0`).

**Constraints kept:**
- Nothing committed. No image built, no production, chain, SSH, Wine or GUI activity.
- No Go, CLI, browser or Windows source edited.
- The only shared relay file changed is `relay/shield-host-session.mjs`, as assigned.

**Coordination.** Through `work/custodian-shield-daemon-interface.txt`, sections H1 to H5 (an addendum written before the
code, then H5 with the results).

**The guest candidate.** `work/shield-direct-build-0ed5a8ba/image/vbs-linux-c7084346/BUILD.json` (binary sha256
`c7084346…`, source `0ed5a8ba`) is a **guest image only**. Nothing here builds, measures or activates a custodian image,
and nothing activates hardware.

## H1: EK admission at challenge time (`relay/shield-host-session.mjs`, shared)

**Construction.** `createHostSessions` derives its trust anchors once, exactly as attest does
(`hvnode-verify.mjs normalizePolicy`): `loadTpmRoots(ekRoots)`, narrowed to `ekRootPins` when given. It throws if no
pinned root remains. The anchors come only from the caller's own policy (custody: measured; market and DNS: the
operator's policy), never from a request.

**`challenge(body)`, in order:**

1. Shape checks (unchanged).
2. The EK certificate and the `ekChain` certificates parse.
3. `verifyEkChain(leaf, ekChain, pinned trust, now)`. The request's chain supplies intermediates only and is never an
   anchor. Failure is 403 "EK certificate does not chain to a pinned TPM root".
4. The leaf is not a CA and names an on-die TPM manufacturer (AMD or Intel) in its SAN. These are attest's own other two
   EK checks. Failure is 403.
5. At most `MAX_PENDING_PER_EK = 2` pending challenges per EK certificate (429).
6. Then the table-full check (429).
7. Only then: `makeCredential`, the nonce, and the pending entry.

So a malicious certificate allocates nothing and never gets a credential.

**Why step 4 was added during implementation.** The pinned root and intermediate certificates are public. Presented as
the "EK", they chain trivially and would have taken pending slots.

**Unchanged:**
- `verify` (attest): the full hv-node verification (EK chain, on-die check, the mint record, credential, quote, log
  replay, boot policy, possession).
- Single use, the 60 s TTL, party binding (the attach message names the party), and registry or deferred identity.
- Added only `pending()`, a read-only count.

**Test-expectation changes.** A wrong-CA EK is now refused at challenge, not at attest, in
`test/{shield-custody, shield-dns-challenge, windows-shield-verifier}.test.mjs`. All three are mine; the assertions were
moved to the earlier, more specific refusal.

**New tests:**

- **`test/helpers/malicious-ek.mjs`.** Five refused EK variants, each presented with the genuine AIK:
  - self-signed;
  - another CA's EK, with that CA's intermediate and root supplied in `ekChain`;
  - the pinned root as the leaf;
  - the pinned intermediate as the leaf;
  - a discrete-TPM manufacturer under the pinned CA.
- **`test/shield-host-session.test.mjs`** (3 tests):
  - each variant is refused with its own reason, and `pending()` stays 0;
  - 100 malicious challenges against `maxSessions: 3` take nothing. One genuine EK gets exactly 2 slots, then 429.
    A second genuine TPM under the same CA gets the last slot, then the table is full;
  - the genuine host attests with registry identity;
  - replay gives 409, and expiry (+61 s) gives 409 with the entry swept;
  - after a passed challenge, attest still refuses a stranger's operator signature and a forged frame;
  - construction with no pinned root, or with only an intermediate, throws.
- **Market verifier, over HTTP** (`windows-shield-verifier`). 20 malicious challenges to `/v1/shield-verifier/challenge`
  with `maxSessions: 2` all get 403. Then the genuine host's real market-client round opens the market.
- **DNS responder, over HTTP** (`shield-dns-challenge`). 70 malicious challenges (more than its 64 slots) all get 403.
  Then the genuine host attests and its guest's push is authorized.
- **Custodian, over the actual router** (`custody-v2-shield-daemon`). With measured `maxPendingChallenges: 1`:
  - every malicious variant gets 403 `shield_session`;
  - the genuine host then challenges and attests, and the guest's release opens to the owner's values;
  - attest replay gives 409;
  - a challenge unanswered past 60 s gives 409;
  - after `sessionLifeSec` the live session no longer releases.

## H2: the custodian's client key (`custody/v2/http.mjs`)

**The previous behavior.** The rate limit and the per-client release-challenge cap were keyed on the client's own first
`X-Forwarded-For` entry. So any client could escape or split buckets.

**Now:** `clientKeyFor(trustedProxies)`.

- **Default.** The key is the TCP peer address (`::ffff:` stripped), and the header is ignored.
- **The fact behind the opt-in.** Every connection arrives through the host's forwarder: the slirp port forward,
  expected inside the guest as `10.0.2.2` (that is QEMU's documented behavior, not observed here), or `127.0.0.1` for
  the tunnel agent. So a **default image has one bucket shared by all clients**. That is safe, but one client can slow
  everyone; this is stated in the doc and the interface.
- **The opt-in, needed for per-client limits.** `MEASURED.trustedProxies`, set at build time with
  `--trusted-proxy 10.0.2.2[,…]`:
  - 1 to 4 distinct loopback or private literals (127/8, ::1, 10/8, 172.16/12, 192.168/16, fc00::/7);
  - refused: public addresses, CIDRs, hostnames, link-local addresses, duplicates and empty lists;
  - validated by the build and again by the daemon (FATAL if invalid); never from the host config or the environment.
- **What the opt-in reads.** `X-Forwarded-For` only when the peer is listed, and then only its **rightmost** entry, the
  address the trusted proxy itself saw. A non-address entry falls back to the peer.
- **Scope of the trust.** The host can choose buckets. That is availability only, and it never affects a release
  decision.

**Tests:**

- **`custody-v2-shield-daemon`:**
  - default: 35 different spoofed addresses from one peer share one bucket (429);
  - trusted forwarder: a spoofed left part doesn't change the bucket, a distinct client gets its own, and a non-IP entry
    falls back to the peer;
  - a list that doesn't name the peer ignores the header;
  - validation, and the router refusing a public proxy;
  - a source check that the daemon passes `validateTrustedProxies(MEASURED.trustedProxies ?? [])`.
- **`custody-v2-build`:** absent by default (measured bytes unchanged), baked when set, refusals, and the script
  refusing a public address before any build work.
- **The test harness.** `serve()` runs the router as an image built with `--trusted-proxy 127.0.0.1`, the shape of a
  production direct image, so the earlier per-client tests keep their meaning.

## H3: the real operator ingress (`custody/v2/ingress.mjs`)

**Change.** The Caddy `@public_protocol` matcher now also forwards `POST /v2/custody/shield-session/{challenge,attest}`.
On an image without the opt-in, the custodian itself answers 404.

**Tested against the real local Caddy** (`CADDY_BIN=work/custody-caddy/caddy`, v2.11.7, loopback only, its own temp CA
and config, stopped after each test; no Caddy process remains). The new test is
`test/custody-v2-ingress-ratekey.test.mjs`:

- **What Caddy forwards.** A client sending `X-Forwarded-For: 198.51.100.9` reaches the custodian with the rightmost
  entry being the client's real source address (127.0.0.2), and the custodian's peer is the proxy.
  - The leftmost-entry mutation survives this test, which shows that **Caddy replaces** a client's header rather than
    appending to it.
  - The router still takes the rightmost entry, so it is correct either way.
- **Buckets through Caddy.** A spoofing client (127.0.0.3) stays in its own bucket and gets 429. Another client
  (127.0.0.4) gets 200.
- **The Shield routes are forwarded.** A malicious EK is refused by the **custodian** (403 `shield_session` /does not
  chain/), and a stale attest gets the custodian's 409.
- **Still 404 at Caddy, never reaching the custodian:** `GET /state`, `POST /submit`, `POST /v2/custody/host-binding`,
  `GET` on the Shield route, an unknown Shield subpath, and a percent-encoded Shield path.

**Existing compatibility.** `test/custody-direct-ingress.test.mjs` (not mine) was run **with** `CADDY_BIN` before and
after the change: 1/1 both times.

## Mutation checks (all detected)

| Mutation | Detected by |
| --- | --- |
| No chain check | `shield-host-session`: 3 fail |
| No leaf/on-die check | 2 fail |
| No per-EK pending cap | 1 fail |
| Untrusted `X-Forwarded-For` honoured (the old behavior) | `custody-v2-shield-daemon`: 1 fail |
| Leftmost instead of rightmost entry | daemon: 1 fail (the Caddy test passes, see H3) |
| A public proxy accepted | daemon: 1 fail |
| Shield routes not forwarded by the ingress | `custody-v2-ingress-ratekey`: 1 fail |

Every file was restored and verified afterwards.

## Runs (serial, one file at a time)

Available memory was checked against the 16 GiB floor before each file, and never went below it. `CADDY_BIN` was set
for the two ingress tests.

| Suite | Result |
| --- | --- |
| `shield-host-session` (new) | 3 |
| `shield-custody` | 7 |
| `custody-v2-shield-daemon` | 10 |
| `custody-v2-ingress-ratekey` (new, real Caddy) | 1 |
| `custody-direct-ingress` (real Caddy) | 1 |
| `custody-v2-build` | 11 |
| `custody-v2-protocol` | 8 |
| `custody-v2-release-authority` | 2 |
| `custody-vectors` | 2 |
| `custody-v2-e2e` | 1 |
| `custody-v2-independent-lifecycle` | 1 |
| `custody-v2-independent-runtime` | 4 |
| `custody-v2-independent-governance` | 2 |
| `custody-v2-independent-identity` | 3 |
| `custody-v2-host-ownership` | 3 |
| `custody-v2-chain-quorum` | 11 |
| `custody-v2-capacity` | 1 |
| `custody-v2-deploy` | 4 |
| `custody-direct-host` | 4 |
| `custody-independent-admission` | 2 |
| `custody-independent-genesis` | 6 |
| `shield-dns-challenge` | 8 |
| `windows-shield-verifier` | 6 |
| `relay-fresh-attestation-shield` | 1 |
| `verifier-hyperv-shield` | 7 |
| `relay-hvnode-consumer` | 4 |
| `windows-node-hv-attach-relay` | 4 |
| `windows-shield-startup` | 14 (one failure in the first run, while its files were being edited at 19:43–19:45; 14/14 on rerun) |

All passed.

**Not mine and not caused by this work: `windows-shield-custody-transport`, 3 pass / 7 fail.**

- **What fails.** Every failure is `new WmiHyperVLauncher` throwing "only the Shield-direct image carries owner-committed
  packages or custody: this launcher's image is legacy" at `windows/vbslike/manager/wmi-launcher.mjs:870`.
- **Why it isn't mine.** That is the Windows worker's in-progress F3 image-selection change (uncommitted
  `wmi-launcher.mjs` and `shield-profile.mjs`). The test imports none of the files I changed, and it passed 10/10 in my
  previous run before that change.
- **What I did.** Left it for the Windows worker: their test needs the new image role in its launcher setup.

## Cleanup

- **Removed:** my test fixtures from `/tmp` (8.2 MB: `shield-custody-*`, `custodian-shield-build-*`, `shield-verifier-*`,
  `shield-dns-*`, all created by my test files) and my mutation scratch files.
- **No Caddy or test process left running.**
- **Not touched:** other workers' files and processes.

## Still open (not done here)

- **The DNS responder's body bound.** Its own HTTP handler (`relay/dns-challenge-shield.mjs handle`) reads bodies up to
  16 MiB with no concurrency bound. I left it unchanged; it's outside this task's narrow shared change. Recommendation:
  the custodian router's attest bounds.
- **Remaining slot-holding.** A holder of a genuine on-die EK certificate (a real TPM's, possibly public) can still hold
  2 pending slots per certificate for 60 s. Filling a table now takes `maxSessions / 2` distinct genuine certificates.
- **Rate buckets.** A default custodian image shares one rate bucket. Operators of direct images should build with
  `--trusted-proxy 10.0.2.2`, which is documented. The guest-side source address of the QEMU port forward is expected,
  not yet observed on hardware.
- **No activation.**
  - These changes alter the custodian bundle, and so its launch measurement. Every image built from them needs a new
    `code-approve`.
  - The Shield-direct guest candidate `c7084346` is unactivated.
  - No real TPM, host, custodian or chain session has run.
