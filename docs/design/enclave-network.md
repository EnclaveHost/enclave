# Enclave network: WireGuard app networking (replaces TUNA)

Status: in implementation (2026-10-12). This document is the specification the code is built against; each section
says what is implemented, tested and deployed in `docs/design/enclave-network-status.md`.

## Why

TUNA carries every public app's website and outbound traffic over NKN, paid in native NKN that has to be bought by
hand, from a provider market we are ~99% of. Its circuits drop every few minutes on cheap providers and DNS keeps a
dead address for up to a minute. The replacement uses WireGuard (established, audited transport; no custom
cryptography), our own qualified providers to start, explicitly opted-in Enclave hosts as further providers, and USDC
settlement through the existing connectivity contract instead of NKN.

## Network modes (per app, chosen by the owner in the app's Network tab)

| Mode | Website ingress | Outbound egress | Who sees what |
|---|---|---|---|
| `enclave-network` (default) | public 443/80 on an Enclave-network ingress provider, SNI passthrough to the enclave over WireGuard | through an Enclave-network egress provider | the guard sees the host's IP but only ciphertext; the ingress/egress provider sees visitors' and destinations' IPs, never the host's |
| `byo-wireguard` | none, or the Enclave network's ingress (separately authorized) | through the owner's own WireGuard peer | the owner's VPN vendor sees the host's IP and destination metadata; no multi-hop privacy claim |
| `direct` | the host's own public IP | the host's own connection | everyone sees the host's public IP |
| `host` | none, or the Enclave network's ingress (separately authorized) | the host's own connection (an operator opt-in; no public address needed) | destinations see the host's IP; visitors of the website still see only Enclave-network providers |

Rules that hold in every mode:

- **TLS terminates inside the enclave.** Providers forward raw TCP by SNI; they never hold a website key. Custom
  domains are routed by the same SNI table (names verified by the relay's domain map).
- **No silent switching.** A mode runs only what its policy authorizes. A failure withdraws routes and refuses egress
  (fail closed). The only fallback is one the owner wrote into the signed policy (`fallback`), and a used fallback is
  shown as such in the Network tab.
- **Authenticated policy.** The policy is a v5 document signed by the deployment owner (EOA signature, or ERC-1271
  for passkey vaults), carrying a strictly increasing `nonce`. Hosts and providers check the signature against the
  on-chain owner and keep the highest nonce seen (stale and replayed policies are refused).
- **Provider participation is a host setting, never an app setting.**

### Policy v5

```
{ version:5, deploymentId, nonce, issuedAt,
  mode: 'enclave-network' | 'byo-wireguard' | 'direct' | 'host',
  fallback: 'none' | 'enclave-network',          // byo/direct/host only; enclave-network has no fallback
  enclaveNetwork: { routes:1|2, guard:true, maxPricePerGiB6, budget6 },      // when mode or fallback uses it
  byo: { configDigest, ingress: 'none' | 'enclave-network' },                 // byo-wireguard only
  direct: { maxPricePerGiB6 },                                                // direct only
  host: { ingress: 'none' | 'enclave-network' } }                             // host only
```

Signed message: `enclave-network:policy:v5\n` + canonical JSON (sorted keys, safe integers only).
No policy on record = `enclave-network`, 2 routes, guard, `maxPricePerGiB6 0`, `budget6 0` (free providers only),
which is what every public app gets today with TUNA.

## Enclave network

### Roles

- **guard**: accepts a host's outer WireGuard tunnel and forwards only (a) UDP to qualified providers' WireGuard
  ports and (b) TCP to their control ports. It is not an exit: anything else is rejected.
- **ingress**: public TCP 443 and 80, routed by TLS SNI / HTTP Host to the peer that holds that name.
- **egress**: NAT to the internet from authorized peers, refusing private, link-local, metadata, CGNAT, own-address
  and SMTP (25) destinations with a TCP reset / ICMP administratively-prohibited (a deterministic refusal).

A circuit is host → guard → exit (ingress + egress on one provider). The inner tunnel to the exit runs *inside* the
outer tunnel to the guard (WireGuard in WireGuard): the exit sees the guard's address, never the host's; the guard
sees only ciphertext. An app keeps two circuits through distinct providers; DNS publishes both exits.

### Host side (`network/wg/`, Go: wireguard-go + its userspace netstack)

One `enclave-wg` process per circuit, run in the circuit's sandbox (AppContainer + WFP on Windows, container on
Linux). No OS interface, no routes, no admin rights: the app's traffic can only leave through the in-process
tunnel (the kill switch is structural). It exposes on loopback only:

