# Host liveness is off-chain

Hosts do **not** send a periodic on-chain heartbeat. The registry (`EnclaveRegistry`, deployed schema 4, unchanged)
holds identity, admission and configuration, and it is written when they **change**:

- `register` at boot. A CVM's proof key is new on every boot.
- `setPrices`, `setProofKey` or `setMeasurement` on an actual mismatch.
- `deregister` by the operator.

Whether a host is **up** is decided off-chain, from authenticated, bounded-fresh evidence.

The rule is `network/host-liveness.mjs` `hostLiveness`. The relay uses a byte-identical copy,
`relay/host-liveness.mjs`.

## Admission comes first; liveness never relaxes it

1. **Admission** (may the host be listed at all):
   - a registered row, `active`;
   - wherever the reader has one, its platform filters: the relay's `TRUSTED_OPERATORS` allowlist, https and a public
     address.
   Moderation, operator binding and the registry's authority are unchanged.
2. **Liveness** (is the admitted host up now). Exactly one of:

| evidence | what it is | how fresh |
|---|---|---|
| `signed-record` | the host's operator-signed capacity record from `<registered endpoint>/v1/host/capacity` (`network/host-capacity*.mjs`), verified by the reader against the row it read: signer = the row's operator, exact endpoint and hostId, chain, registry, row active | unexpired: a record lives at most 15 minutes (default 5, re-signed at half life) |
| `observed` | the reader's own authenticated observation: the relay's attached tunnel (`relay/tunnel.js`) | the observer's window |
| `registry-update` | an on-chain write by the row's operator key (`register`, `setPrices`, `setProofKey`, `setMeasurement`, or a legacy `heartbeat`): `lastSeen` moves only through the operator's own transaction | within the reader's window (default 3600 s; `0` turns it off) |

No evidence, expired evidence, a forged, foreign, moved-operator, replayed or equivocating record, or an inactive or
unregistered row: **not live**, with the reason. A signed old record is never current evidence.

