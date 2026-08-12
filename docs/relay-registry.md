# Relays — one registry, and a box that carries traffic without running it

Status: **registry schema 5 written and tested, INERT.** The live
`EnclaveRegistry` is still schema 4; nothing changes until it is redeployed,
migrated and repointed in the address book. No consumer reads `caps` yet.

There is no separate relay contract. There was one for about an hour
(`EnclaveRelayRegistry`, since deleted) and it was the wrong shape: it forced a
box that both hosts and relays into two rows with two operators-of-record, and
it duplicated `lastSeen`/`active`/heartbeat/deregister and the fail-closed
`trustedOperators` machinery that `fleet.mjs` already applies to one registry.

## The decision

A registered box is no longer assumed to run code. `caps` says what it does:

| bit | meaning |
|---|---|
| `CAP_HOST` | runs tenant code — the thing `measurement` and the prices are about |
| `CAP_APP_SNI` | carries app-zone traffic (SNI passthrough on the 443 data path) |
| `CAP_TCP_PORTS` / `CAP_UDP` | carries declared raw ports |
| `CAP_TUNNEL_HUB` | accepts reverse tunnels from boxes with no inbound |

**A relay does not need a TEE.** Not as a compromise — as a consequence. A relay
terminates nothing and holds no key: it buffers a ClientHello, reads the SNI,
and splices ciphertext to the enclave holding the lease, where the browser's TLS
actually ends against a certificate whose private half never left the CVM. It is
never handed anything to betray. Demanding attestation of relays would shrink the
relay set and buy no privacy.

What a relay unavoidably sees is the pair **(client address, SNI)** — who you
talk to, never what you say. So a relay that *is* measured is strictly better,
and the schema lets it say so: it registers both ways and carries a real
`measurement` alongside its relay bits. Routers may prefer those. Nothing
requires them, and that is the point — relays want to be *everywhere and cheap*,
hosts want to be *where the trusted silicon is*, and tying the two together
would price edge presence at the cost of a TEE.

## Mechanics worth knowing

- `registerRelay(endpoint, region, caps)` — no price, no measurement, no proof
  key. `register()` is unchanged and still demands a price, because a box that
  sells compute must say what it costs.
- **Both calls OR their bits in.** `register()` sets `CAP_HOST` without clearing
  relay bits; `registerRelay()` does the reverse. A box that does both runs
  `register()` on every boot and must not lose its relay role to boot order.
- `setCaps(id, caps, region)` assigns **absolutely** — giving a role up is a
  deliberate act, never a side effect. It refuses `0`.
- `registerRelay` cannot mint `CAP_HOST`; only `register()` grants it, so no box
  can pose as an enclave without going through the path that demands a price.
- **`caps == 0` MUST read as `CAP_HOST`.** Every pre-schema-5 row has `caps == 0`
  and every one of them runs code. A consumer that reads 0 as "no capabilities"
  empties the fleet the moment this deploys. The contract holds up its half:
  `register()` never leaves caps at 0.
- **Appending is safe.** `EnclaveDeployments` reads this registry through an
  11-field `IEnclaveRegistry.Enclave` and the whole self-hosting suite passes
  against a 13-field registry — the earlier fields stay exactly where a stale
  decoder expects them. Off-chain readers still sniff `registrySchema` first
  (`fleet.mjs`), which is what makes the tail safe to grow.

## Bonding: nothing new was needed

`EnclaveDeployments.postBond` is keyed by `msg.sender` and is **not** host-gated,
so it is already a general per-operator stake with a timelocked exit and
owner-gated `slashBond` carrying public evidence. A relay-only operator can post
one and a router can filter on it. Adding bond custody to the registry would
have duplicated that, and the ledger has 121 bytes of EIP-170 headroom left, so
this is the only place it can live anyway.

Worth restating what slashing is: a censoring relay and an unreachable relay
produce identical silence, and a metadata harvester produces no evidence at all.
Slashing **prices** misbehavior; it cannot detect it. Read the events as
testimony.

## Choosing a relay: what shipped

The registry schema above is still inert, and the feature did not wait for it.
Which box relays is read from its **`/availability`**, not from `caps` — a box
declares a `relay:` block naming the services it carries and the address it
answers on, and a box with no resources at all is the one the console badges as
a relay. That needed no contract and no migration, which is why it is live and
`caps` is not.

