# Relay registry — decentralizing the boxes that carry traffic

Status: **contract written, tested, INERT.** Nothing is deployed, the address
book has no `relayRegistry` key, and every consumer still reads the single
static relay the app zone points at. This note is the argument behind
`contracts/EnclaveRelayRegistry.sol` and the three decisions still open.

## Two registries, because there are two jobs

`EnclaveRegistry` answers *who will run my code, and what code do they claim to
run*. That is a question about **confidentiality**, which is why every answer is
checked against a live attestation and why an enclave without one is worthless.

`EnclaveRelayRegistry` answers *who will carry my bytes, and from where*. That is
a question about **availability and metadata**. Different question, different
guarantees, different contract.

## Why a relay does not have to be a TEE

A relay terminates nothing and holds no key. It buffers a ClientHello, reads the
SNI, and splices ciphertext to the enclave holding the lease; the browser's TLS
terminates *inside* that enclave against a certificate whose private half never
left it. A relay therefore cannot read a request, forge a response, or
impersonate an app — not because it is trusted, but because it is never handed
anything to betray.

This is worth stating precisely because the obvious analogy is wrong in a
useful direction. **A Tor exit node sees plaintext; that is what makes the exit
the dangerous seat.** Our relay never does. The closer analogy is a Tor *guard*,
or a CDN doing SNI passthrough. Requiring attestation of relays would shrink the
relay set and make the traffic no more private.

## What a relay does learn — the actual threat model

- **The pair (client address, SNI).** It cannot read what you say, but it knows
  who you are talking to. Today the relay is the *only* party holding that pair:
  `relay.js` appends no `x-forwarded-for` to its WS upgrade, so `clientIpOf`
  (`supervisor.js`) falls through to `remoteAddress` — the relay's own address —
  and the enclave never sees the client at all.
- **Refusal.** Dropping a chosen SNI is censorship no cryptography prevents. The
  answer is plurality: many relays, enumerable by anyone from any RPC, so a
  refused client has somewhere else to go. On-chain discovery is the point — a
  relay set curated by one operator can be shrunk by that operator.
- **Blackholing**, which is indistinguishable from being slow. Hence the bond.

So the contract is built around metadata and availability. `repo`/`measurement`
are recorded but **optional**: a relay may run measured code and say so, and a
router may prefer those. Attestation is a quality signal, not an entry gate.

## What is in the contract

Mirrors `EnclaveRegistry` deliberately — same id-is-the-endpoint rule, same
open registration, same advisory `lastSeen`, same paging, same schema sniff
(`relayRegistrySchema = 1`).

- `region` — free-form routing hint. This is the latency lever: a relay is only
  worth using if it is near the enclave it fronts. Free-form because the useful
  granularity is "near which enclaves", which no enum survives; a wrong value
  costs the operator traffic, which is the right incentive.
- `caps` — `CAP_APP_SNI`, `CAP_TCP_PORTS`, `CAP_UDP`, `CAP_TUNNEL_HUB`. The last
  one matters: a CGNAT seller's only way onto the network is a relay willing to
  hub its reverse tunnel.
- **Bond** — `postBond` / `requestBondExit` / `withdrawBond` / `slashBond`, in
  USDC, shaped exactly like the ledger's claim bond. Not an entry gate: a bar
  consumers filter on via `meetsBond`. A bond in exit stops meeting the bar
  *immediately*, so a relay that is leaving stops attracting traffic before its
  money is gone.
- **Slashing is governance, not proof.** None of the misbehavior above is
  provable on-chain — a censoring relay and an unreachable relay produce the
  same silence, and a metadata harvester produces no evidence at all. `slashBond`
  is owner-gated, carries public evidence in its reason string, and is bounded
  by the bond. It *prices* misbehavior; it does not detect it. Read slash events
  as testimony.

## Three decisions still open

**1. Browsers can only be steered by DNS.** A native client can read this
registry and choose a relay. A browser resolves a name and takes what it is
handed. So for web traffic the naming layer stays centralized no matter how
decentralized the relay set becomes. An on-chain registry makes DNS *derived*
rather than *decreed* — a real improvement — but it is transport
decentralization, not naming decentralization, and the difference should not be
oversold. Closing it properly needs client-side attestation pinning.

**2. Payment is unbuilt, and that is honest.** Bandwidth cannot be metered
trustlessly, and a relay proving its own work is unsolvable. The tractable shape
is **host-signed receipts**: the enclave is already an attesting party that
already signs proof-of-time checkpoints, so it can attest "relay R carried my
traffic across this window", with the bond making host/relay collusion expensive
rather than impossible. That belongs in its own contract against a settled
receipt format. A registry that only does discovery, bonding and reputation is
useful without it.

**3. Cheap relays are a metadata harvest.** Anyone can run fifty and rebuild the
fleet's IP↔app graph. Preferring attested relays helps; so does not handing them
the correlation in the first place.

## The forwarded-client-IP problem, which is coupled to this

Because `relay.js` sends no `x-forwarded-for`, the WAF's per-IP buckets on the
app-zone path key on the relay's address — **every client currently shares one
bucket**. It is a one-line fix, but it must not land before this registry does:
a forwarded client IP is only worth believing from a relay you have a reason to
trust, and a permissionless relay that can forge the header can poison buckets
or frame an address. Fix it *with* the registry's trust model — believe the
header only from an active, registered, bonded relay — not ahead of it.

## Rollout order, when you want it

1. Deploy `EnclaveRelayRegistry` (console deploys it from the generated
   artifacts; it is in the `DEFS` list already), add a `relayRegistry` key to
   the address book.
2. Teach `fleet.mjs` to read it, **fail-closed** exactly as enclave discovery
   does — an unset or empty allowlist must fall back to the baked canonical set,
   never to "follow everyone".
3. Register the existing relay. Nothing changes yet; it is now discoverable
   rather than assumed.
4. Make zone 2 of the dns-relay ownership-aware, answering with the nearest
   registered relay that carries `CAP_APP_SNI` for the enclave holding the
   lease. This is where the ~175 ms in `docs/inbound-latency-handoff.md` dies.
5. Then, and only then, the XFF fix above.

Steps 1-3 change no traffic. Step 4 is the one that needs a second relay to
exist somewhere useful.