- A copy of a record held by a directory or cache dies when the record expires.
- The relay holds a record only for one binding (chain, the CURRENT registry, the row's operator). An address-book
  repoint, a new operator or another chain drops it at once.
- An equivocating host (two different records with one sequence) loses its signed evidence, the earlier record
  included, until it signs a strictly newer one. Its operator's own registry write within the window is separate,
  chain-authenticated evidence and still counts.
- A reader that caps how many hosts it asks (the CLI's `signedLiveness`, 256 by default) reports the rest as
  **not checked** (`unchecked`, `livenessComplete: false`, an INCOMPLETE note on `hosts` / `pricing` and the quote),
  never as down.
- Readers that keep floors (the relay, the capacity reader with `--capacity-state`) refuse an older sequence than one
  they have seen.

## What a host writes, and when (both platforms, one rule)

`network/registry-reconcile.mjs` is imported by `supervisor.js` and `windows/node/host.mjs` alike (the measured image and
the Windows deploy closure ship it):

| phase | may register() | may correct price / proof key |
|---|---|---|
| `boot` (process start; a CVM proof key is new) | yes: initial registration, or re-registering its own row (even an inactive one) | active own row only |
| `explicit` (an address-book registry migration, an owner's deliberate re-enable) | yes, as at boot | active own row only |
| `timer` (every routine pass) | only an initial registration (no row yet), an unpriced own row, or a stale proof key on an ACTIVE own row | active own row only |

- A routine pass never re-activates a row its operator deregistered. Both platforms read the row on their routine pass
  (Linux 15 min, Windows 10 min) and report the change.
- After observing a deregistration, both stop signing capacity records.
- A row registered to another operator is never written.

## Who does what

| component | change |
|---|---|
| `supervisor.js` | The `heartbeat` transaction is gone. The timer (`REGISTRY_RECONCILE_SEC`; `REGISTRY_HEARTBEAT_SEC` still sets the cadence) only reads and reconciles: repoint, price, proof key, payout view, active state. Each is a transaction only on a mismatch. A deregistered row is reported, not re-activated. Liveness: the signed record at `/v1/host/capacity` (host-capacity integration). |
| `windows/node/host.mjs`, `chain.mjs` | No `heartbeatBox` for any endpoint. The 10-minute timer re-reads the row (quietly; it logs an active/inactive change) and the gas runway: no transaction. `ensureRegistered` follows the shared rule: `boot` at start-up, `explicit` after an address-book registry move, `timer` on every tick. `ensurePriced` re-prices only an active own row. Liveness: a tunnelled box's tunnel attach, a dialed box's signed record. |
| `relay/api-relay.js` | Admits `active` rows (no `lastSeen` filter). A direct row is listed only while it answers `/availability` AND `relay/registry-liveness.mjs` finds evidence. Its published `lastSeen` is the newest authenticated time; the raw value is `registryLastSeen`; `liveness` names the evidence. |
| `relay/fleet.mjs` (dns-relay) | The operator-of-endpoint (dns-01 own name) and lease-endpoint maps are authority: built from `active` rows, never from `lastSeen`. Routing liveness stays the api-relay's `/enclaves` verdict (eligibility). |
| `network/host-capacity-http.mjs` | `--cold` reads every active host (bounded by `--max-hosts`, overflow reported). Each host carries `liveness`. |
| `cli/independent.mjs`, `cli/enclave.mjs` | `admittedHosts` = active and priced. `liveHosts` requires evidence. `signedLiveness` fetches each admitted host's record and verifies it against that host's row in the SAME agreed snapshot of the registry the command was told to use. With `--contract-pins` alone it claims no reviewed code hash; `--profile` adds its code pin through `assertReviewedCode`. Displays say "registry write", not "heartbeat". |
| `network/host-capacity-producer.mjs` | The record (and its refusal) carries `access-control-allow-origin: *`: public, signed, credential-free, readable by a browser on any origin. |
| `relay/api-relay.js` own surfaces | `/v1/host/capacity` is one of a tunnelled box's own public surfaces: GET, HEAD and OPTIONS reach even an ineligible (hv-node) box, with the caller's credentials stripped. A tunnelled host's record is therefore reachable at `<relay>/t/<name>/v1/host/capacity`. |
| `scripts/enclave-discover.mjs` | Admits active rows. A host is picked only if its record verifies (Node) or its registry write is recent. |

## Situations

- **Restart or reboot.**
  - A supervisor re-registers at boot: the CVM proof key is new, so that is a real change. That write keeps the host
    live for the window until its first record is read.
  - A Windows node writes only if its row differs.
  - Records resume as soon as the host is registered again; the producer refuses to sign before that.
- **Expired records.** The host drops out of every reader within at most 15 minutes of its last signature, unless its
  operator wrote the registry within the window.
- **Unavailable providers.**
  - Directories are optional: a reader asks the host itself, and a dead directory is reported, not fatal.
  - An RPC quorum that does not agree throws: nothing is verified, nothing is live.
  - The relay being down does not affect decentralized readers.
- **Inactive rows.** Never admitted, whatever they serve. The supervisor no longer re-activates its row on a timer:
  the operator's deregistration stands until the host is registered again.
- **Direct and tunnel hosts.** Neither sends a heartbeat. Tunnel liveness is the authenticated attach; direct liveness
  is the signed record.

## Compatibility boundary: an explicit version transition

The deployed registry and its `lastSeen` field do not change; only who writes it does. A client that judges liveness
**only** by `lastSeen` drops a healthy host one window after that host's last registry write.

| reader | status |
|---|---|
| relay api-relay / dns-relay (production) | updated here; must be deployed **before** hosts stop heartbeating |
| site pricing (`site/js/core/pricing.js`, `HOST_STALE_AFTER_SEC` on relay rows) | keeps working with no change, because the updated relay publishes an authenticated `lastSeen` |
| site independent mode (`site/js/core/independent-chain.js`, `HOST_LIVE_SECONDS` on chain rows) | not in this patch. The browser liveness candidate (`work/browser-offchain-liveness`, another worker) applies this rule there; until it lands, the browser drops a non-heartbeating direct host after an hour |
| released CLIs (`cli/dist/enclave.mjs` and installed copies), older `enclave-discover` copies | drop such hosts after an hour until upgraded |
| third parties following the contract comment ("readers treat lastSeen older than a window as down") | same, by construction |

Rollout order:

1. Readers first: relay, CLI release, browser.
2. Hosts serve signed records: the host-capacity producer integration, and a measured image rebuild for the
   supervisor.
3. Hosts stop heartbeating (this change).

Hosts still on an older version keep heartbeating, and that write is still accepted as `registry-update` evidence, so
mixed fleets work throughout.
