# Attested provider: AMD collateral (pre-seed, cache, KDS)

A provider with `chainAuthority: "attested-verifier"` attests its remote chain verifier's SEV-SNP report. For that it needs
three pieces of AMD collateral: the ARK/ASK chain, the chip's VCEK, and the ARK-signed CRL.
`network/wg-provider/attested-authority.mjs` `providerCollateral` decides only **where these bytes come from**.

The verifier re-checks everything it is handed, unchanged. These checks are not configurable here, and no configuration
can name a root:
- AMD's ARK, pinned by fingerprint;
- the ASK, signed by the ARK;
- the VCEK, signed by the ASK and naming the report's chip and TCB;
- each replica's explicit `minTcb` floors;
- the CRL policy, always `"required"` (`network/attested-verifier-client.mjs` refuses anything else).

## The defect this replaces

`{ dir, kds: true }` used to build `layeredCollateral(fileCollateral(dir), httpCollateral())`, and a layered adapter
returns the **first** answer.
- Once the pre-seeded `amd/<product>-crl.der` passed its `nextUpdate`, it was still returned first. AMD KDS was never
  asked.
- Every attestation then failed closed (`CRL is stale`) until an operator replaced the file by hand.
- Wrapping the same layered adapter in the cache would not help. The cache's stale-CRL refresh asks its upstream, and
  that upstream would again answer with the stale seed first.

## Configuration

`cfg.attestedVerifier.collateral` takes one of three forms.

**`{ dir }`: unchanged.** The pre-seeded read-only files, with **no network and no cache**.
- **Layout:**
  - `dir/amd/<product>-cert_chain.pem`;
  - `dir/amd/<product>-crl.der`;
  - `dir/vcek/<product>-<chipIdHex>-<tcbHex>.der`.
- **When the seed CRL expires,** attestation fails closed until the files are refreshed (procedure below). Every
  verification reads the files again, so no restart is needed.

**`{ dir, cacheDir }`: no network.** The authenticated, freshness-aware cache (`verifier/collateral-cache.mjs`), filled
only from the pre-seed. It adds authentication before anything is stored, quarantine of bad entries, and sidecar
digests.

**`{ dir, cacheDir, kds: true }`: the cache, with AMD KDS as a source.** The cache's upstream is chosen **per piece**:

| Piece | Source order | Why |
|---|---|---|
| ARK/ASK chain | pre-seed **only** | An ASK rotation stays an operator decision, as in `isolation/m2/host-collateral.mjs --allow-ask-rotation`. A KDS answer can never introduce a new ASK. |
| VCEK | pre-seed, then KDS | A seeded slot needs no network; a new TCB slot not in the seed comes from KDS. |
| CRL | **KDS first**, then the pre-seed | A fresh KDS CRL always wins over an expired seed. During a KDS outage the seed is the fallback. |

**Requirements on `cacheDir`:**
- It must be absolute and writable by the provider.
- It must be **separate** from `dir` (neither inside the other), because the cache writes and the pre-seed is never
  written.
- **The separation check is lexical.** It compares the configured absolute paths after `path.resolve` and does not
  resolve symlinks or mounts. Operators must therefore not alias the two directories through a symlink, a bind mount, or
  a path that resolves into the other. The check catches configuration mistakes; it is **not** a defence against a
  hostile local user who controls the filesystem layout. Such a user can already replace the provider's files, and the
  verifier's pinned-ARK checks, not this check, are what keep forged collateral out.

**Cache behaviour** (`verifier/collateral-cache.mjs`, unchanged):
- **Fresh cached entry:** it answers with **no network**, including after a restart, because the cache is on disk.
- **Authentication before storing:** every entry is authenticated against the pinned roots before it is stored or
  served. A refused entry is renamed `*.rejected-<ms>` and never served.
- **Stale CRL:** a cached CRL past `nextUpdate` sends the request to the upstream first (KDS, then the seed). It is
  served flagged `stale` only when nothing fresher answers, and the verifier's `"required"` policy then **rejects** it.
- **Revocation:** an authentic CRL that revokes the ASK is served, so the verifier rejects.

**Migration:** `{ dir, kds: true }` **without** `cacheDir` is now **refused at startup**, with a message pointing here.
Add `cacheDir`, for example `/var/lib/enclave-provider/amd-collateral-cache` with mode 0700, owned by the provider user.
No other field changes. `{ dir }` configurations need no change.

