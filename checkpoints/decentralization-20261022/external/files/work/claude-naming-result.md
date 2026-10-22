# S2: independent names and WebPKI for direct guests

Workstream result, written 2026-10-19. Checkout: `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave`, branch
`decentralize/nan-retirement`. Nothing is committed or pushed. No live services, SSH, chain transactions, real
CAs or hardware were used.

## Outcome

A direct measured guest (the `bootstrapdirect` front) can now serve owner-committed custom DNS names with a
browser-trusted certificate for its own attested TLS key. None of these is required:

- Enclave's domain map (`api.enclave.host/v1/domains/map`)
- Enclave's CA account or EAB
- the `/v1/expected-guest` prediction
- Enclave's DNS-01 zone or fleet HMAC

The owner selects the CA and the challenge responder in the startup package. There is no default and no
fallback. Separately, any operator or owner can still issue externally with their own CA account through the
guest's existing CSR and install endpoints.

The existing legacy paths are unchanged and still pass their tests:

- the relay-fed domain watcher in non-direct guests
- supervisor-guestcert with the relay's expected-guest gate
- the `<8hex>.app.enclave.host` label
- the dns-relay fleet, operator-signature, U7, read-only and box-zone modes

## How the existing flow worked (traced in source)

- `isolation/m2/front/certs.go` mints the TLS key in guest memory.
  - `GET /.well-known/enclave-csr` returns a CSR for that key.
  - `POST /.well-known/enclave-cert` installs a chain if the leaf carries that key, names the name, and is valid
    now. It does not check the CA path.
  - The name came only from `HOST_DATA` (`<8hex>.app.enclave.host`, the `-cert-zone` default), or for
    non-direct guests from the relay map (`domains.go` `watchDomains` → `release.RelayHost`).
