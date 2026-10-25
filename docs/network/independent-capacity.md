# Independent host capacity

`enclave availability` normally asks the Enclave relay, which polls every host's `/availability`. Independent mode
cannot use the relay. Free capacity is a fact about a host, not something on chain, so the replacement is each host's
**own signed capacity record**. Readers verify those records against the reviewed registry themselves.

## What a record proves, and what it does not

- **Who reported the numbers.** The record is signed by the operator key that the pinned registry names, at one
  agreed RPC-quorum block, as the **active** operator of this exact registered endpoint.
- **Not that the hardware exists, is free, or is reserved for you.** A host can overstate. Hardware is proven at claim
  and connect time (attestation), and a claim can still fail. Every figure is marked `selfReported: true`.
- **Never a price.** Registry prices (`cpuPricePerSec6`, `gpuPricePerSec6`) are shown beside the record as registry
  facts (`postedPricesAreNotCapacity: true`). A host can post a price and have nothing free.

## The record (v1)

```
envelope = { record, signature }
record   = { version: 1, kind: "enclave-host-capacity", chainId, registry, hostId, endpoint, operator,
             sequence, issuedAt, expiresAt, availabilityJson }
signature = EIP-191 personal_sign by `operator` over
            "enclave-network:host-capacity:v1\n" + canonical(record)          (network/canonical.mjs)
```

- **Binding.** `chainId`, `registry` (lowercase), `hostId = keccak256(endpoint)` and the exact registered `endpoint`
  are all inside the signed bytes, behind a domain-separation prefix. A Windows node's `https://<relay>/t/<name>`
  endpoint, which has a path, is accepted. Credentials, queries and fragments are not.
- **Lifetime.**
  - `expiresAt − issuedAt` is at most 15 minutes; hosts sign for 5 minutes and re-sign at half-life.
  - A record issued more than 60 s in the future is refused.
  - `1 ≤ sequence ≤ issuedAt`.
  - The document's own `updatedAt` must fall within the record's lifetime, so a stale document cannot be re-signed
    as fresh.
- **The document.** `availabilityJson` is the host's `/availability` object as its exact JSON text. It is full of
  fractions, which the canonical encoding does not admit, and readers parse exactly the bytes that were signed.
  - **Bounds:** at most 32 KiB, depth 8, 256 keys per object, 256 array items, 4096-character strings. Every number
    is finite with |n| ≤ 2^53−1. Keys are printable ASCII and `__proto__`/`constructor`/`prototype` are refused.
  - **Typed fields:** only the fields a reader decides on.
    - Shares are in [0, 1].
    - Free and node resources (`vcpusFree`, `ramGbFree`, `vramFreeGb`, `smFree`, …) are ≥ 0.
    - `ask*PricePerSec6` are non-negative integers.
    - Capability flags and `claimEnabled` are booleans.
    - `type` is `gpu` or `cpu`.
  - **Pass-throughs:** manager and ledger fields such as `volumes`, `guestPool`, `nn`, `ramFreeMb` and `ledgerSync` are
    carried as they are. A host is never dropped over a field no reader uses.

## Verification (readers and directories, same code)

1. The record is well formed, unexpired and recovers to `record.operator`.
2. `chainId` and `registry` equal the pins from an **explicit reviewed authority profile**
   (`--profile FILE --profile-digest sha256:…`). Explicit contract pins are not enough, because they carry no code
   hash.
3. At **one agreed quorum block**:
   - the pinned registry carries the reviewed runtime code and reports schema 4;
   - `get(hostId)` names this exact endpoint, this operator, and `active = true`.

   If the code or schema is wrong, the read is refused. If there is no quorum, it fails as an outage. Neither case is
   ever reported as "no capacity".
4. **Floors**, per host *and* operator:
   - a lower sequence than one already seen is a replay;
   - the same sequence with different bytes is equivocation.

   A new registry operator is never vetoed by a former operator's floor. The CLI keeps floors across runs with
   `--state FILE` (or `--capacity-state FILE`).

