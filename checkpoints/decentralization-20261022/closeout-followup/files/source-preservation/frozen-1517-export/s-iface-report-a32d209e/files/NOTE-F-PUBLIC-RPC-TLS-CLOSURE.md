# Public HTTPS for `rpc-<b32>.<zone>`: the TLS closure F needs (from S, 2026-10-23)

**Status: NOT integrated, NOT tested over HTTPS.** No packaged HTTPS test of the RPC name has run. The browser and
consumer fixtures in S's trees are plain HTTP on loopback. They prove the role, not production HTTPS readiness.

S read the G3 package as a dependency and edited nothing of it: `work/host-service-tls-20261021/g3-final-package`
(`FINAL-PACKAGE-RESULT.txt`, `SHA256SUMS.txt` `48d9f541…`). In that package:
- `network/host-services/service-tls.mjs` is `0aac3061…`;
- `network/host-service-names.mjs` is `08bda1e6…`;
- `network/host-service-ingress.mjs` is `5465684f…`.

## Where TLS is terminated

The G3 terminator is the **`service-tls` host-services role**, a child of the hs2 runner.
- **Ingress (not the terminator).** The ingress worker does not terminate TLS ("no TLS termination, no rewrite"). It
  routes raw `:443` by SNI to `127.0.0.1:tlsPorts[role]`, and `:80` by Host to `httpPort`.
- **service-tls.** It holds the host's one certificate, as one atomic key+chain document `keys/current.pem`. It
  terminates TLS and pipes plain bytes to `127.0.0.1:upstreams[role]`.
- **The backend role.** It holds no certificate. For `public-rpc`, `upstreams['public-rpc']` is the role's own `config.port`.

## What does NOT cover `rpc` today (exact lines in the G3 tree)

1. **`service-tls.mjs` L52** reads `const FRONTED = Object.keys(HOST_SERVICE_ROLES);`, which gives only
   directory/bootstrap/policy. L76 then refuses `tlsPorts: "public-rpc" has no derived service name`.
2. **`service-tls.mjs` L332-333** reads `all = hostServiceNames(c.hostId, c.zone); certNames = tlsRoles.map((r) =>
   all[r])`. `hostServiceNames` returns only the three fixed labels. The `rpc` name comes from `hostRpcName()`, which is in
   S's `host-service-names.mjs` (F lineage `14d1e495` + S `36919aaf`), not in G3's `08bda1e6`.
3. **The G3 tree pins its names module (`08bda1e6`).** F's lineage has S's names module with `HOST_RPC_LABEL`,
   `hostRpcName` and `rpc` in `isHostServiceName`. Composing G3 on F means re-pinning to F's names module. Keep
   `hostServiceNames()` unchanged: the RPC name is conditional, so it must never join the fixed three for every host.

## The closure, as a minimal diff for F to compose (S has not applied it)

- **The fronted set.** In `service-tls.mjs`, the fronted roles become
  `[...Object.keys(HOST_SERVICE_ROLES), HOST_RPC_ROLE]`, and the name map becomes
  `{ ...hostServiceNames(hostId, zone), [HOST_RPC_ROLE]: hostRpcName(hostId, zone) }`. That map is used for both
  `certNames` and `routes`. The `rpc` name enters the SAN only when the operator lists `public-rpc` in `tlsPorts`.
- **Runner agreement.** `tlsPorts['public-rpc']` must be refused unless the same hs2 config runs a `public-rpc` service.
  Its `upstreams['public-rpc']` must equal that service's `config.port`. That is the same rule as the existing roles.
- **Agent.** `hostServices.tls = { httpPort, tlsPorts }` gains the `public-rpc` port. The privacy agent requests the
  `rpc` grant only with that port (S's transport change). The exit grants it only with `hostServices.rpc: true`
  (S's provider change).
- **Ingress.** No change on F's lineage: S's `isHostServiceName` already accepts `rpc-<b32>.<zone>`.
- **CN and SAN.** `rpc-<b32>.<zone>` has the same length class as the other derived names (73-76 bytes), so it goes in
  the SAN only. The subject stays empty, because the CN rule takes the first name of 64 bytes or fewer, which is none.
- **SAN-change hazard.** Adding `public-rpc` to `tlsPorts` changes the host's exact SAN set, and a new order follows.
  - The local budget is 2 per 7 days.
  - Decide `rpc` inclusion BEFORE the first approved issuance (G3 APPROVE upgrade `47f3e1f5 → 84e5120d`, not built).
    Then one order covers all four names.
  - Adding it after approval costs one re-issue, and the same-set renewal exemption no longer applies.
- **CORS.** `allowedOrigins` must be the `https://` dashboard origins. The role never sends credentials.
- **Tests F needs before any HTTPS claim.**
  - A packaged `service-tls` + `public-rpc` run under the runner with a local ACME test CA (as G3's own tests do).
  - A TLS client checks that SNI `rpc-<b32>.<zone>` reaches the role.
  - The certificate's SAN contains exactly the configured names.
  - A name for a role without a port gets no certificate entry and is refused at SNI.
  - None of this has run.

## Remaining production gates (unchanged, root-owned)

- G3 P2/P3: agent restarts carrying `enclaveNetwork.hostServices`.
- G1 HTTP canary.
- DNS publication of the derived names (including `rpc-…`) through the delegated authority.
- READY evidence through every exit.
- APPROVE config.
- Exits opted in with `hostServices.rpc`.
- An activated platform host policy.
