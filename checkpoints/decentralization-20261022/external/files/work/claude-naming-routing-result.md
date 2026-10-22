# S2 follow-up: inbound routing of owner-committed names through independent hosts

Workstream result, written 2026-10-19. Checkout: `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave`.

- Nothing is committed or pushed.
- No SSH, private configuration, production changes, real CA orders, chain writes or Nan.
- The S2 guest/front source from the previous round is unchanged in this round. Only one paragraph of
  `docs/network/independent-names.md` was updated, to point at the new routing doc.

## Outcome

An independent direct host now routes the TLS ClientHello for an owner's custom name, for example
`shop.example.com`, to the deployment's guest. It needs no relay domain map, Enclave DNS zone, CA account or other
central service.

A name selects a deployment only while four conditions hold:

1. **Owner intent.** The name is in the exact startup package the current lease's envelope commits to. The package
   is verified against the lease's chain, ledger, deployment, owner and appRef. Its bytes come from operator-chosen
   gateways and are authenticated by the hash commitment.
2. **Name control.** The deployment's own guest, reached over the host's normal forward path, presents a certificate
   for the name that:
   - chains to the public roots;
   - is valid now;
   - is on exactly the TLS key that the host's current attested proof bound.

   A package proves intent only; only the CA's DNS validation produces such a certificate.
3. **Current scope.** The proof was made under the lease scope that is still current (owner, envelope, runner,
   appRef, ledger, chain) and under an unchanged attested key. Any change retires the route on the next ClientHello.
4. **Admission.** The usual lease and guest-proof gate passes.

Platform labels keep working unchanged: they are exclusive and always win a lookup.

### Conflicts

- **A deployment that lists a victim's name without a valid proof** is not a candidate. It can neither take the name
  nor veto it.
- **Two deployments that both prove a name:** the later certificate (`notBefore`) wins, because the name controller
  issued it more recently. An exact tie selects neither, for that name only; every other name keeps routing.

## Traced before building

- **Direct hosts** (`network/direct-runtime.mjs` via `enclave-network-host.mjs` and `wg-manager.mjs`) routed only the
  static `names` from operator configuration: the privacy-agent `apps[].names`, or `reconcile-core`'s names file with
  its `<8hex>.app.enclave.host` default.
- **wg providers** (`network/wg-provider/provider.mjs`) take custom names from a configured relay's
  `/v1/domains/map`, which is mutable and central. Their `route(name)` picks the newest peer holding a name, which
  would be a hijack vector if names were self-asserted.
- **The local guest proof** (`AdmissionGate` in `lease-reader.mjs`) already holds the attested `spkiSha256`. The lease
  reader already holds owner, configCid and runner, and `guestd.forward` splices only to the verified guest.

## Changes

### New: `network/owner-names.mjs`

- `ownerPackageNames(lease, bytes)`: verified package hosts plus the lease scope. A legacy envelope yields no names.
  A package for another deployment, owner or commitment throws.
- `ownerNameSource({lease, gateways})`: explicit gateways only, 1 to 8, HTTPS or literal-IP HTTP. Packages are cached
  by hash; a liar gateway cannot override the committed bytes.
- `proveNameControl(...)`: a single SNI handshake through a duplex served by the host's `forward`.
  - It checks the chain against the public roots (Node's bundled store by default), the hostname via SAN (wildcards
    allowed), validity, and that the SPKI equals the attested key.
  - It sends no application bytes, has a 5-second deadline, and closes both layers. A leak of one guest connection
    per proof was found by the e2e test and fixed; a test now asserts that no connection stays open.
- `forwardDuplex`, and `OwnerNameTable`: per-deployment claim sets; `select()` applies live checks, the 5-minute TTL,
  "latest wins" and "tie fails closed".

### `network/direct-runtime.mjs`

- Gains an optional `ownerNames` option. Without it, behaviour is identical to before.
- `lookup(name)` checks labels first, then the proof table, with live checks of admission, scope and attested key.
  Both the TLS listener and the port-80 redirect use it.