## Sources (no Enclave endpoint, nothing defaulted)

| source | what is fetched |
|---|---|
| `--directory ORIGIN` (`--capacity-directories` in `enclave`) | `GET ORIGIN/v1/host-capacity` → `{ records: [envelope…] }`, 1–8 explicit origins |
| `--host ENDPOINT\|HOSTID` (`--hosts`) | `GET <registered endpoint>/v1/host/capacity` → envelope; the host must be registered |
| `--cold` | the same GET for every ACTIVE registered host, at most `--max-hosts` (more are reported, not read); each host gets its `liveness` (docs/network/host-liveness.md) |

- **Host fetches are SSRF-guarded** (`publicJsonFetch`).
  - Only https is accepted, with no credentials, query, fragment or redirects.
  - The name is resolved once and refused if **any** address is non-global (`net-guard.mjs`).
  - The connection is pinned to the checked address, with TLS verified for the name.
  - Replies are bounded to 64 KiB and the fetch is time-bounded.
- **Directories are storage, not authorities.** Anyone may run one (`independent-capacity serve-directory`, or
  `createHostCapacityDirectory`). A directory verifies before it stores, and readers verify again. There is no
  central or default directory.
- **Each host counts once.** The newest valid record wins. Copies of one record from several sources are one record,
  and `sources` lists where it was seen. Equivocation excludes the host.

## Output

`hosts[]` gives, per host:

- `registry`: active, operator, posted prices, lastSeen (the last on-chain write by the operator; not liveness);
- `liveness`: `{ live, evidence, untilMs, reason }`: live on a verified unexpired record, or on a registry write within the window;
- `capacity`: `status`, one of `verified | expired | stale | refused | unreachable | equivocation | none`, plus the
  document, `issuedAt`/`expiresAt`/`sequence`, `sources` and `reasons`.

`aggregate` applies the relay's rules (`relay/api-relay.js` `gpuFreeOf`/`cpuFreeOf`) to verified records of hosts with
`claimEnabled: true`:

- the best confidential GPU slice among `gpu === true` hosts, with its VRAM, SM and card fields, and
  `gpuEnclaveCpuShareFree`;
- the best CPU pool;
- **Enclave Shield** (T0-hv, `hostExcluded: false`) as its own `shielded` entry, never folded into the GPU pool;
- `totals` summed once per host;
- `unknown`: live hosts without a verified record, so an outage is visible rather than reported as zero.

## Using it

```
# a host without the producer hook: sign a record by hand, publish it
node cli/independent-capacity.mjs record --key-file op.key --endpoint https://host.example --availability avail.json \
     --profile network-profile-base.json --profile-digest sha256:ee95…4cb8 > env.json
node cli/independent-capacity.mjs publish --file env.json --directory https://capacity.example.org

# read
node cli/independent-capacity.mjs availability --profile … --profile-digest … --rpc https://a --rpc https://b \
     --directory https://capacity.example.org --cold [--json] [--state floors.json]
enclave availability --independent --profile … --profile-digest … --rpc A,B --capacity-directories URL --cold

# run a directory
node cli/independent-capacity.mjs serve-directory --port 8790 --profile … --profile-digest … --rpc A --rpc B
```

## Hosts (producer)

`network/host-capacity-producer.mjs` imports no packages, so a measured image or a Windows node ships only it,
`host-capacity-record.mjs` and `canonical.mjs`.

- It serves `GET /v1/host/capacity`: the host's own `/availability`, signed by its registry operator key.
- It signs only while `identity()` returns the host's **confirmed** registration, and it re-reads the identity on every
  request and again after signing.
  - **Supervisor:** the once-guard is up; the registration went to the registry the address book names now; and the
    id of the register transaction that landed is the enclaveId of the endpoint.
  - **Windows node:** the registry row it read for its own endpoint is active and names its key.
- `HOST_CAPACITY_DIRECTORIES` (supervisor, optional, no default) also POSTs the record to directories the operator
  names. The integration patches are in `work/host-capacity-integration/`.