## Provisioning and refresh (operator)

**1. Authenticate before installing.** Prepare and authenticate collateral with
`node isolation/m2/host-collateral.mjs prepare ... --out <new dir>` (`docs/network/cold-host-collateral.md`). It checks:
- the chain against the pinned ARK, with the ASK pinned unless a rotation is explicitly allowed;
- the VCEK against the chip and TCB, and the `--min-tcb` floor;
- the CRL as required.

**2. Install it into the seed layout.** Copy the authenticated `cert_chain.pem`, `crl.der` and `vcek.der` into a **new**
seed directory with the names above. Then switch `dir` (or an atomic symlink) to it. Do not edit files in place.

**3. When the seed CRL nears `nextUpdate`:**

| Mode | Action |
|---|---|
| `kds: true` with `cacheDir` | Nothing is required while KDS answers: the stale cached CRL is refreshed from KDS on the next attestation. Refresh the seed CRL anyway, so a KDS outage falls back to a fresh seed. |
| `{ dir }` or `{ dir, cacheDir }` | Install a fresh, authenticated CRL into the seed **before** `nextUpdate`. It is read on the next attestation, without a restart. |

**4. ASK rotation (rare, reviewed).**
- Authenticate the new chain with `host-collateral --allow-ask-rotation` after review.
- Install it into a new seed directory.
- **Stop the provider, remove `cacheDir/<product>/chain.pem` and its `.meta.json`, then start it.** The cached chain is
  otherwise served while it remains valid.

**Restart is bounded.** A restart re-reads `cacheDir`; there is no in-memory-only state to lose. A warm cache attests
offline.

## Expiry and outage: recovery

| State | Result | Recovery |
|---|---|---|
| Seed CRL stale, KDS up (`kds: true`) | attests; the CRL comes from KDS and is cached | none |
| CRL stale everywhere, KDS down | **rejected** (`CRL is stale`); the attested authority is unavailable and the provider does not fall back to any RPC | restore KDS reachability, **or** install a fresh authenticated seed CRL. The next re-attestation succeeds without a restart. |
| No CRL anywhere | **rejected** (`required by policy but none was supplied`) | as above |
| Forged or garbage CRL from the network | refused by the cache and never stored. With a stale or absent alternative the verification is **rejected**. | as above. A non-authentic KDS answer currently blocks the seed fallback for that attempt; it fails closed. |
| Revoking CRL (authentic) | **rejected** | none, by design: an AMD revocation must stop admission |
| Wrong VCEK in the seed slot (another chip or TCB) | refused and quarantined; **rejected**, without falling through to KDS for that slot | re-run `host-collateral prepare` for the right chip and TCB, then install |
| Chain not under the pinned ARK | **rejected** | reinstall the authenticated chain |

## Tests and limits

**Tests:** `test/attested-provider-collateral.test.mjs` uses **real signed synthetic** collateral: the AMD-shaped test
ARK/ASK/VCEK and ARK-signed RSASSA-PSS CRLs of `test/helpers/snp-synth.mjs`, pinned only programmatically. "KDS" is a
local adapter with controllable availability. These are offline composition tests, **not** a live AMD KDS or SEV-SNP
hardware end-to-end run. They cover:
- the old defect, reproduced;
- stale seed with fresh KDS;
- fresh, warm, offline and restart;
- stale with an outage;
- restoration;
- forged and revoked collateral: a CRL independently signed under a different ARK, a forged pre-seeded chain, another
  chip's VCEK, and an authentic CRL revoking the ASK;
- defence in depth: the same forged CRL handed to the verifier with **no cache** in between is rejected by the
  verifier's own signature check, and the genuine fresh CRL in its place verifies;
- configuration and migration.

**Limits:**
- **Rollback window.** Any authentic CRL that has not passed its `nextUpdate` is accepted, so an older but unexpired
  AMD CRL is not distinguished from a newer one. That is the verifier's existing policy, unchanged.
- **Chain from seed only.** With `kds: true`, the chain never comes from KDS. A provider with no seeded chain cannot
  attest; that is intentional.
- **Wrong seeded VCEK.** It fails closed instead of self-healing from KDS (see the recovery table).