- an authenticated SOCKS5 server (RFC 1929, random credentials) that dials through the tunnel; refused
  destinations get reply 2; names resolve through the tunnel's resolver, never the host's;
- forwards from the tunnel address :443/:80 to the circuit's ingress worker (the existing SNI gate);
- a single control forward to the exit's control port, through the guard (used to request the exit peer).

It reports `ready`, handshake age and byte counters on stdout, and `down` when the tunnel has had no handshake
for 180 s. The Node runtime (`network/wg-circuit-runtime.mjs`) keeps the circuit interface the circuit manager
already uses, so admission, route publication, ingress forwarders, shield-egress and guestd are unchanged.

### Providers (`network/wg-provider/`, Linux: kernel WireGuard + nftables + Node control daemon)

- Two interfaces: `wg-exit` (UDP 51820) for ingress/egress peers, `wg-guard` (UDP 51821) for guard peers.
- Control API on TCP 51822 (JSON over HTTP; every request and grant is signed, so plain TCP is acceptable).
- SNI/Host router on public 443/80, splicing to the peer's tunnel address.
- Peers expire (10 min) unless renewed; an expired, revoked or unqualified peer is removed (fail closed).

### Control protocol

`POST /v1/peer` with `{request, signature}`:

```
request = { version:1, providerId, role:'guard'|'exit', deploymentId, runner, wgPublicKey,
            policy:{policy, signature}|null, ingress:bool, egress:bool, issuedAt, nonce, expiresAt }
signature = runner operator, EIP-191 over 'enclave-network:peer-request:v1\n' + canonical(request)
```

The provider accepts only if: the signer is the registry operator of `runner`; the deployment is active and leased
to `runner` (two-RPC quorum, as the privacy agent reads it); for `exit`, the policy (or the default) authorizes the
Enclave network and this provider's price fits it; for `ingress`, the app is public; the request is fresh (≤ 60 s)
and its nonce unseen. The grant is signed by the provider operator:

```
grant = { version:1, providerId, role, deploymentId, clientPublicKey, providerPublicKey, endpoint,
          clientAddress:[v4/32, v6/128], names, issuedAt, expiresAt }
```

### Provider directory and opt-in

`GET /v1/network/providers` (relay) lists provider records, each signed by its operator key:

```
{ version:1, providerId, operator, address, wgExitKey, wgGuardKey, ports:{exit,guard,control},
  roles:['guard','ingress','egress'], pricePerGiB6, region, kind:'enclave'|'community', hostId|null,
  issuedAt, expiresAt }
```

Opting in is the operator signing that record (the host settings page and `enclave-wg-provider register` do this);
opting out is publishing `roles:[]` or letting it expire. Hosts verify every record and qualification themselves;
the relay only stores and serves them.

### Qualification (`network/wg-qualification.mjs`, checker: `scripts/network/wg-qualify.mjs`)

A checker key that is not the provider operator runs, through the real WireGuard data path:

| check | how |
|---|---|
| tcp80, tcp443 | public HTTP/TLS to the provider's ingress for a probe name routed to the checker's own peer |
| udpEcho | WireGuard handshake on the exit and guard ports (a handshake is a signed UDP round trip) |
| outboundHttps | HTTPS to a public site through the egress tunnel |
| payloadIntegrity | 40 MiB through ingress, sha256 compared |
| blocksPrivateDestinations | 127/8, 10/8, 172.16/12, 192.168/16, 169.254.169.254, 100.64/10, ::1, fd00::/8 through the tunnel must be *refused* (RST/ICMP), not time out |
| blocksOwnAddresses | the provider's own public address through the tunnel must be refused |
| blocksSmtp | 1.1.1.1:25 through the tunnel must be refused |
| rejectsUnauthorizedProxy | an unregistered WireGuard key gets no handshake while the registered one does (same probe, same second); the guard refuses non-provider destinations; the ingress refuses unknown SNI |

The result is signed (`enclave-network-qualification:v1`) and binds provider id, operator, address and both
WireGuard keys, valid 10 minutes. The checker re-runs continuously; hosts drop a provider (closing its circuits and
withdrawing its routes) as soon as its qualification is missing, expired, or names different keys. A signed report
does not prove a provider does not log traffic, and distinct IPs/keys do not prove distinct operators: the Network
tab says so, and says that the bootstrap providers are all operated by Enclave on DigitalOcean.

