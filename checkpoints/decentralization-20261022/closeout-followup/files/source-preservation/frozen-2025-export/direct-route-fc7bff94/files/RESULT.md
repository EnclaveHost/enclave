# Custody v2 direct public ingress on metal0: source-only routing assessment (2026-10-23)

This is a read-only assessment, written 20:05–20:30Z. Nothing was configured, installed or tested. There was no SSH, network change,
key, environment, private config or sealed-state read. The one probe (`probe-tools.sh`, run through the queue at 256 MiB) listed
the proxy binaries on this workstation.

## Sources read (exact)

| What | Where |
|---|---|
| Corrected custodian source | `work/custody-v2-durability-20261023/repo` HEAD `ab589bf8` (= root's `a5eae96c` + 2 test files): `custody/v2/{ingress,host,host-config,http,member,process-plan,measured,build-config,workflow}.mjs`, `scripts/prepare-custodian-ingress.mjs` |
| Relay tunnel gate | the same tree's `relay/api-relay.js` (`tunnelTenantRefusal`, `CUSTODY_SURFACES`, `canonicalBoxPath`) |
| e012 measured manifest | `work/custody-v2-release-20261023/evidence/A-manifest.json`: `transport: "direct"`, `trustedProxies: null`, commit c95dcd3a |
| Latest reviewed host-services composite | `work/windows-rpc-https-compose-20261023/candidate` `aff1dafd`: `network/host-service-names.mjs`, `network/host-services/{roles,service-tls}.mjs` |
| Production metal0 network agent | `/home/steven/enclave-prod/enclave-network/relay-free-0b326889/privacy-agent.mjs` (Oct-19 bundle) |
| metal0 config metadata | `work/custody-v2-live-20261023/evidence/direct-route-inventory.json` (untracked, 19:56Z): `hostServicesPresent: false` |

## Facts that decide the route

1. **The corrected image has no route through the relay.**
   - `transport` is measured `direct` (`process-plan.mjs`): the guest runs only the custodian, with no fleet-tunnel agent.
   - The relay reaches a custodian only as a `tunnel://custody-*` fleet tunnel (`api-relay.js` `tunnelTenantRefusal`).
   - So `https://api.enclave.host/t/custody-<x>` cannot reach a direct custodian. The old custodian (tunnel, `/t/custody-metal0`)
     is unaffected.
2. **The guest port serves private routes too.**
   - `host.mjs` forwards `127.0.0.1:<mgmtPort>` to guest `:8787`.
   - That port also serves `POST /v2/custody/host-binding` (`http.mjs` L156) and `GET /health`, alongside the public API.
   - host-binding is signature-checked (`member.mjs` `setHostSig`: the registry operator must sign), but it does a chain read and a
     sealed-state commit, so it must never be public.
   - `hostPort` (state/submit) listens on host loopback only and is never forwarded.
   - **Any public path must therefore be an HTTP allowlist, never a raw TCP or TLS pipe to mgmtPort.**
3. **The public allowlist is exactly 12 method+path pairs** (`ingress.mjs`):
   - `GET /v2/custody/info`;
   - `POST` evidence, challenge, release, join, approve, independent-genesis, code-approve, owner-read/challenge, owner-read,
     shield-session/challenge and shield-session/attest.
   - The relay's own `CUSTODY_SURFACES` has only 7 of these (no owner-read, independent-genesis or shield routes). It is not
     reusable as-is for the corrected image's direct owner-read fix.
4. **Endpoint form.**
   - The guest accepts an HTTPS origin with up to 4 plain path segments (`host-config.mjs`).
   - Clients call `${endpoint}/v2/custody/...` (`member.mjs`, `rewrap.mjs`). `workflow.mjs` `custodianOrigin` accepts a path and
     refuses `.`/`..`.
   - `directCustodyIngress` and `prepare-custodian-ingress.mjs` accept an **origin only** and emit a Caddyfile.
   - The endpoint is bound on chain: `host-binding.mjs` requires the vault machine record's `endpoint` and the registry entry's
     `registryEndpoint` to match the host config exactly.
   - So the canary endpoint becomes part of the canary committee's on-chain record. Changing endpoint later means a new committee
     or machine record, not a config edit.
5. **Rate limiting.**
   - e012 has `trustedProxies: null`, so the guest rate-limits by TCP peer.
   - Behind QEMU user-net hostfwd every public client arrives from the same peer, so they share **one** bucket.
   - That is acceptable for a canary. For production it needs an image measured with `--trusted-proxy 10.0.2.2` and a forwarder
     that writes the true client into X-Forwarded-For. a5eae96c needs a rebuild anyway.
6. **metal0 has no host services and no reverse proxy.**
   - The production agent (Oct-19) has no `hostServices` (inventory), and has only per-app Enclave-network circuits into an app's
     ingress port, which need a deployment and lease.
   - No caddy, nginx, haproxy or socat is installed on this workstation. Node v22.23.3 is (`probe-tools.out`).
   - So `prepare-custodian-ingress.mjs`'s Caddyfile has no server to run in on metal0 without a new binary.
7. **Host-service roles do not cover custody yet** (aff1dafd).
   - `HOST_SERVICE_LABELS` is `dir`/`boot`/`policy` only. The opt-in names are `chal-` and `rpc-`.
   - `service-tls` `FRONTED` is those three roles plus `public-rpc`.
   - `service-tls` does a raw byte pipe to the role port after TLS, so it adds no path filtering (fact 2 rules out piping it straight
     to mgmtPort).
   - The DO fronts stay raw transport (G1/G2), which satisfies the WireGuard/transport-only constraint.
8. **The custodian is not a tenant app.** It is a host-launched SNP VM (`host.mjs`), not a leased wasm deployment.
   - Publishing it as an app (Enclave-network routes, guestd, lease) would misuse the lease path and the route-publisher's lease
     authorisation.
   - The non-bypass permanent home is a **host role**, gated by the platform host policy on metal0's registry entry, like
     `public-rpc`.

## Option A: bounded canary (root-run, temporary, NOT final or decentralized)

Purpose: exercise the SNP quote and Base lifecycle (registry entry, own canary genesis, join, release, owner-read) of a5eae96c
rebuilt, while the permanent route does not exist.

Path:

`client → https://api.enclave.host/<canary-prefix>/v2/custody/... (existing CA cert; Caddy on the control VM fronting the relay)`
`→ Caddy exact allowlist → 127.0.0.1:<R> on the control VM`
`→ ssh -N -R 127.0.0.1:<R>:127.0.0.1:<F>, opened FROM metal0`
`→ metal0 allowlist forwarder 127.0.0.1:<F> → 127.0.0.1:<mgmtPort> → guest :8787`

Guards (all required):

- **Two allowlists.**
  - Caddy on the control VM: `handle_path /<canary-prefix>/*`, the exact 12 method+path pairs, everything else 404.
  - The metal0 forwarder: the same 12. Anything on the control VM's loopback can reach `<R>`, so the metal0 side must refuse
    host-binding and `/health` itself.
- **Raw-path canonical check in the forwarder.**
  - Copy the relay's rule (`canonicalBoxPath` "unaltered"): refuse `%`, `\`, `//` and `.` segments, and require the raw path
    to equal one of the 12.
  - Why: the guest uses WHATWG `new URL(req.url)`, which resolves `/v2/custody/x/../host-binding` to host-binding.
  - Also: body caps as `http.mjs`, no request smuggling (refuse `Transfer-Encoding` together with `Content-Length`), a fixed
    upstream, and `Host`/`X-Forwarded-*` from the client never trusted.
- **Prefix choice.** The prefix must not start with `/t/`, so the relay's tunnel logic never sees it. For example
  `/custody-v2-canary/metal0` (2 segments, within the guest's 4).
- **SSH.**
  - The tunnel is opened from metal0 with a dedicated key restricted on the control VM to `permitlisten="127.0.0.1:<R>"`,
    `no-pty`, `no-agent-forwarding`, `no-X11-forwarding` and `command="/bin/false"`.
  - The `-R` bind is loopback only (`GatewayPorts no`).
  - The precedent is the existing reverse tunnel for the DNS `control` pool. There the service side (the control VM) opens `-R`
    into the public-facing side (the fronts). The canary uses the same pattern one hop inward, and still needs new authorisation
    for the key.
- **Isolation from the old custodian.**
  - A new QEMU instance with its own `stateDir`; mgmtPort and hostPort distinct from the running 9d43e63 service's.
  - Its own registry entry or registryEndpoint; its **own canary genesis and committee**.
  - Never a production policy, never copied sealed state, and the book `secretVaultV2` unchanged (no admin signature).
  - The old `custody-metal0` tunnel and the existing apps are untouched.
  - The same chip means isolation, not independence.
- **Labelling.**
  - The canary endpoint is on chain only in the canary committee and machine record. It is marked temporary, and is replaced by a
    new committee for the permanent route.
  - The single shared rate bucket (fact 5) and the SSH hop are known limits.
  - It is never described as decentralized custody or final routing.

Minimal implementation:
- **New file:** one small metal0 forwarder, e.g. `custody/v2/ingress-forward.mjs`. Node, about 80 lines, with a unit test of the
  12 allowed pairs, host-binding and `/health` refused, and the traversal/encoding cases.
- **Config only:** one Caddy `handle_path` block on the control VM, and the SSH key line.
- No image change and no relay code change.
- `prepare-custodian-ingress.mjs` stays as it is (origin-only). The canary Caddy block is hand-written and reviewed, because it
  has a path prefix.

## Option B: permanent host-role route (no hosted logic on DO)

Name:
- `cust-<base32(metal0 host registry id)>.app.enclave.host`. The label is 57 characters (≤ 63), the same shape as `chal-`/`rpc-`.
- It is opt-in on both sides and NOT in the fixed three-name grant.
- The custodian endpoint becomes that origin. It passes `directCustodyIngress` and `custodianOrigin`, and has no path.

Changes needed (on the aff1dafd lineage, or its successor composite):

1. **`network/host-service-names.mjs`:** `HOST_CUSTODY_LABEL='cust'`, `HOST_CUSTODY_ROLE='custody-ingress'` and
   `hostCustodyName`/`hostCustodyOrigin`. Add them to the service-shape predicate (as `rpc`).
2. **`network/host-services/roles.mjs`:** a role `custody-ingress`, `kind: null`.
   - Config `{port, bind: loopback, upstream: <mgmtPort>}`, validated loopback only, with no secret fields (`SECRETISH`).
   - Its entry is the forwarder from Option A, the same file, so the canary tests it first.
3. **`network/host-services/service-tls.mjs`:** add `custody-ingress` to `FRONTED`, fronted only with an explicit
   `tlsPorts['custody-ingress']` (as `public-rpc`).
   - The certificate SAN set changes, so this is a new order under the LE budget.
   - The host does the TLS. The protocol carries quotes and HPKE ciphertext, so the TLS terminator is untrusted for secrecy by
     design (`ingress.mjs` header).
4. **Runner and stage-tool bundles** rebuilt; new pins. **route-dns appStatic / exit list:** the new name, as `rpc-`.
5. **WireGuard provider grant opt-in** (`wg-provider/provider.mjs`, `hostServices.custody`) on the DO fronts. This is transport
   only: G1 raw packets, G2 DNAT. There is no HTTP or TLS on DO.
6. **metal0 enablement:**
   - a host-services-capable agent on metal0, i.e. the Linux side of host-services Phase B, which is NOT READY (B1–B10 in
     host-services-final-compose RESULT);
   - `enclaveNetwork.hostServices` in metal0's config (operator allowlist in install.sh);
   - and the platform host policy ON for metal0's registry entry.
7. **Optional, recommended:**
   - rebuild the custodian with `--trusted-proxy 10.0.2.2`, and have the forwarder set X-Forwarded-For from the TLS peer. That
     gives per-client rate buckets; it needs a new measurement, which a5eae96c needs anyway.
   - Check whether G2 DNAT keeps the client source address; if it does not, per-client limits need the provider side.
8. **Activation:** a NEW committee or machine record with endpoint `https://cust-<b32>.app.enclave.host`. Then the book update
   (admin signature) and owner moves, per the audit's P2/P3.

**What remains true even with B:** one metal0 seat behind DO transport is still a single operator and one failure domain.
Decentralization needs distinct operators and hosts, each running this role.

## What I recommend root does

1. **Keep Option A strictly a canary.** Review and land the forwarder, plus its test, in the durability tree, through the queue.
2. **Build:** rebuild a5eae96c's image (optionally with `--trusted-proxy 10.0.2.2`). Then a quote-only check, as e012.
3. **Launch the canary:** a separate QEMU instance, ports and stateDir; a registry entry; its own genesis.
4. **Open the canary path:** the SSH `-R` with a restricted key, and the control-VM Caddy block. Then a negative test:
   host-binding, `/health`, `..`, `%2e`, `\` and double-slash variants must all give 404 at both layers.
5. **Run the lifecycle tests.** Record everything as a canary.
6. **In parallel:** implement Option B items 1–5 as a reviewed composite on the host-services line. It is blocked on Phase B for
   Linux (item 6).
7. **Retire** the canary committee and the SSH path after B is live. The old custodian stays until the owner moves are complete.

## Open questions for root

- Is metal0 the local workstation? The production config path and the custodian user service are local, and the probe ran here.
- Where exactly does the control-VM Caddy live (minipc/enclave-control, per the audit), and may it carry a non-relay path?
- Should the canary committee live in production vault 0xE486 (a new committee there is visible to readers but unused by
  policies), or in a canary vault?
