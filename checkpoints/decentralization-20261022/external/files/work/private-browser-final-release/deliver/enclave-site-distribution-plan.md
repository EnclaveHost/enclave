# Enclave site: production release and distribution through Enclave apps (plan; nothing published)

Workspace: work/private-browser-final-release (claude 6b7af721), 2026-10-20 Phoenix.
Read first: work/effective-goal-requirements.txt (sha256 eada322e…), sections HOSTED SERVICE PLACEMENT and PROVIDER
INDEPENDENCE.

**Root owns every step marked ROOT.** That covers publication, deployment creation/funding, DNS/registrar changes, IPNS
moves and wallet signatures. This document signs, sends, deploys and publishes nothing.

## 0. What exists today (deployed coverage, recorded separately from source support)

| Path | Today | Provider-independent? |
| --- | --- | --- |
| https://enclave.host (DNS) | 4 A records, all in the DigitalOcean fleet (provider-failure-domain-audit.json) | **No** |
| Site bytes | Caddy + local roots on the same 4 DO machines; production CID bafybeig3rai3tyo… (logo hotfix) | **No** |
| Recovery origins | the 4 DO IP origins (outputs/site-recovery-direct-ip.txt) | **No**: same provider, geographic redundancy only |
| ipfs.enclave.host gateway | same 4 DO addresses | **No** |
| ipns-publisher | Enclave app; record server + delegated PUT. Nan-retirement notes a failed DHT walk and one stale delegated GET (docs/design/nan-retirement.md:33-39) | Partial; never the only path |

The current coverage is therefore **zero** for "site available when every DigitalOcean endpoint is unavailable". This plan
does not change that by itself. It specifies what has to exist and in which order.

## 1. The release (prepared here, not published)

- **Composed source.** Main e762a9c5 plus root's uncommitted integrations (status digest e2907853…), then the frozen
  private-browser patch (ca97f726…), then the test-only live-edit acceptance patch.
- **Untouched.** Main's appzone/history UI edits (deployments.js "App address certificate", "History sources for cold
  starts", history-checkpoint.js) are kept as they are; the build is checked to still contain them.
- **No built-in network profile**, as on main (scripts/site-built-in-profile.mjs without flags: hosted defaults, and a
  saved browser profile still applies). The production-profile workstream has no reviewed profile and no ready gate, so
  shipping one would strand users.
- **Base.** The production tree bafybeig3… (work/logo-site-hotfix/final, read-only), dated by its build.json builtAt
  2026-10-20T02:14:19.960Z. Its hashed chunks and CSP hashes are retained for 48h (the release ledger travels at
  /.well-known/enclave-site-release.json).
- **Shield.** Nothing in this release claims Enclave Shield. The UI shows Shield only from the relay's actual host verdict
  (pool-badges.js: tunnel && hv-node && enclave-shield && eligible && appEvidenceRequired). No capability flag is added.

Final release: **bafybeiex25avvxryg6vzw7d57npdliy5qtfuss3c5lrbk5i5o7tx4kzgdi** (876 files, CAR sha256 9ff91d28…), built from main status 0d0ba94f + the frozen patch. Review and evidence: work/claude-private-browser-final-release-result.txt.

## 2. Serving through Enclave apps: what the platform already gives

- **Own origin per app.** Each public deployment is served at `<label>.app.enclave.host` with the whole origin:
  supervisor.js:5008, 5153-5155; relay/api-relay.js:2341-2356. /x paths answer 410 on the relay front.
- **App headers pass through.** The app's own CSP/COOP/HSTS/Cache-Control reach the browser unchanged; only hop-by-hop
  headers are stripped (supervisor.js:5046-5059). The isolation guest front is a plain ReverseProxy
  (isolation/m2/front/ready.go:84-93).
- **The app holds its own certificate.** BYO domains use an in-enclave certificate and a key that never leaves the guest
  (relay/domains.js). That is how `enclave.host` itself can be a name of an Enclave deployment, its key held by the
  serving TEE.
- **IPNS publisher** moves `/ipns/<name>` with an owner setConfig (`changedKeys: ["value"]`, scripts/site-release/publish.mjs).
- **s3-ipfs-adapter is a DAG/CAR source only.** It forces `sandbox` CSP and path-style `/ipfs/<cid>/`
  (src/main.rs:1612-1626), so it cannot be the site origin.

## 3. `site-host`: the Enclave app that serves the site (implemented here; root assigned it 2026-10-21T03:08Z)

- **Source.** work/private-browser-final-release/site-host, in enclave-apps layout. See site-host/README.md for routes,
  refusals and trust, and RESULT for hashes and test evidence.
- **Shape.** A pure `wasi:http` component, vault's shape, published like hello-world (`--mem 256`).
  - The release CAR is embedded, so the catalog CID of the component covers every site byte.
  - The deployment config pins `{"release": "<CID>"}`.
  - The WIT world imports nothing: no outgoing-handler, no sockets. It cannot fetch at serve time, which is asserted on
    the built binary and exercised in a loopback-only namespace.
- **Verification.**
  - Every request walks from the pinned root and re-hashes each block it serves.
  - A wrong or missing pin refuses the whole site, as does a malformed ledger or header policy, an unknown file type,
    a reserved path, a HAMT shard or a `_redirects` rule the production generator would reject.
  - Hostile paths (traversal, encoded separators, control bytes) are refused, never cleaned.