- Names are re-proven when an app becomes admitted and every 100 seconds: at most 10 names, one at a time.
- New `ownerStatus(id)`.

### `network/enclave-network-host.mjs` (narrow)

- Optional `enclaveNetwork.direct.ownerNames: {gateways:[…]}`; any other key is refused.
- It requires an `attestedKey` function and a lease reader.
- Leases are used only while `runner` matches this host.
- `ownerNameRoots` is a code-level root override for embedders and tests; no configuration file can set it.

### Other changes

- **`network/privacy-agent.mjs`** (one line, needed for plumbing): passes `attestedKey` from the current admission
  proof. Outside the explicitly listed files, but it is the only holder of the attested key.
- **`network/app-ingress.mjs`:** optional `admitName(name)` predicate for single-app listeners (Windows circuit
  worker integration later). Validated; it can only admit to its own app.
- **`reconcile-core.mjs`:** unchanged. Static names stay operator-asserted and exclusive on that host, and are
  documented as such.
- **Docs:** new `docs/network/independent-name-routing.md`, a runbook with owner A/AAAA/CNAME, TTL, CAA and
  certificate-first requirements, host configuration, conflict rules and remaining gates. Plus the one-paragraph
  pointer in `docs/network/independent-names.md`.

## Tests

New file `test/independent-name-routing.test.mjs`, 4 tests, all pass in under 1 second. It uses real TLS/SNI through
`createNetworkHost` → `DirectRuntime`.

The fixtures:

- Real openssl PKI: a test public root and a rogue root.
- Guest fixtures: Node TLS servers, one key each, serving certificates by SNI the way the Go front does.
- Real `preparePackage` packages committed in fixture leases.
- Gateways: one lies and one is honest.
- A fetch wrapper that refuses `*.enclave.host` and records any attempt; none occurred.
- Checker-signed `qualifyProvider` qualifications, `RoutePublisher`-signed route records, and client-side
  `verifyRoute` with a durable rollback floor.

Covered, with central services refusing:

- **Routing:** valid custom names route; the platform label still serves; port 80 sends a 308 only for routed names,
  and 421 otherwise.
- **Refusals:** a name the package doesn't list; a listed name without a certificate; a certificate on the wrong key.
- **Attacker deployment on the same host claiming `shop`,** with each of: no certificate, a self-signed
  certificate, an untrusted root, an older public certificate. In every case the victim keeps the name and the
  attacker keeps its own names.
- **Exact tie:** `shop` is refused, while the victim's `www` keeps routing.
- **DNS controller issuing later to B:** B wins (the controller moved the name), and A wins again once B's proof is
  gone.
- **Key change** (guest relaunch): the route is retired until re-proven.
- **Package substitution:** another deployment, another owner or another commitment never yields names.
- **Ownership transfer:** retired immediately; the revoked guest no longer proves; the new owner's relaunched guest
  proves and routes.
- **Runner transfer:** the old host refuses at once and its signed record no longer verifies. The new host proves and
  publishes; the client verifies the new record and reaches the guest; an older record is refused by the rollback
  floor. DNS-style failover across both providers' addresses works with the first host down.
- **Unit:** name-table ties, no veto, TTL and scope.
- **`app-ingress`:** `admitName` admits only proven names to its own app.
- **Host config:** `ownerNames` is refused without an attested key, with extra keys (such as a relay), with a
  non-literal HTTP gateway, or with no gateways. Without the block, labels only.

Commands, all run locally:

```sh
node --test test/independent-name-routing.test.mjs                       # 4/4 pass (~0.85 s)
node --test test/app-redirect.test.mjs test/direct-runtime.test.mjs test/local-app-router.test.mjs \
  test/privacy-agent-config.test.mjs test/privacy-agent-proofs.test.mjs test/reconcile-independent.test.mjs \
  test/wg-manager.test.mjs test/wg-provider.test.mjs test/wg-renewal.test.mjs test/host-egress.test.mjs \
  test/local-byo-config.test.mjs test/network-authority-pins.test.mjs test/provider-canary.test.mjs \
  test/route-record.test.mjs test/route-publisher.test.mjs test/app-broker.test.mjs test/startup-expectation.test.mjs \
  test/bootstrap-names.test.mjs test/bootstrap-package.test.mjs test/independent-name-routing.test.mjs   # 87/87 pass
```