## Bring your own WireGuard

- The owner pastes a standard WireGuard config in the Network tab. Parsing is data-only: `[Interface]` PrivateKey,
  Address, DNS, MTU; one `[Peer]` with PublicKey, PresharedKey, Endpoint, AllowedIPs, PersistentKeepalive.
  `PreUp/PostUp/PreDown/PostDown`, `Table`, `SaveConfig`, `FwMark`, `ListenPort` and unknown keys are rejected.
  AllowedIPs must be full tunnel (`0.0.0.0/0` and `::/0`, or `0.0.0.0/0` alone, in which case IPv6 is refused,
  never leaked). Endpoints resolving to private/metadata addresses are refused.
- The config is stored encrypted at the relay as a reserved deployment secret (`/v1/network/byo/:id`, owner
  signature required), never in chain state, route records, provider records or logs, and released only to the
  host that currently holds the deployment's lease (runner operator signature + lease check). The policy carries
  `configDigest = sha256(salt ‖ canonical config)` with a random 32-byte salt kept inside the secret, so the
  public policy commits to the config version without exposing low-entropy fields; a host refuses a config whose
  digest does not match the current policy (stale config after replacement or rotation).
- One live peer identity per running instance: the config is released to one runner at a time and the host closes
  the tunnel when its lease ends. The tab states that a config must not be used anywhere else at the same time.
- Ingress: `none` (no public website) or `enclave-network` (website through Enclave-network ingress, separately
  authorized in the same policy and billed under its own budget). A BYO VPN is never presented as providing
  port forwarding.
- Key custody: the host runs the tunnel, so the host operator can read the BYO key. The tab discloses this and
  recommends a dedicated per-deployment peer.
- The owner pays their VPN vendor directly; Enclave charges nothing for traffic that did not use a shared exit.

## Direct hosting

A host opts in with `enclaveNetwork.direct {address, qualificationFile}`: its public IPv4 and a trusted checker's signed
qualification of exactly this runner, operator and address. The owner selects `direct` in the policy; the Network tab
states that the host's public IP is exposed to every visitor and destination. The host serves the app through the Linux
`DirectRuntime` (SNI to the enclave, TLS ends inside, policy-judged egress) and publishes a v5 `direct` route carrying the
qualification; the relay accepts it only from the network's trusted checkers, and the host withdraws it the moment the
qualification lapses. Windows hosts have no direct runtime.

## Host egress