- **Parity with the production vhost.**
  - pretty routes from `_redirects`, case-insensitive, only when no file shadows them;
  - SSO popup without COOP;
  - `/js/boot.js` no-cache;
  - `/install.sh|ps1`;
  - canonical directory redirects;
  - branded 404.
  Headers are byte-identical to the release tool's `headers.caddy`.
- **Stricter than the vhost.**
  - no compression;
  - ETag = file CID;
  - explicit Cache-Control on every response (hashed chunks immutable, others revalidate, errors no-store).
- **Not in any bootstrap chain.**
  - It is a consumer only: the deployment's wasm arrives over the platform's catalog/IPFS artifact path (the
    hosted-service-placement worker's), like every app.
  - It serves no artifact, directory or discovery data.
  - The installers it serves fetch their runtime from get.enclave.host (the artifact service), not from the site.

## 4. Distribution and the recoverable entrypoint

1. **Canonical origin stays https://enclave.host.** The site stays on that origin because:
   - existing passkeys (RP enclave.host), saved browser profiles, wallet sessions and localStorage are origin-bound;
   - moving the origin would strand existing users.
   The Enclave admin keeps the registrar/zone (ROOT).
2. **Serving.** N site-host deployments (one per region/host class), each a public Enclave deployment funded by Enclave
   (ROOT spend). Each is reachable at its own `<label>.app.enclave.host` and serves `enclave.host` as a BYO name, with
   the certificate minted in its own TEE.
   - **DNS** for `enclave.host` answers with the fronts of hosts that currently serve a healthy site-host lease.
   - **Who answers DNS** is the DNS route replica + attested dns-01 responder on Enclave hosts (certificate worker,
     work/certificate-hosted-placement-interface.txt). It is not the DigitalOcean relay.
   - **The DigitalOcean machines** keep only WireGuard transport. SNI passthrough without decryption is the most they
     may carry, and that must be justified explicitly by the placement worker.
3. **Artifacts.** The release CAR is pinned:
   - on the s3-ipfs-adapter/kubo targets the placement and storage workers run on Enclave hosts;
   - by `site/deploy.sh mirror --targets` to every configured kubo target.
   The site-host app's own artifact is distributed by the Enclave artifact path (placement worker). The site is NOT
   needed to fetch any artifact, so there is no cycle.
4. **Named pointer.**
   - The ipns-publisher value is moved to `/ipfs/<CID>` with `site/deploy.sh publish-plan`. That is one owner setConfig
     (ROOT signs).
   - The on-chain ledger config of the publisher (and of each site-host deployment) is the recoverable entrypoint. Anyone
     with a Base RPC can read the current CID from the admin-owned contracts, then fetch the CAR from any source and
     verify it.
   - IPNS/DHT is a convenience, never the only path.
5. **Cold recovery when enclave.host DNS or every front is down:**
   - read the CID from chain;
   - `site/deploy.sh fetch --cid … --gateway <any source>`, or a `<label>.app.enclave.host` site-host, or a user's own
     `local-root`.
   - **Limitation:** a different origin starts with empty browser state and cannot use enclave.host-RP passkeys. The
     owner signs in with a wallet or session; with the private-browser patch, private apps accept an owner-selected
     frontend through a session-signed hand-off. This is stated, not hidden.

## 5. Staged cutover (each stage ROOT; stage before removal)

| Stage | What happens | Rollback |
| --- | --- | --- |
| S0 | Root reviews this release CID: `site/deploy.sh review/verify` | Nothing to roll back |
| S1 | Root mirrors the CAR to kubo/s3 targets on Enclave hosts (no activation) | Prune |
| S2 | Root publishes site-host (`enclave publish … --slug enclave-site --config '{"release":"<CID>"}'`) and deploys ≥2 leases on admitted non-DO hosts (spend) | Cancel the leases. The catalog version stays harmless: it only serves its own CID. |
| S3 | Probe each site-host `<label>.app.enclave.host` against the DO Caddy: same bytes, same headers | None needed |
| S4 | Root adds the site-host fronts to the enclave.host answer set **alongside** DO, through the Enclave-host DNS replica | Remove them |
| S5 | Root moves IPNS to the CID (publish-plan → owner signature) | publish-plan to the previous CID |
| S6 | DO drill in an isolated environment: block all 4 DO addresses; the site must still load from empty caches with no hidden DO download | — |
| S7 | Only after S6 passes: remove site Caddy/local roots from the DO machines, leaving WireGuard only | Re-add the Caddy root (kept for 48h) |

## 6. Remaining gates (not met by this work)

- **G-site-host:** implemented and tested in isolation (section 3). It is neither published nor deployed (ROOT).
- **G-dns:** enclave.host answers from Enclave-host DNS replicas, which are in progress in the certificate worker's
  workspace.
- **G-non-DO hosts:** at least 2 admitted non-DigitalOcean Enclave hosts able to lease site-host. Only the minipc is
  known non-DO today, and one mandatory machine is insufficient by the requirements. Hosts outside DigitalOcean also
  need operator participation; nothing is purchased.
- **G-api:** the static site still calls api.enclave.host (relay on DO) unless a reviewed built-in network profile
  ships. That is owned by the site-production-profile and placement workstreams.
- **G-drill:** an all-DigitalOcean-down isolated drill (S6) has not been run.