- Issuance was relayed by the supervisor (`isolation/m4/guestd/supervisor-guestcert.mjs`):
  - it needs the relay's `/v1/expected-guest` prediction;
  - the certificate comes from `relay/certs.js` (Enclave's CA account) via DNS-01 in Enclave's zone;
  - `relay/dns-relay.js` authorizes TXT writes with the fleet HMAC, or with an operator signature plus the
    api-relay's U7 eligibility verdict.
- Direct mode already disabled the relay watcher (`!directBootstrap`), so a direct guest had no custom names and
  no independent issuance path.

## What was built

### 1. Owner-committed names in the startup package (Go + JS, strictly cross-validated)

- **Files:**
  - `isolation/m2/bootstrap/names.go` (new) and `manifest.go` (one optional field plus one validation call)
  - `sdk/bootstrap/package.mjs`: new exports `validateNames`, `challengeLabel`, `challengeAlias`, `dnsName`,
    `ownerHost`, `MAX_OWNER_NAMES`. Existing exports and signatures are unchanged.
- **Schema:** an optional `names: {hosts[1..10], acme?: {directory, challenge, zone, eab?: {kid, hmac}}}`.
  - `hosts`: strictly ascending, lowercase LDH names, at least two labels, a top label with a letter. No wildcard,
    trailing dot, IP literal or `enclave.host` name.
  - URLs: `https://<dns name>[/path]` only.
  - `eab` names custody secrets and requires `custody-v2`. Credential values never appear in the package.
  - Nulls, unknown keys, case aliases and duplicate keys are refused in both languages.
- **Compatibility:** existing exact v1 package bytes keep their hash and meaning (tested).
- **Cross-language vectors:** `isolation/m2/bootstrap/testdata/names-vectors.json` holds 38 accept/refuse cases
  plus alias vectors. Go `Authorize` and JS `verifyPackage` must agree on every one.
- **Challenge alias:** `_acme-challenge.<label>.<zone>`, where
  `label = sha256("enclave-acme-alias-v1\0" || deployment || owner)[:32 hex]`. Because it commits to the
  current owner, a delegation published for one owner stops working after an ownership change.
- **Authorization API:**
  - `NameGrant()`: hosts and ACME selection, valid until the earlier of the lease end and the last fresh quorum
    snapshot plus `NameGrace` (10 minutes).
  - `Refresh()`: unlike `Revalidate`, an RPC outage is transient. A change of owner, runner, operator, app
    reference or envelope returns `ErrRevoked`, permanently.

### 2. Direct front: names, certificate rule, status (`isolation/m2/front`)

- **`names.go` (new):** applies the owner's committed hosts to the certificate state. The direct path never uses
  the relay map.
  - It refreshes every minute and revokes on change.
  - Names lapse after an outage longer than the grace window, and never outlive the lease.
  - It serves `GET /.well-known/enclave-names`, a public status with:
    - committed versus authorized names and the grant expiry;
    - the certificate per name (issuer, serial, validity, renewal point);
    - in-guest issuance state (last attempt, last error, next attempt);
    - the challenge alias and the stated limits.
  - The status contains no key material.
  - Names never stop the app: a stale grant at startup is refreshed once; otherwise the guest runs without names.
- **`certs.go`:** a certificate for an owner-committed name is installed only if its chain verifies to the
  WebPKI roots measured into the image (ISRG X1/X2, Sectigo E46, USERTrust ECC, GTS R4, DigiCert G2), on top of
  the existing key, name and validity checks.
  - So a package claim alone can never produce a served, trusted name; a CA must have validated it through DNS.
  - Legacy relay aliases and the `HOST_DATA` label keep their old rule (tested).
- **`domains.go`:** `setOwnerNames`, which reuses the alias machinery. Children keep installed certificates
  across refreshes; revocation drops them all at once.
- **`acme.go` (new):** in-guest RFC 8555 using `golang.org/x/crypto/acme` v0.37.0, added to `isolation/m2/go.mod`
  from the local module cache.
  - The account key lives in guest memory and is never the TLS key.
  - The EAB is resolved from custody secrets inside the guest.
  - One name per order, so each name is its own duplicate set.
  - The dns-01 value is pushed to the owner-selected responder with two proofs:
    - a signature by the attested TLS key over a domain-separated body hash;
    - an attestation document whose report binds that key and a nonce derived from the push.
  - It reuses a certificate until two thirds of its lifetime, backs off failures from 15 minutes to 24 hours,
    and re-checks authorization right before installing.
  - Egress goes through the host egress protocol, with TLS verified against the measured roots.
  - Issuance starts only after the app serves, so the attestation's runtime self-test covers it.
- **`main.go`:**
  - The attestation document is factored into `attestDoc`; the endpoint's responses are byte-identical.
  - New route `/.well-known/enclave-names`.
  - Names and the issuer start only when `directBootstrap` is set.
- **`bootstrap.go`:** `runDirect` hands the authorization (and a resolved EAB) to main.
- **`provision.go`:** a one-line field on `provisioned`. This is outside my named list; it is the narrow plumbing
  needed.
- **`oracle_test.go`:** the report-path audit list was updated from `attest` to `attestDoc`, with a reviewed
  comment. The binding is still Bind/Bind2 over a nonce and never the release domain. The push nonce is the same
  public binding that anyone can already request.

### 3. Independent challenge responder (`relay/dns-relay.js` + new `relay/dns-challenge-attested.mjs`)

- **New mode `DNS_CHALLENGE_AUTH=attested`:** an authoritative DNS-01 responder that anyone can run for their own
  `CHALLENGE_ZONE`.
  - It needs no fleet, registry, HMAC, route map, eligibility API or Enclave origin.
  - It refuses to start if any of those, or the legacy zones, are configured, so there is no silent fallback.
  - `ATTESTED_MEASUREMENTS` (explicit pins) is required.
  - Optional settings: `ATTESTED_MIN_TCB`, `ATTESTED_KDS=0`, and `ATTESTED_JUDGE_MODE=lab-unsigned`, an explicit
    lab mode reported on `/health`.
- **What a write requires (set or delete):**
  - The body is signed by the key it names (P-256).
  - The report binds that key and this exact push.
  - The launch measurement is pinned.
  - `isolation/m2/judge.mjs` passes: AMD chain, runtime binding and self-test, TCB floor if configured.
  - `HOST_DATA` is the deployment named in the push.
  - The name is that deployment and owner's alias in this zone.
  - The value is a dns-01 digest.
  - The timestamp is within 300 seconds.
- Answers come from the existing wildcard/TXT resolver, so names without a value get NODATA rather than NXDOMAIN.
- The standalone `dns.mjs` built by `scripts/network/build-consumers.mjs` bundles the judge and runs; this was
  smoke-tested on loopback.
- `isolation/m2/front/testdata/attested-push.json` is a Go-generated vector that pins agreement between Go and JS
  on field order, nonce derivation and the signature domain.

### 4. CLI (`cli/enclave.mjs`, `bootstrap prepare` only)

- New flags: `--names HOST,…`, `--acme-directory`, `--acme-challenge`, `--acme-zone`, `--acme-eab-kid-secret`,
  `--acme-eab-hmac-secret`. The host list is sorted and de-duplicated before validation.
- The CA, responder and zone must all be given explicitly; EAB needs both secret names and a custody package.
- The output lists the `_acme-challenge.<host>. CNAME <alias>.` records to publish.
- Only `cmdBootstrap`'s prepare branch, its usage line and the help text were touched. The file had no
  concurrent modifications.

### 5. Documentation

`docs/network/independent-names.md` (new) covers the schema, what a listed name is worth, the alias, both
issuance modes, running a responder, lifecycle and state, the remaining limits and the activation gates.

## Tests (all run locally; all pass)

The new tests:

| Test | What it proves |
| --- | --- |
| `front/names_test.go` `TestDirectOwnerNamesIssueThroughOwnerSelectedResponderWithoutEnclave` | See the breakdown after this table. |
| `TestChangedOwnerCannotUseThePreviousOwnersDelegation` | A new owner's guest cannot validate through the old owner's CNAME. |
| `TestOwnerNamesLapseOnOutageAndUseCustodyEAB` | An EAB-requiring CA receives an HMAC binding from custody secrets; missing or undecodable EAB is reported; an outage lapses names only at the grant end. |
| `TestOwnerNamesNeverBlockStartup` | A stale grant at startup is refreshed once; otherwise the guest runs without names and does not die. |
| `TestLegacyAliasesKeepTheirInstallRule` | Legacy alias shape and install rule are unchanged; owner names refuse platform names. |
| `TestAttestedPushWireFormatVector` | The Go push vector re-encodes identically, its nonce and binding match, and its signature verifies. |
| `bootstrap/names_test.go` | 38 schema vectors through the real `Authorize` on a fake quorum; alias vectors; legacy v1 package has no names; refresh survives an outage but is permanently revoked by owner, runner, operator, appRef or envelope changes; names expire with their snapshot. |
| `test/bootstrap-names.test.mjs` | JS agrees with every Go vector and alias; exact v1 bytes are preserved; prepared named packages carry no credential values; EAB requires custody-v2. |
| `test/dns-relay-attested.test.mjs` | See the breakdown after this table. |
| `test/cli.test.mjs` (one new test) | Prepare writes canonical names and ACME, prints owner-bound CNAMEs, makes no API or transaction calls, and refuses platform names, partial ACME, ACME without names, EAB in a public package, and half an EAB. |

`TestDirectOwnerNamesIssueThroughOwnerSelectedResponderWithoutEnclave` runs the real `runDirect` on a fake chain
quorum while Enclave's release ticket refuses, then the real `ownerHTTP`/egress protocol into a fake RFC 8555 CA
and the owner-selected responder. It proves:

- the delegated name gets a CA certificate on the attested key, verified by a TLS client;
- the undelegated committed name fails at the CA, reports the missing CNAME and backs off;
- the platform-default responder and every `enclave.host` origin are never contacted, and the TXT value is
  cleaned up;
- the status endpoint is correct;
- a foreign name gets no CSR and no install;
- a TLS-key mismatch and an unmeasured root are refused, and the served certificate is not replaced;
- external issuance for a committed name works;
- an on-chain owner change revokes everything (no CA certificate served, no CSR, no further issuance), and a
  later read cannot undo the revocation.

`test/dns-relay-attested.test.mjs` spawns the real daemon and proves:

- an attested push is served over UDP and TCP DNS, and delete removes it;
- other zones are refused, and unknown aliases get NODATA;
- the log never names `api.enclave.host`, eligibility, fleet or registry;
- refusals for: a push signed by another key (TLS-key mismatch); an attested key different from the named key;
  the previous owner's alias under a new owner; another deployment's HOST_DATA; an unpinned measurement; an
  attestation for a different push; a stale timestamp; a name in another zone; a value that is not a digest; an
  extra field; a delete body replayed as a set;
- the new owner can write only at its own alias;
- startup is refused with a DNS key, route map, registry, eligibility API, legacy zone, read-only mode, missing or
  bad pins, a bad judge mode, a missing zone, or an unknown auth mode;
- the Go vector's signature and nonce verify in JS, and a T0 document is refused;
- trusted mode never accepts a synthetic report.

Commands and results:

```sh
cd isolation/m2
GOPROXY=off go vet ./...                                   # ok
GOPROXY=off go test -count=1 ./...                         # all packages ok (front 5.5s, bootstrap, egress, release, custody, …)
GOPROXY=off go test -race -count=3 ./bootstrap/            # ok
GOPROXY=off go test -race -count=1 ./front/ -run 'OwnerNames|ChangedOwner|LegacyAliases|DirectOwner|AttestedPush|EveryReportPath|NeverBlock'  # ok
go build -o /dev/null -tags bootstrapdirect ./front && go build -o /dev/null ./front   # both variants build
UPDATE_PUSH_VECTOR=1 go test ./front/ -run TestAttestedPushWireFormatVector  # regenerates the push vector (done once)
(cd ../m3 && GOPROXY=off go vet ./...); (cd ../m4/guestd && GOPROXY=off go vet ./...)  # dependants ok

cd ../..
node --test test/bootstrap-*.test.mjs test/startup-expectation.test.mjs test/dns-*.test.mjs \
  test/isolation-guestcert-expected.test.mjs test/guestcert-retry.test.mjs test/custom-domains.test.mjs \
  test/acme.test.mjs test/direct-only-supervisor.test.mjs test/native-profile.test.mjs \
  test/isolation-runtime-identity.test.mjs                 # 174 tests: 173 pass, 0 fail (1 skipped by its suite)
node --test test/cli.test.mjs                              # 76/76 pass
node scripts/network/build-consumers.mjs /tmp/consumers-check   # dns.mjs bundles judge; attested /health smoke ok (removed after)
```

`names-vectors.json` was generated once from the case table, using the SDK for the alias labels. It is now a
fixed fixture that both languages must agree on.

## Activation requirements (not done here; each needs coordinator action or evidence)

1. **New measured release.** The front's source changed, so both the direct and the legacy front binaries would
   measure differently if rebuilt. Existing releases are unaffected until re-released. The direct release must be:
   - built with `golang.org/x/crypto` v0.37.0 available to the reproducible build: `go.sum` is pinned, and the
     module must be in the build's module cache or proxy;
   - given its measurement published;
   - validated on SEV-SNP hardware: a real report with VCEK through the attested responder in `trusted` mode,
     and a real CA order.
   - Nothing here was hardware-activated.
2. **Supply-chain review** of the new `x/crypto/acme` dependency in the measured TCB.
3. **Pin distribution.** Responder operators pin the new direct measurement(s) in `ATTESTED_MEASUREMENTS`, and
   should set `ATTESTED_MIN_TCB`.
4. **A responder operated by the owner or an unrelated party,** with its zone delegated (NS) to it, and the owner
   publishing the CNAMEs the CLI prints. A responder run by Enclave is not organizational independence.
5. **No public certificate has been issued** through this path. A coordinator-run test against Let's Encrypt
   staging or a ZeroSSL EAB account is the next evidence step.

## Remaining feature gates and coordination notes

- **Inbound reachability (other streams).** The provider ingress (`network/app-ingress.mjs` name lists via
  `direct-runtime`/`reconcile-core`) must include the owner-committed hosts from the verified package, and the
  owner's A/AAAA/CNAME must point at that ingress. Nothing in this change routes SNI for custom names.
- **Browser package verifier.** `site/js/core/startup-package.js` (the browser stream's new, untracked file) has
  its own key allowlist without `names`, so it will refuse named packages. It should accept the optional member by
  importing or mirroring `validateNames`. I did not edit it.
- **Native client.** `network/native-client.mjs` (another stream) accepts named packages through `verifyPackage`.
  Exposing `names.hosts` as allowed hostnames is optional follow-up work.
- **`cli/dist/enclave.mjs`** was not rebuilt; it is a publish artifact.
- **Duplicate-certificate limits.** Keys live only in memory, so each relaunch re-issues. The mitigations are:
  one name per order, reuse until two thirds of the lifetime, backoff, honest status, and documentation that
  recommends an EAB CA without a duplicate cap. A host, or a second genuine instance under the same deployment,
  can burn the CA budget by relaunching. That is denial of service, not key exposure. Sealed persistence across
  relaunches does not exist yet.
- **Early lease termination.** It is reflected within `NameGrace` (10 minutes) rather than immediately, because
  the chain reader reports an inactive lease as a read failure. `chain.go` was not changed.
- **Responder trust.** The responder does not read the chain; it trusts the pinned measured code's own quorum
  checks. This is documented as the operator's trust.
- **Not covered:** wildcards, or more than 10 names per deployment.
- All current infrastructure is Enclave-operated or test infrastructure. This change enables independence but
  does not demonstrate it.

## Files touched

- **Modified:**
  - `isolation/m2/bootstrap/manifest.go`
  - `isolation/m2/front/{bootstrap,certs,domains,main,provision}.go`
  - `isolation/m2/front/oracle_test.go`
  - `isolation/m2/go.mod`, `isolation/m2/go.sum`
  - `relay/dns-relay.js`
  - `sdk/bootstrap/package.mjs`
  - `cli/enclave.mjs`
  - `test/cli.test.mjs` (one appended test)
- **New:**
  - `isolation/m2/bootstrap/{names.go,names_test.go,testdata/names-vectors.json}`
  - `isolation/m2/front/{names.go,acme.go,names_test.go,acme_test.go,testdata/attested-push.json}`
  - `relay/dns-challenge-attested.mjs`
  - `test/{bootstrap-names,dns-relay-attested}.test.mjs`
  - `docs/network/independent-names.md`
- **Outside the assigned list, kept narrow:**
  - `front/provision.go` (one field)
  - `front/oracle_test.go` (audit list rename)
  - `test/cli.test.mjs` (one test)
  - `relay/dns-challenge-attested.mjs` (a helper module for the responder)
- **Not touched:** `supervisor.js`, guestd, `native-client`, `site`, custody, Windows.
