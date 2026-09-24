# Relay serving integration for pVM deployments (DESIGN, reviewed; wired on the branch behind a switch that is OFF and set nowhere; NOT enabled or deployed)

**Status.** A scoped design, now wired into `relay/api-relay.js` on this branch behind `PVM_SERVING`, which is OFF by
default and set in no environment ("Wired behind a switch", below). Nothing here is deployed, enabled or merged. It proposes how
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
- **The production relay** (main) routes `/x/<id>` to the deployment's ON-CHAIN runner: the ledger row's `runner` must be a live,
  in-fleet endpoint (`runnerEndpointOf`, "fix 1c"). It then proxies HTTP.
  - Attested tunnels appear among the live endpoints as `tunnel://<name>`, including a pVM phone attached through
    `pvmCpu` admission.
  - It does NOT set `attest.pvmApp`, so it never verifies an app's ABI/2 evidence at attach, and nothing gets the
    sealed kind.
  - It has no route that splices a buyer's bytes into a pVM tunnel.
  - On this branch, both exist behind the OFF switch (below).

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
- **Given since client 0.5.0, for a deployment the signed policy binds to instances** (INSTANCE-BINDING.md, evidence
  v3): the answer comes from one of THOSE instances. A relay that routes D to another genuine instance of the same app,
  or to another deployment's instance, is refused by the client before anything is sealed. It is tested, including one
  instance routed as two deployments.
- **Not given, for an UNBOUND deployment (the v2 limit stays there):**
  - v2 evidence names no deployment and no instance, so a hostile relay can route D's traffic to ANOTHER genuine
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
- **On the REAL tunnel hub.** The module also runs on `relay/tunnel.js`, test 4. A synthetic phone attaches with AVF
  evidence and verifies its app over the hub's ABI/2 nonce, then carries each spliced stream to a fake VM:
  - the built client's evidence goes through the module and the real `spliceRaw` to any attested pVM tunnel, and is
    judged on the client's own nonce;
  - a well-framed sealed request reaches the hub-verified app's VM, which answers it with its own refusal frame, under a
    nonce it never issued;
  - a tunnel whose app the hub did not verify gets no sealed stream: a plain 404.
- **Wired since** behind an OFF switch (next section). The review's (a)-(d) have not been run through the relay route; the
  client already refuses each against the lab carrier.
- **The lab carrier.** `cpu/web-carrier.mjs` had the same defect: it reset the connection before its 413 was sent. It is
  fixed and tested.

## Wired behind a switch (this branch, 2026-09-24): OFF by default, set nowhere

Codex directed this slice under Steven's standing scope. Coding the disabled path does not authorize enabling it.

- **The switch.** `PVM_SERVING`, read once at startup. `1`, `true`, `on` or `yes` (any case, trimmed) is ON. Anything
  else is OFF, including unset, empty, `0` and `enabled`.
- **OFF.**
  - `relay/pvm-serving.mjs` is not even imported, and the tunnel hub's attest object is unchanged.
  - `/x/<id>/pvm/*` is an ordinary `/x` path.
  - Tested: the same status, body, response headers and forwarded headers as another `/x` path of the same live
    deployment. An OFF relay with a deliberately broken module beside it boots and serves.
- **ON.**
  - The module is imported at startup. A broken module stops the relay: it never serves half-built.
  - The carrier is a sub-route of the `/x` gateway on the API host only. It is checked after app subdomains, custom
    domains, the MCP host, box hosts and `/t/`, so an app's own origin never reaches it.
  - It needs three things: AVF attach (`METAL_AVF_*`), the pVM CPU policy (`PVM_CPU_*`) and the app admission policy
    (`PVM_APP_IDS`, `PVM_APP_RUNTIME_IDS`). With any of them missing:
    - both routes answer a plain, empty 503 for every deployment, with `connection: close` and no `Retry-After`;
    - every other route answers exactly as it does OFF;
    - the startup log names what is missing.
  - Configured, the app policy becomes the hub's `attest.pvmApp`. The code and authority pins it is checked under are
    the pVM CPU policy's and AVF's, as in item 2. The startup line is printed from the object the hub is given, so it
    states what the hub will admit.
- **Packaging.** `relay/deploy.sh` copies `pvm-serving.mjs` with the relay. No env file sets `PVM_SERVING`. No
  production env, key, registry entry or lease was touched.
