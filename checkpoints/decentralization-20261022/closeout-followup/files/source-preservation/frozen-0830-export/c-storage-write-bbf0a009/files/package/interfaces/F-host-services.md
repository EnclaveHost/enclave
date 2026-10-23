# What a storage replica needs from the platform host-service release (F owns it; this file only states the interface)

The storage-indexer host role (`network/host-services/storage-indexer-host.mjs` 20abb681, a KEYED role with its own
supervisor, not one of runner.mjs's no-secret ROLES) binds indexd's application API to `appAddress` = `127.0.0.1:<port>`
(loopback only, role `validateConfig`) and advertises `advertiseURL` = `https://<host>[:port]` (no path). That URL is
signed into the replica's descriptor (`applicationAPI`), and sia-s3 deployments list it in `$SIAS3_REPLICAS`.
`tools/cutover.py` refuses a NEW replica whose URL is http, `sia.enclave.host` / `ipfs.enclave.host`, or a DigitalOcean
address.

Required from the host-service platform (none of it exists for storage today):

1. **A public https name per storage replica.**
   - It must resolve and route to that host's `appAddress` WITHOUT application logic on DigitalOcean. The DigitalOcean
     machines may carry it only as WireGuard transport: raw packets through a guarded service circuit, as G1/G2 do for
     `dir`/`boot`/`policy`.
   - Concretely, one more host-service label (e.g. `store` → role `storage-indexer`). The exits must grant it exactly like
     the existing derived names: `<label>-<base32(registry id)>.<zone>`, platform-policy-gated at the exit, and revoked on
     a ban.
   - Its loopback port is the replica's `appAddress`.
2. **TLS for that name, terminated ON the host** (the G3 service-tls role). It needs a certificate for the derived name
   (http-01 or dns-01 via the existing challenge path).
   - The advertised URL is https.
   - indexd's app API stays loopback HTTP behind the host's TLS front.
3. **Provider independence for G3 (post-cutover gate).**
   - At least one exit for each replica's name on a NON-DigitalOcean provider (operator opt-in, as `hostServices.exits`).
   - Otherwise the replicas are reachable only through one provider and the provider-failure gate cannot pass.
4. **One host identity.**
   - The role derives its host id as keccak256 of the slash-stripped endpoint (`hostIdOfEndpoint`).
   - The host-service names, and the privacy agent's preflight, use the endpoint EXACTLY as registered.
   - They agree whenever the registered endpoint has no trailing slash. A storage host must be registered without one (B7),
     until F's final composition settles a single rule.
5. **Same admission authority.** The role's own gate (`createHostServiceGate`) and the exits' grant both judge the
   platform host policy (bans and allowlist sticky until the admin's admit). Nothing here adds a second policy or bypasses
   either.

Storage does NOT need:
- the privacy agent to run the role;
- a hosted policy service before its own policy read: the role's gate reads the anchored policy with its own mirrors.
  F's policy carriers (0757085e) are available to it through the same gate module if F extends the role's config.
