# Relay serving integration for pVM deployments (DESIGN, reviewed; a lab module, NOT wired or deployed)

**Status.** A scoped design, not an implementation. Nothing here is deployed, activated or merged. It proposes how
the platform relay (`relay/api-relay.js`) would carry a buyer's traffic to a pVM deployment, using the client contract
that exists today (client 0.4.x: a signed policy, the deployment table, `run --deployment`). It makes **no new evidence
claim**: every property below is either something the client already verifies itself, or a limit stated as a limit. A
production relay route, a production policy, and the phone's registration as a runner are the owner's decisions, and
each needs its own review.

## Where things stand

- **The client** verifies the VM itself: fresh AVF and ABI/2 evidence over its own nonce, pins from a signed policy it
  committed first, and the gate. It seals each request to the attested app key and reads an authenticated stream
  (client/DESIGN.md).
  - A deployment's expected app comes from the policy's signed table (client/DESIGN.md "Deployments").
  - The client needs two things from a carrier: `POST <carrier>/evidence`, which takes a nonce line and returns
    evidence, and `POST <carrier>/sealed`, which takes a sealed request and returns a sealed stream. Both are opaque
    bytes to the carrier.
- **The lab hub** (`cpu/local-hub.mjs`, `cpu/web-carrier.mjs`) offers exactly those two endpoints for ONE tunnel name.
  - It calls `tunnel.js spliceRaw(name, socket, kind)` with the kinds `pvm-evidence` and `pvm-app-sealed`.
  - The phone's host app carries the bytes as opaque `{t:"sd"}` chunks to the VM's vsock endpoints.
- **The production relay** routes `/x/<id>` to the deployment's ON-CHAIN runner: the ledger row's `runner` must be a live,
  in-fleet endpoint (`runnerEndpointOf`, "fix 1c"). It then proxies HTTP.
  - Attested tunnels appear among the live endpoints as `tunnel://<name>`, including a pVM phone attached through
    `pvmCpu` admission.
  - It does NOT set `attest.pvmApp`, so it never verifies an app's ABI/2 evidence at attach, and nothing gets the
    sealed kind.
  - It has no route that splices a buyer's bytes into a pVM tunnel.

## Proposal

1. **Routes.** `POST /x/<id>/pvm/evidence` and `POST /x/<id>/pvm/sealed`: the web carrier's two endpoints, under the
   deployment's own path.
   - Resolve `<id>` exactly as `/x/<id>` does today: the on-chain runner first, never a fan-out probe for these routes.
     An ambiguous prefix refuses, as today.
   - The runner's live endpoint must be `tunnel://<name>`, with the tunnel attested as pVM (`t.pvm`). Anything else
     answers 404, with no fallback to another tunnel or enclave.
   - Then `spliceRaw(name, socket, kind)`, with the web carrier's byte bounds (evidence 256 B in, 256 KiB out; sealed
     1 MiB in, 16 MiB out), streaming, backpressure, and close-on-client-gone.
   - Nothing is parsed or logged beyond sizes. The relay never sees plaintext.