The choice is **per deployment, and explicit**. Not a fleet-wide cutover (one
DNS edit moves everyone, including apps that were fine), and not
nearest-to-the-lease-holder (a lease moves; an owner's users do not). The owner
names a relay in the options envelope:

```json
{"network": {"relay": "us-west"}}
```

Three parts carry it, and each has one job:

- **`supervisor.js`** validates the namespace and otherwise ignores it. Nothing
  in a CVM acts on the choice. It is validated anyway, and *refused* rather than
  dropped, because the envelope is fail-closed: an owner who typos a relay name
  must be told, not quietly left on the default. That refusal is also why
  `networkOptions` is a fleet-AND flag — an envelope carrying `network` lands
  unclaimable on a runner that predates it, so the console hides the tab until
  every live runner reports true.
- **`api-relay.js`** (`GET /v1/relays`) answers both halves of the question at
  once: the roster a picker can offer, and `labels` — the choices already made,
  resolved to addresses. One endpoint on purpose, because a name the picker
  offers that the zone cannot resolve is a trap. Two relays answering to one
  name are **both** dropped, the same rule zone 1 applies to an ambiguous id
  prefix.
- **`dns-relay.js`** polls that map (`RELAY_MAP_URL`) and answers
  `<label>.app.enclave.host` with the chosen address instead of the wildcard.

Two rules in there are load-bearing:

**Reachability outranks the preference.** A choice naming a relay that has left
the fleet, or one that does not splice SNI, resolves to the zone default. The
alternative — honouring the record exactly — points a live app at a box that
cannot serve it, which is not a stricter reading of the owner's wishes, it is an
outage.

**A chosen relay answers only from its own addresses.** If it declares no IPv6,
`AAAA` is empty for that name rather than the zone-wide one. Falling back per
family would send v6-preferring clients to the *default* relay while v4 clients
used the chosen one: not a fallback, a silent half-undo, and near-invisible from
outside.

`RELAY_MAP_URL` unset = the app zone is the pure wildcard it always was.

## Three decisions still open

**1. Browsers can only be steered by DNS.** A native client can read the registry
and choose a relay; a browser resolves a name and takes what it is handed. So for
web traffic the naming layer stays centralized however decentralized the relay
set becomes. On-chain discovery makes DNS *derived* rather than *decreed* — a
real improvement — but it is transport decentralization, not naming
decentralization, and closing the gap properly needs client-side attestation
pinning.

**2. Payment is unbuilt, deliberately.** Bandwidth cannot be metered trustlessly
and a relay proving its own work is unsolvable. The tractable shape is
**host-signed receipts** — the enclave already signs proof-of-time checkpoints,
so it can attest "relay R carried my traffic across this window" — with the
operator bond making collusion expensive rather than impossible. Its own
contract, against a settled receipt format.

**3. Cheap relays are a metadata harvest.** Anyone can run fifty and rebuild the
fleet's IP↔app graph. Preferring measured relays helps. So does the note below.

## Two things that must land in the right order

**The forwarded-client-IP fix comes AFTER this.** `relay.js` sends no
`x-forwarded-for` on its WS upgrade, so `clientIpOf` falls through to the relay's
own address and **every client currently shares one WAF per-IP bucket** on the
app-zone path. One line to fix — but a forwarded IP is only worth believing from
a box you have a reason to trust, and a permissionless relay that forges the
header can poison buckets or frame an address. Believe it only from an active,
registered, sufficiently-bonded relay.

**A host relaying for a competitor sees that competitor's tenant metadata**
unless the relay path is inside the measured image. If hosts relay, it should be
the supervisor doing it, not a sidecar the operator can attach to.

## Rollout order

Done, in this order:

1. ~~A second relay somewhere useful.~~ `us-west` (5.78.85.108, 15 ms from
   kryptos vs 171 ms from Finland) attaches over the fleet tunnel by **on-chain
   operator signature** — it signs the hub's challenge with the key that
   registered its endpoint. Adding or removing a relay is a registry
   transaction, not a commit.
2. ~~Zone 2 per-deployment instead of one wildcard.~~ See above. **This is where
   the ~175 ms in `inbound-latency-handoff.md` dies** — measured 355 → 76 ms
   warm, 1.43 → 0.22 s fresh TTFB, for a deployment that chooses it.

Still to do:

3. Set `RELAY_MAP_URL` in `/etc/nan-relay/dns.env` on nan-relay. Until then the
   app zone answers the wildcard for everyone and the tab writes records nothing
   reads.
4. Redeploy `EnclaveRegistry` at schema 5, migrate the live rows, flip the
   address book key — and land it **with** the next `EnclaveDeployments`
   redeploy, since the ledger's `registry` pointer is `immutable` with no
   setter and sits on the money path.
5. Teach `fleet.mjs` to read `caps`, **fail-closed** exactly as enclave discovery
   already is — and to read `0` as `CAP_HOST`.
6. Then the XFF fix.

One constraint worth keeping in view: on Tinfoil hosting a relay cannot be an
existing host, because the shim is path-based HTTPS and raw TCP only ever
arrives as WebSocket upgrades over `/x/*`, which a browser does not speak.
Host-as-relay is real on metal-style self-hosted boxes with public inbound —
`/v1/relays` already offers those (membership is "declares an address it relays
on", not the relay badge), which is where `metal/PROTOCOL.md` was heading.

For a host that *can* take inbound, note the better outcome: it does not need a
relay at all. Point `<label>.app.enclave.host` at it and it terminates its own
app TLS in-CVM with the certificate it already mints. The relay role then only
matters for traffic that is not its own — chiefly `CAP_TUNNEL_HUB`, fronting the
CGNAT sellers who have no other way onto the network.
