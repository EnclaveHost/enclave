# The pVM carrier inside U7 (review/pvm-u7-integration; for review, NOT deployed)

**What this branch is.** The approved U7 head, plus the pVM runner branch, integrated in isolation:
- **U7:** security/u7-eligible-routing at **18772bf7**, approved by enclave-d1 and enclave-5d through round 6. Tenant
  traffic, certificates, secrets and sessions go only to hosts the relay holds ELIGIBLE.
- **The pVM runner branch:** pvm-cpu/portable-runtime at **742d1b01**.

The goal is one reviewable revision on which the Pixel CPU runner's NARROW inference path works, while a phone row gets
nothing else. Nothing here changes U7's code. The owner of U7 is enclave-99; this branch is enclave-53's; nothing is
deployed.

## The commits, in order
1. **be5a2bd7:** merge 742d1b01 into U7 at 8f31a87e, conflict resolutions only. Each side's union:
   - **api-relay.js:** main's hv-node attach plus the PVM_SERVING switch. The tunnel hub's attest policy is built on
     HVNODE_ATTEST (the VBS attach is retired) and carries hvNode, pvmCpu and pvmApp.
   - **tunnel.js:** hvOn plus avfOn.
   - **deploy.sh:** main's list plus pvm-app-attest.mjs (tunnel.js imports it statically) and pvm-serving.mjs.
   - **test/tunnel.test.mjs:** both sides' imports.
   - **.gitleaks.toml:** the enclave-99-approved file, byte for byte.
2. **dcd9c488:** merge U7 at 18772bf7 (round 6: zone-apex dns-01 refused; relay/dns-relay.js only).
3. **4c5aa26f:** test fixtures only. The stub ledger answers U7's schema probe, and the "ordinary app" fixture is a
   U7-eligible host.
4. **f8754e31:** the carve-out, to enclave-99's conditions (below).
5. The integration test, the test-only lab root, U01-U05, and this note.

## The carve-out: where the pVM path sits AHEAD of U7's refusals, and how narrowly
Two dispatch points in api-relay.js hand a request to relay/pvm-serving.mjs. The handler takes it ONLY when
`carrierRoute(req)` says so:
- **The raw request target, before any decoding, is EXACTLY one of:**
  - `/x/<0x + 64 lowercase hex>/pvm/evidence`;
  - `/x/<0x + 64 lowercase hex>/pvm/sealed`;
  - `/t/<name>/pvm/evidence`.
- **The method is POST, and there is no query.**

Anything else falls through to U7 UNCHANGED:
- another method, or a prefix id;
- any percent-encoding (`..%2F`, `%252F`), a case variant (`/X/`, `/PVM/`) or a backslash;
- a repeated slash, a dot segment, a trailing slash or segment, or a query.

**Resolution:**
- `/x` uses the carrier's OWN resolver (`pvmRunnerResolver`), never U7's app router. It routes the ledger's live lease
  holder for a full id, only to the hub's current AVF-attested tunnel whose own public URL is that runner. The tier is not
  required: a tunnel re-attached in place has none.
- `/t` is claimed only for a name the hub attached as an AVF tunnel.

**What the carrier carries and answers:**
- It forwards the request BODY only, never the caller's headers, so no Authorization, Proxy-Authorization or Cookie.
- It sets no cookie.
- Every answer, refusals included, carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox;
  default-src 'none'`.

**What stays U7's:** WebSocket upgrades on the pVM paths are not the carrier's; they are U7's (refused for a phone row).
U7's upgrade sweep covers only held WebSocket splices, and the carrier's streams are plain request/response splices,
which U7 leaves uncut.

## Tested on this revision
**test/pvm-u7-integration.test.mjs** runs a SPAWNED real api-relay from this tree, a stub ledger and registry, synthetic
AVF phones bridging fake VMs, an eligible app host, and a token tunnel.
- **The preload's conditions:**
  - it is referenced by nothing in relay/, deploy.sh, systemd units or CI;
  - it only adds the lab pin, and the production pins stay present and unchanged;
  - it refuses to load without a well-formed pin;
  - **the negative control:** the same relay without the preload refuses the lab chain.
- **Authorized, through the intended path:**
  - a registered name attaches only with the owner's co-signature;
  - the bootstrap route works before any lease;
  - `/x/<D>/pvm/evidence` and sealed work for the lease holder;
  - the caller's credentials never reach the VM;
  - after an IN-PLACE re-attach (no tier): routed, one row, no tier, never eligible or serving.
- **Refused:**
  - another holder;
  - an ELIGIBLE non-phone holder (the carve-out resolves phone rows only);
  - an expired lease, and a lapse mid-session;
  - a tunnel whose public URL is not the runner's;
  - a token tunnel whose hello says avf;
  - a phone whose attestation was refused.
- **The phone row gets nothing else:**
  - `/x/<D>/<other>`, and every non-exact or non-POST form of the pVM paths;
  - the app subdomain;
  - `/t/<name>/<other>`;
  - WebSocket upgrades (including on the pVM paths);
  - v1 control that would reach the host.
  - Certificates and secrets get exactly `403 host_ineligible`. That is U7's refusal, reached with a real CSR and the
    registered operator's signature, and with the fleet HMAC.
  - Only its own surfaces (`GET /availability`) are ever asked of it.

**Other suites on this tree:**
- test/pvm-relay-serving.test.mjs `carrierRoute`: every round-2 variant and every other method;
- test/pvm-runner-resolver.test.mjs;
- test/api-relay-pvm-serving.test.mjs;
- test/pvm-reattach-hub.test.mjs;
- U7's own suites: relay-u7-eligible-routing, dns-relay-u7, certs, secrets, api-relay, fleet, tunnel.

**Mutations:** test/mutate-pvm-serving.mjs M01-M37, U01-U05.

## What remains
- **enclave-99's review** of this exact revision.
- **Then ONE bounded Pixel/local-chain regression run** at this revision: cpu/relay-reconnect-run.mjs from this tree
  (one VM boot; drops, a frozen relay, co-signer refusals, exactly-once recovery, an old-build relay).
- **enclave-99's offline re-verification** of results/pvm-cpu-relay-reconnect, which was run at 48030dd5 before U7.
- **Not done, and not claimed:**
  - a merge to main, or any deployment;
  - production PVM_SERVING or any production configuration;
  - Base;
  - a Pixel 11, or several app VMs at once.
