# Paid provider under `chainAuthority: "attested-verifier"`: candidate receipts (2026-10-25)

**Status:** source candidate only. Nothing is activated. **No live gate below is satisfied by these receipts.**

## What the change does

A paid wg-provider can now make its on-chain sends (EnclaveConnectivity `setHost`, `qualify`) with no public RPC.

- **The ONE attested verifier** answers every read, the simulation, the gas search, the proven nonce and balance, and
  every receipt. Labels: `attested-verifier`, `localProof: false`, tier unsafe, finality none, no replica quorum.
- **The operator's own Base node** (`txBackend`: a loopback or private IPv4 literal) answers only:
  - the binding to the verifier's head;
  - the pending-nonce hint;
  - the tip hint;
  - submission.
- **Backend answers are never evidence.** Each must be JSON-RPC 2.0 with exactly the request's id, exactly one of result
  or a well-formed error, and canonical quantities. Anything else counts as no answer.
- **Exact bytes.** A signed send is persisted atomically before broadcast and re-broadcast as the same bytes, also after a
  restart. It is resolved ONLY by a verifier receipt (success or reverted) or by the proven nonce passing it.
  - A backend refusal resolves nothing.
  - A send that cannot land holds its record by design. Reconcile it by funding the key, or by spending that nonce with
    another operator transaction. Never delete the record.
- **Config.** A paid attested provider without a valid `txBackend` refuses to start, as does an invalid or public one,
  and an unpaid provider that sets one. The quorum branch is unchanged.
- **Unchanged:** `network/onchain-qualification.mjs`.

## Provider verification bundles (pinned to the BUILT image source)

- **Image source:** `0235e7d9659f1ccbf9f258bd03593d26f32f3f3a`, tree `d36f220a`. That source was built twice, measured
  `4287b65e…cd0277f33c9869173420f03f5fb53e4ad2859be9` and independently checked 45/45 by the image worker. Exported here
  read-only.
- **Bundles:**

  | bundle | sha256 |
  |---|---|
  | `network/attested-guest-verify.bundle.mjs` | `00b88784578f53930b68f296fb9cfec0347a62c3f23380e0049190bf903b5ac0` (421 inputs) |
  | `test/fixtures/attested-guest-image.bundle.mjs` | `d954ecf8228691f33f171edffe03c1d4c0837745c300ff5c1378d558e2fef46f` (415 inputs) |

- **Reproducibility:** rebuilt identically from a second export at another depth. All 836 recorded input hashes equal the
  commit's files or the locked `node_modules`.
- **Change vs the e0dfe98aa pins:** exactly 1 input, `metal/guest/lease-gas-conduit.bundle.mjs`.
- **Receipts:** `receipts/b1.summary`, `receipts/guest-verify-check.txt`, `receipts/guest-verify-bundles.sha256`.
- **Release consumers** (`scripts/network/build-consumers.mjs`; untracked artifacts, reproducible twice):
  `receipts/release-consumers.sha256`.
  - `provider.mjs` `7cc6019f…`.
  - `privacy-agent`, `checker` and `dns` are unchanged from HEAD.
  - Its `@libp2p` dependencies are a lock-verified copy (37/37 version and integrity); nothing was installed.

## Tests (shared queue, strict per-file runner, network namespace with loopback only; skip = fail)

| suite | result | what it is |
|---|---|---|
| `test/attested-route-composition.test.mjs` | 7/7 | the attested authority, the admission policy, ERC-1271 and packaging |
| `test/attested-paid-provider.test.mjs` | 11/11 | anvil with production contract bytecode; the real attested channel; a **verifier stand-in (no proofs)**; fault-injecting backend proxy |
| `test/attested-paid-provider-helios.e2e.test.mjs` | **3/3, twice** | **real pinned runtime:** reth v2.8.0 `--dev` + the real verifier runtime (`helios-eeffcc9`, `witness-check`, listener commitment) via relay-consumer-source `ab371cbc2` (read-only) |

Receipts: `receipts/b2-*.files.tsv`, `receipts/b2.summary`, `receipts/real-verifier-calls.txt`. The last records every
method and parameter shape the real verifier answered.

**Synthetic parts:**
- SEV-SNP evidence: programmatic test roots;
- the e2e ledger stand-in: `registry()` only, which is the only ledger read on this path;
- the dev chain's sequencer key: a TEST key.

**Real-runtime findings now handled.** The pinned Helios can name a head, or return a receipt, for a block its header path
does not hold yet ("outside EIP-2935 ring buffer range"). That exact refusal is read as "not confirmable yet": the send
stays unresolved. Any other error propagates.

## NOT proved here (remaining live gates)

1. **Hardware:** a real AMD SEV-SNP attestation of the `4287b65e…` image with real collateral. CRL refresh is not built.
2. **Native binaries:** provenance of the pinned Helios, reth and listener binaries. Here they are verified only by
   `PINS.sha256`.
3. **Chain:** Base mainnet with real sequencer signatures and the production head listener. L1 finality is not proved:
   tier unsafe, finality none.
4. **Backend:** a real operator Base node as `txBackend`, including its forwarding and error texts.
5. **Rollout:** each provider's reviewed replica config and measurement pin, `txBackend` placement, funding, and an
   operator procedure for a held send record.
6. **Release:** the release and installer for the new `provider.mjs`. Activation, the provider rollout and any live
   change are root's.