While I was debugging, another session started a full-suite `node --test` run that includes this file. An earlier
draft's teardown hung on the proof-connection leak; that is fixed, and the file now exits in under 1 second.

## Hardware and evidence statement

- **Fixtures, not hardware:** the guests are fixtures, not SEV-SNP guests; the attested key is a fixture standing in
  for the admission proof; the "public" CA is a local test root; leases are fixtures, not chain reads.
- **Not exercised:** real DNS, a real CA certificate, a real guestd splice and a real Go front.
- **Still needed live:** a measured direct guest on a qualified direct host, a staging or production CA certificate
  via S2 issuance, the owner's public DNS pointing at the host, and a browser reaching it.

## Remaining gates and integration notes

- **wg-provider (Enclave-network circuit) ingress is not converted.** It still uses the relay domain map, and
  `network/wg-provider/main.mjs` is being edited by another stream. The integration design is in the routing doc:
  - derive peer candidate names from the verified package via the lease the provider already reads;
  - after the grant, prove each name over the peer's tunnel with `proveNameControl`;
  - store proofs in an `OwnerNameTable`, make `route(name)` call `select(name, live)`, and drop the relay map.

  The provider cannot see the attested key, so it can bind only WebPKI plus the tunnel; clients still verify
  attestation.
- **Windows circuit worker:** wire `admitName` to a host-side proof table (Windows stream).
- **Browser (precise note for that author):** `site/js/core/startup-package.js` allows the keys `version, chainId,
  ledger, deployment, owner, appRef, appId, runtimeId, configText, secretsMode, custody`, so it refuses any package
  with `names`. Fix:
  - add `names` to that list;
  - validate it exactly as `sdk/bootstrap/package.mjs` `validateNames(m.names, m.secretsMode)` does, by importing
    that function or mirroring it;
  - test against `isolation/m2/bootstrap/testdata/names-vectors.json` (38 cases).

  I did not edit it.
- **Native client:** no change needed. Its profile `hostname` is used as SNI, so an owner name works against a
  direct host that routes it.
- **Status surfacing:** `DirectRuntime.ownerStatus` is not yet part of the privacy agent's status snapshot or the
  `wg-manager` status (not my files).
- **Static operator names** (configured names, reconcile `--names-file`) remain exclusive on that host without
  proof. That is unchanged behaviour, and documented: an operator controls its own box's routing, but cannot obtain
  a certificate or attestation.
- **Limits.**
  - A previous DNS controller's unexpired certificate can still win if no newer certificate exists; that is inherent
    to WebPKI.
  - Proofs refresh every 100 seconds, so a newly certified name routes within about 100 seconds, or immediately on
    admission.
  - Duplicate-certificate limits from S2 still apply.
- **Organizational independence:** every host, gateway and CA used so far is a fixture or Enclave-operated. Real
  independence needs hosts, gateways and responders run by other parties.

## Files

- **New:**
  - `network/owner-names.mjs`
  - `test/independent-name-routing.test.mjs`
  - `docs/network/independent-name-routing.md`
- **Modified:**
  - `network/direct-runtime.mjs`
  - `network/enclave-network-host.mjs`
  - `network/app-ingress.mjs`
  - `network/privacy-agent.mjs` (one line)
  - `docs/network/independent-names.md` (one paragraph)
- **Not touched:**
  - CLI, site, `native-client`, `management-*`, `public-directory`, `directory-server`
  - custody, Windows, contracts
  - `wg-provider/*`, `wg-manager.mjs`, `reconcile-core.mjs`, `reconcile-apps.mjs`
  - the S2 Go/JS source