For an app whose outbound traffic needs to be fast and close (sia-s3 talking to Sia hosts: two hops through distant
regions gave it ~0.34 MiB/s), the owner may choose `host`: its egress leaves through the host's own internet connection,
with ingress `none` or on the Enclave network exactly as for BYO. Unlike `direct` the host needs no public address and
no qualification, because nothing is served from it; but its operator must opt in, because the app's destinations see
the operator's address: `enclaveNetwork.hostEgress {apps: 'all' | [deploymentIds], own: [the host's public addresses]}`.
A host reports `host` among its modes only for the apps it offers it to, so the Network tab offers nothing else.

The host runs the app's egress entry itself (`network/host-egress.mjs`): the same loopback SOCKS5 contract as
enclave-wg's (`network/wg/socks.go`: no authentication, CONNECT only, IPv4/IPv6/name), so the Shield and guest paths
use it unchanged. Names resolve through public resolvers (1.1.1.1, 9.9.9.9), never the host's LAN resolver, and every
address is judged like `network/wg/policy.go`: loopback, private, CGNAT, link-local and metadata, multicast, reserved and
documentation ranges are refused, as are SMTP and the host's own addresses; IPv6 is refused. Admission gates every
connection, and a lapsed lease cuts the open ones. The entry is verified with the egress probe before it counts as up;
when it fails, an owner-authorized `fallback` carries egress on one egress-only Enclave-network circuit, and the website
circuits are never touched. Providers need no change of behavior: `networkUse()` reports the host mode's ingress, so they
grant ingress-only circuits and refuse egress unless the fallback is in use.

## Apps on the same host

An app that connects to the website of another app the same host serves is handed to it on the host (`network/local-app-router.mjs`),
the way that app's own ingress hands it a visitor, instead of leaving through the caller's egress and coming back through the
target's circuits. Each egress address in the egress map is published as a front with the same loopback SOCKS5 contract; a CONNECT
to port 443 whose name, or whose TLS ClientHello's server name (callers resolve names themselves and connect to an exit's shared
address), is a local app's website goes to that app; everything else is replayed to the real egress byte for byte. Only an app
with public ingress (its policy's ingress is not `none`) and a current lease and guest proof is reached locally. TLS still runs
end to end into the target enclave. Why: sia-s3 and the apps storing on it share the NucBox, and their traffic crossed two
providers each way: ~0.9 MiB/s (2026-10-15). `enclaveNetwork.localRoutes: false` turns it off on a host.

## Circuit TCP

Every circuit's TCP runs in enclave-wg's gVisor netstack. With its defaults (reno, 1 MiB buffers capped at 4 MiB) uploads over a
guard and an exit stayed at 0.23-2.2 MB/s against 7-13 MB/s lines, while downloads (sent by the far, ordinary stack) ran 3-5 MB/s.
`network/wg/tune.go` sets cubic, 4 MiB default / 32 MiB maximum buffers and receive-buffer moderation on every tunnel stack
(`TestTunedThroughput`, in-memory link: 60 ms RTT 18.7 -> 22.8 MB/s, 300 ms 3.6 -> 4.8 MB/s). gVisor has no BBR, so a long, lossy
path still limits one stream; keeping traffic between apps on one host local (above) is what removes the path entirely.

## Billing (paid providers)

- Enclave-operated providers are free (`pricePerGiB6 0`): the platform pays the four Droplets.
- A priced provider is a community provider: a registry host (record `kind: community`, `hostId`) whose operator
  signed the record. Its price lives on chain too (`EnclaveConnectivity.setHost(hostId, direct=false, tuna=true,
  price)`, which the provider keeps equal to its record's).
- The owner authorizes priced providers on chain: `authorizeTuna(id, providers[<=6], expires<=30 days, maxPricePerGiB6
  (for a whole path), budget6, owner signature)` - the Network tab's "Paid providers" (wallet: personal_sign of the
  contract's digest + the transaction; passkey vault: the relay's `network` vault op). The ledger charges bandwidth
  only from escrowed USDC (`bandwidthBackingRequired6` must be 0), so the tab then asks the owner to `fundEscrow` the
  amount the ledger names. The v5 policy's `maxPricePerGiB6`/`budget6` must also cover the provider.
- Qualification on chain: the contract counts a provider only while a quorum of the app's trusted checkers (by default
  its bootstrap checkers, the network's two) attests to the host, operator and address, for at most 5 minutes at a time.
  Checkers sign the contract's `qualificationDigest` for every community provider that passes; the attestation travels
  with the verdict on the relay and the provider (the party paid) submits it with `qualify()` while it serves.
- Admission (provider, `wg-provider/paid.mjs`): a priced provider grants a peer only while the owner's current on-chain
  authorization names it at its price with budget left, and drops the app's peers when that ends.
- Metering and settlement: the host meters each paid hop's app bytes (both directions) durably per on-chain policy
  nonce (`paid-network.mjs`) and debits through `TunaUSDCSettlement`; the provider meters the same peers from its
  kernel counters (`PeerMeter`, durable) and co-signs a cumulative receipt (`POST /v1/receipt` on its control API)
  only up to what it observed; the host submits `settleTuna`, which charges the app's balance and credits the provider
  operator its share (the rest is platform fee). A refused debit (budget spent, authorization revoked or changed)
  closes the circuit. Receipts and attestations are dated a few seconds back (blocks trail clocks).
- Hosts: Windows hosts settle with their registry proof key and operator key (`enclaveNetwork.paid`); a host whose proof
  key lives inside its CVM (metal0) cannot sign receipts and never uses priced providers.
- Activation is one-time governance: the ledger's `setBandwidthRouter(EnclaveConnectivity)` (permanent) and the address
  book's `connectivity` entry. Until then no provider can be paid and none is chosen.
- BYO: no shared-exit charge. Enclave ingress used by a BYO app is billed under the policy's `enclaveNetwork` budget.
- No NKN anywhere.

## Rollout

1. Canary: one app on the NucBox through two circuits over the four Droplets while every other app stays on TUNA.
2. Verify: custom-domain HTTPS, certificate continuity, WebSockets, streaming, sustained traffic, reconnects,
   provider revocation, DNS/IPv6 leak tests.
3. Switch all apps; keep TUNA installed and able to resume for one release; then retire TUNA.