- **The app admission policy.**
  - Both variables are comma lists in the ABI/2 wire form exactly: 64 lowercase hex, no `0x`, whitespace only around
    commas, no empty element, no duplicate.
  - Anything else nulls the whole policy, which gives the 503 above. It is never repaired.
  - Admission is the CROSS PRODUCT the hub checks (`tunnel.js`): any listed app on any listed runtime. The lists do not
    pair an app with its runtimes. Tested on the real hub: app A on the runtime meant for B is admitted. An operator who
    needs pairs needs a hub change.
- **Reserved paths.** While ON, `POST /x/<id>/pvm/evidence` and `POST /x/<id>/pvm/sealed` on the API host belong to the
  carrier for EVERY deployment.
  - An ordinary app's own paths of those names are not reachable through `/x`: they answer 404, never the app's answer.
    This is tested with a live ordinary deployment.
  - The same paths on the app's own subdomain still reach the app (tested).
  - WebSocket upgrades on those paths are not intercepted: they take the ordinary `/x` upgrade path to the app, as when
    OFF (tested both ways).
  - For the `/x` gateway doc: *"When the relay's pVM carrier is ON, `/x/<id>/pvm/evidence` and `/x/<id>/pvm/sealed` are
    reserved on the API host for every deployment; an app that serves paths of those names is reached on its own
    subdomain."*
- **Client identity and rates.**
  - **Per client.** The identity is the relay's `clientIp`: the last `X-Forwarded-For` hop under `TRUSTED_PROXY` (the
    default), otherwise the socket. It is the identity the relay's per-IP limits already use. Tested:
    - another first hop with the same last hop is the same client;
    - another last hop is another client, with its own bucket;
    - with no header, the socket keys the bucket.
  - **The condition it rests on (inherited, not new).** The last hop is trustworthy only while the relay's port is
    reachable through the front alone. If the port is ever reachable directly, a caller can mint per-client buckets
    by header, for the relay's WAF and this carrier alike.
  - **Buckets.** The relay's token buckets: 30 per client (refill 0.5/s) and 60 per deployment (refill 1/s). Neither
    number is measured on the device (review question 3).
  - **The per-deployment bucket is shared** by every client of the deployment, so one buyer's traffic can spend it
    against the deployment's other buyers. Tested: two clients drain it, then a third, fresh client is refused. This is
    the wiring's current choice, stated as such. A per-(client, deployment) bucket is the alternative.
  - **Pending lookups.** 4 per client, and a hung ledger answers 504 after 5 s. Tested through the spawned relay:
    - the fifth concurrent lookup is refused with a 429 at once;
    - the four pending lookups answer 504;
    - the client is admitted again afterwards.
- **The sealed path is stateless at the relay.**
  - The relay keeps nothing between `/evidence` and `/sealed`: each is routed from the ledger afresh.
  - Only the client's own sealing to the attested app key binds a sealed request to the evidence it verified.
  - A runner change between the two is judged from zero by the client (test f).
- **Fixed while wiring.**
  - **Over-bound answers are aborted.** An answer past its bound used to be ENDED cleanly after its 200: a truncated
    body that looked complete, refused by the client only because it did not parse. It is now aborted (tested). The lab
    carrier (`cpu/web-carrier.mjs`) still ends one cleanly. It is lab tooling behind recorded runs and was left as is.
  - **Early refusals close the connection.** This covers a refusal before the body is read: 405, a bad id, 429 and the
    unconfigured 503. The unread body is dropped, never drained, and a client cannot reuse a socket the server resets.
    One could before: a GET with a body answered 503 left the next request on that socket reset.