2. **Which tunnels may take sealed traffic.**
   - Today `spliceRaw` gives `pvm-app-sealed` only to a tunnel whose app the hub itself verified (`t.pvmApp`, a relay
     ABI/2 check with the relay's own nonce), while `pvm-evidence` goes to any AVF-attested tunnel.
   - Production would set `attest.pvmApp` from environment, like `PVM_CPU_POLICY`: the allowed runtime ids, code and
     authority hashes, and app ids the relay itself admits.
   - This is defence in depth for routing and for the relay's own accounting. It is NOT the client's trust. The client
     re-verifies everything and would refuse a wrong app whatever the relay decided.
   - Conditions from the verifier session's review:
     - it is never presented as client trust anywhere, whether a badge or a verdict;
     - a relay refusal stays a plain HTTP status with no body the client could mistake for an envelope. The client
       reports it honestly, as "no evidence: the carrier answered 404/503".
3. **Rate and concurrency.**
   - Each `/evidence` makes the VM request an AVF attestation for that nonce, and the VM serves one connection at a
     time (PVM-CPU.md, gaps).
   - So both routes need a per-deployment and a per-client-IP rate, reusing the relay's existing limiter and WAF
     envelope; a per-tunnel stream cap (`MAX_STREAMS`, already enforced in `spliceRaw`); and the idle and first-byte
     windows `/x` already uses.
   - The VM's own sealed window (600 s, 256 requests per evidence nonce, each (nonce, enc) once) stays the replay
     bound.
4. **The client side.** `--relay` stays the carrier URL. For a platform deployment it is
   `https://<relay>/x/<id>/pvm`.
   - The client MAY derive it from `--deployment` and a relay base, but the id stays only a route: it never influences
     what is verified.
   - The extension would need the relay's origin in `host_permissions`. That is a change to the installed artifact,
     reviewed like any code-trust change. No site-served page is ever the trust path.
5. **Registration: open, the owner's.** For `/x/<id>` to reach a phone, the ledger's `runner` for `<id>` must name the
   phone's fleet identity, and the phone must hold a lease. How a pVM host registers, claims a lease and is priced is
   the platform's scheduling decision and is not designed here.

## What this does and does not give a buyer (unchanged by the relay)

- **Given, by the client's own checks:**
  - the answer comes from a genuine Pixel pVM running the runtime and code the policy pins;
  - the app is the one the signed table expects for the chosen deployment;
  - the request is readable only by that app's attested key;
  - the answer stream is authentic, complete or honestly aborted, bound to its request.
- **Not given (the limit stays):**
  - the evidence names no deployment and no instance, so a hostile relay can route D's traffic to ANOTHER genuine
    instance of the SAME app. The on-chain runner rule makes an honest relay route correctly; it does not make a
    hostile relay unable to lie;
  - binding an instance would need an instance identity inside the attested ABI/2 challenge. That changes the evidence
    format, and its semantics need their own review: a host-supplied deployment id proves only what the host claimed.
- **Also not given:** availability (a relay can drop anything), and traffic analysis (sizes and timing are visible, as
  in SEALED-STREAMING.md).

## The lab module (2026-09-24): built and tested, NOT wired into the production relay

- **`relay/pvm-serving.mjs`** implements items 1 to 3 as a standalone handler. `api-relay.js` does not import it, so the
  production relay's behaviour is unchanged. The handler:
  - takes a ledger resolver, which must be `runnerEndpointOf`, and a tunnel hub, `spliceRaw`;
  - accepts only full canonical ids;
  - requires a `tunnel://` runner, and returns a plain 404 otherwise, with no body and no fallback;
  - applies the carrier's bounds (413 is sent before the connection closes), per-deployment and per-client rates (429),
    streaming with backpressure, and close-on-client-gone;
  - logs sizes only.
- **test/pvm-relay-serving.test.mjs** runs the BUILT client through the module to fake VMs behind a stand-in hub. It
  covers:
  - routing by the ledger runner;
  - no fallback, for a non-tunnel runner, no runner, or a tunnel without a hub-verified app for the sealed kind;
  - a prefix id, a wrong method and an oversized body;
  - a runner change between exchanges, judged from zero on the new runner;
  - the rate refusal, which never yields a verified result;
  - (h) sizes-only logging.
  On the Pixel's REAL evidence it also shows the limit. A hostile relay routing two deployments of the same app to one
  genuine instance is NOT detected, and the test asserts it. A deployment the table maps to another app is refused.
- **The module review** (the verifier session, fcdc4e3f): the module does what the design says. Its wiring points:
  - **Fixed in the module.** A hung ledger lookup answers a plain 504 after a bound, and pending lookups per client are
    capped. A refused splice no longer logs a sizes line.
  - **Tested now:**
    - an answer cut past its bound after the 200 is never taken for evidence;
    - two buyers on one instance each get their own envelope (the nonce echo is compared first, so a crossed one would
      fail as "another nonce");
    - a buyer leaving mid-answer closes the VM's stream, and its sizes are logged;
    - `X-Forwarded-For` never mints a client;
    - an identity the wiring passes does key the buckets.
  - **Decided at wiring, not here:**
    - the per-client identity must be the one the relay's per-IP WAF already authenticates. Behind a front, the socket
      address is the front's, so every buyer would share one bucket, and a forwarded header is spoofable;
    - the per-deployment bucket is a courtesy to the VM. The VM serves one connection at a time, and that is its real
      protection. Whether to key buckets per (client, deployment) with a higher deployment ceiling, so one buyer cannot
      starve a deployment's others, is the wiring's choice.
- **Not done.** Wiring into `api-relay.js` behind a switch, `attest.pvmApp` from environment, the real `tunnel.js` hub
  in these tests, and the review's (a)-(f) through the relay route. The first two change production code and wait for
  the owner.
- **The lab carrier.** `cpu/web-carrier.mjs` had the same defect: it reset the connection before its 413 was sent. It is
  fixed and tested.

## Review questions

1. Is `/x/<id>/pvm/{evidence,sealed}` the right place, or a dedicated `pvm.<relay>` host?
2. Should the relay refuse to route D to a tunnel whose relay-verified app is not one it admits (policy 2 above), or
   carry any pVM tunnel's bytes and leave everything to the client?
3. What rate per deployment and per IP does the VM's evidence path tolerate? It needs a device measurement before
   production numbers.
4. Registration (item 5): the owner's design.

## Review (the verifier session, 2026-09-24): design accepted, with conditions

- **Route placement.** It agreed with the routes and with the three rules: on-chain runner only with no fan-out; an
  attested pVM tunnel or a 404 with no fallback; spliced bytes with only sizes logged.
- **Policy 2.** Acceptable as routing hygiene, under the two conditions in item 2.
- **The gate's properties.** None is weakened by routing:
  - the nonce is the client's;
  - the app id is the signed policy's;
  - the transport and app keys come from evidence the client verified;
  - the sealed channel derives from that app key;
  - the relay sees ciphertext only.
- **Kept explicit.**
  - The relay's TLS terminates at the relay, so the transport is untrusted by design and only the app-key binding
    carries trust.
  - The id is a route only, so nothing at the relay can claim to bind an instance.
- **More tests it asked for** (merged into the list below): a-h.
- **Already true of today's client, and now tested** (test/pvm-client-deployments.test.mjs): a `--relay` URL naming
  deployment X while `--deployment` names Y. The table's entry for Y decides, and the result names Y. A deployment is
  never parsed from the carrier URL.

## Tests this would need before any activation

The same pattern as the lab: a relay built from the branch with a fake runner row in a test ledger, a fake pVM tunnel
(`test/fixtures/pvm-fake-vm.mjs` behind a real `tunnel.js`), and the BUILT client. The cases:
- the right deployment routes to its runner's tunnel;
- a deployment whose runner is not a pVM tunnel answers 404;
- an ambiguous prefix refuses;
- a tunnel without the admitted app gets no sealed stream;
- rate limits hold;
- a hostile relay stand-in that routes D elsewhere is refused by the client if the app differs, and is NOT detected if
  it is another instance of the same app (asserted, so the limit stays visible);
- from the review:
  - (a) a replayed envelope for another nonce: refused at verify;
  - (b) a v1 envelope in place of v2: refused as a downgrade (the policy's formats);
  - (c) two clients' sealed responses crossed by the relay: each refused by its own AAD and nonce, nothing decrypted;
  - (d) the FIN dropped, or the stream truncated: incomplete, never complete;
  - (e) a rate-limit refusal: never a verified result, never a stale mode;
  - (f) a runner endpoint that is not `tunnel://`, or an on-chain runner that changes between two exchanges: each
    exchange is judged from zero on a fresh nonce;
  - (g) a deployment in the `--relay` URL never feeds selection (already tested today, above);
  - (h) sizes-only logging, asserted on a real exchange: no nonce, envelope or ciphertext in the relay log.