- **Where it is tested.**
  - `test/api-relay-pvm-serving.test.mjs` spawns the REAL `api-relay.js` against a stub ledger. It covers:
    - OFF equivalence and the lazy import;
    - the unconfigured 503, and every other route unchanged;
    - the strict parsing of the app policy (63 hex, `0x`, uppercase, duplicate, empty elements);
    - the reservation and subdomains;
    - client identity and both rate buckets;
    - carrier log lines holding sizes and ids only;
    - a hung ledger and the pending cap.
  - `test/pvm-relay-serving.test.mjs` test 5 drives `pvmServingFromEnv`, the function `api-relay.js` calls, on the REAL
    tunnel hub with synthetic phones and the BUILT client. It covers:
    - the cross product;
    - an unknown app, refused at the hub, with no sealed stream;
    - an unverified tunnel, with no sealed stream;
    - two buyers each getting their own envelope;
    - a buyer leaving: the hub closes the phone's stream to the VM;
    - an answer past the bound: aborted, and the client reports no evidence;
    - a hung ledger: 504;
    - a missing policy: 503 while verified tunnels are live, and nothing reaches the VM.
  - **Not driven through `api-relay.js`: the splice.** A synthetic phone cannot attach to the spawned relay: its AVF
    verifier pins Google's roots, correctly, with no override. So the splice itself is not driven through `api-relay.js`.
    The hub's app policy there is checked through the startup line, printed from the object the hub receives.
  - **Mutation checks, re-runnable.** `node test/mutate-pvm-serving.mjs` works on a temp copy of the tree, never the
    checkout.
    - It first runs a control: both suites must pass unmutated.
    - It then applies 20 mutations, each breaking one property, and each must fail the test it names:
      - the switch: another word accepted, OFF loading the module, a static import;
      - the route: unwired, or placed ahead of app subdomains; WebSocket upgrades intercepted;
      - admission: the hub not given the app policy, lax app ids, a paired (not cross-product) hub;
      - identity and rates: socket identity, no per-deployment bucket, no pending cap;
      - bounds: no request bound, a minute-long ledger wait;
      - refusals: the unconfigured route falling through, the wiring ignoring a missing policy, early refusals or the
        unconfigured 503 keeping the socket;
      - the stream: a cut answer ending cleanly, a buyer leaving without closing the VM's stream.
    - A mutation whose text is not found exactly once fails the run, so a renamed line cannot make one vacuous.
    - **Run 1** (837187f5's tests plus the upgrade cases): the control passed and 19 of 20 mutations were caught.
      The verdict was FAIL (rc 1).
      - The survivor was M01, the relay's switch accepting another word. The lazy-import test booted the
        broken-module relay only with the switch unset. The module's own switch check then kept `enabled` OFF, so
        nothing visible changed: the module was simply loaded.
      - The test now boots that relay under every OFF value.
    - **Run 2**, on the working tree: control clean, 20 of 20 caught, `PASS` (rc 0). The tree differed from e3d549d2
      only by one test line's `gitleaks:allow` comment.
    - **Run 3**, the verifier session's own run on the exact commit e3d549d2, in a detached worktree: control clean,
      20 of 20 caught, `PASS` (rc 0).
      - Its first attempt exited 2 on the harness's precondition, because a worktree has no `relay/node_modules`.
        Nothing ran half-configured.
      - With the modules linked in, it gave the result above.
      - It reviewed and closed all three notes. Nothing further on the carrier.
- **Not given, unchanged.** A genuine instance of the expected app is not proof of this deployment's specific instance
  ("What this does and does not give a buyer").
- **Before any activation, the owner's:**
  1. **Scheduling.** A pVM phone as a runner needs a registry entry whose endpoint is the phone's tunnel row, a lease,
     and a ledger `runner` equal to that row's endpoint id. None is designed (item 5).
  2. **Production values.** Production `PVM_APP_*`, `METAL_AVF_*` and `PVM_CPU_*` values, and the decision to set
     `PVM_SERVING`: a production env change.
  3. **Rates.** Measured on the device (review question 3).
  4. **Instance identity.** Binding the deployment's instance needs a change to the evidence format, with its own review.
  5. **The extension.** Its `host_permissions` for the relay origin: a change to the installed artifact.
  6. **Cold start** (targets 3 and 5) for a runner.
  7. **Review.** The verifier session's review of this exact wiring.

## Runner registration and production configuration: what is done, and exactly what remains (2026-09-24)

Inspected read-only: relay/api-relay.js (`runnerEndpointOf`, `endpointId`, `readRegistry`), relay/tunnel.js
(`selfRoutedUrl`, the `hello` frame), supervisor.js (`register`, `claim`, checkpoints), metal/PROTOCOL.md,
relay/deploy.sh and relay/systemd/enclave-api-relay.service.
- **Not read:** /etc/nan-relay/*.env on the relay host. Those files hold live keys.
- **Nothing sent or changed:** no transaction, registry entry, lease or env change.

**How a deployment reaches a phone.**
- `/x/<id>` routes to the ledger row's `runner` while its lease is live.
- A runner id is `keccak256(endpoint)`, the registry's own derivation.
- A tunnel row takes that id only from a SELF-ROUTED `publicUrl`, `https://<relay>/t/<name>`, stated in its `hello`
  (tunnel.js `selfRoutedUrl`: any other URL is ignored, so no box can claim another's identity).

**Done in this slice.**
- **The phone's `hello`** now states `publicUrl = https://<relay host>/t/<name>`, derived from its relay URL
  (host/app/RelayAttach.java). Before this, a phone's row never took an on-chain id, so no lease could ever route to
  it.
  - Stating it registers nothing. It matches a ledger row only after the steps below.
  - Compile-checked; not yet run on the device.
- **The client's carriers.**
  - `--relay-base https://api.enclave.host` derives `<base>/x/<id>/pvm`.
  - The extension's manifest grants exactly `https://api.enclave.host/*`, beside the lab's loopback (client/DESIGN.md
    "Carriers").
- **The relay's hub** checks an instance-bound ABI/2 frame at attach and publishes the InstanceID in the row.

**What remains, exactly. Each is the owner's, and none is done here.**
1. **Register the phone as a runner.** From an operator EOA the owner controls, one transaction:
   ```
   EnclaveRegistry.register(endpoint = "https://api.enclave.host/t/<name>", repo, measurement (bytes32),
                            cpuPricePerSec6, gpuPricePerSec6 = 0, proofKey)
   ```
   - The phone's runner id is then `keccak256(endpoint)`.
   - Registration also needs a `heartbeat(id)` loop from the same EOA. The supervisor does this for metal boxes; for a
     phone it must be a small owner-side agent, not the phone's untrusted Android app.
   - The EOA is a seller key, not a TEE key.
2. **Take a lease.** `EnclaveDeployments.claim(<deployment id>, <runner id>)`, then `renew` and `release`, from the same
   EOA.
   - With the lease live and the phone attached with its `publicUrl`, `runnerEndpointOf(<deployment id>)` returns
     `tunnel://<name>`, and the pVM carrier routes to it.
3. **Proven time (ledger rev 9).**
   - A rev-9 ledger pays only for time the runner PROVES it served. The proof is checkpoints signed by the
     registry's `proofKey`, and metal boxes mint that key inside the CVM.
   - For a phone, the proof key belongs inside the pVM: the VM would mint a secp256k1 key and sign "this app was running
     here through T". That payload code does not exist.
   - It is a precondition, not a refinement. supervisor.js records that a rev-9 ledger refuses to sell work to a runner
     that published no proof key, so without it the phone cannot take a lease at all.
   - It is the next VM-side piece to build, and a design choice for this tier (the same pattern as the transport and
     instance keys).
4. **The relay's env.** Add these to `/etc/nan-relay/api-relay.env` (the unit's EnvironmentFile), then restart the relay:
   ```
   PVM_SERVING=1
   METAL_AVF_CODE_HASHES=<the production anchor build's code hash>    METAL_AVF_AUTHORITY_HASHES=<its signing authority>
   PVM_CPU_CODE_HASHES=<the same build>                               PVM_CPU_MODELS=<the admitted model table>
   PVM_APP_IDS=<the app ids>                                          PVM_APP_RUNTIME_IDS=<the pvm-rt runtime id(s)>
   ```
   Every value comes from a PRODUCTION build and signing key (item 6). The lab's values must not be used.
5. **The buyer's policy.**
   - A type-2 policy whose entry for the deployment lists the phone instance's InstanceID. The InstanceID comes from
     `pvm-client instance` against the live runner, under the signer's own nonce.
   - It is signed by the policy key the buyers' clients anchor.
   - Buyers then run `--relay-base https://api.enclave.host --deployment <id>`.
6. **A production anchor build.** It needs a release signing key and a non-debuggable manifest (PVM-CPU.md "What
   remains" 3), and the instance-binding device campaign (INSTANCE-BINDING.md) must run on it first.

**Inputs only the owner has.**
- The operator EOA for the phone runner, and its Base gas.
- The runner's price.
- The production APK signing key, and where the policy signing key lives.
- Which deployment id this is for.
- The decision to set `PVM_SERVING` in production.

The rest is implementation and is not blocked on anyone: the in-VM proof key (item 3, which a lease requires), the
device campaign, and the owner-side runner agent's code (items 1 and 2) once there is a key to sign with.

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
