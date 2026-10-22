# S6: reviewed first-user authority profile, result (2026-10-19)

**Scope of what I did.** I made no git commits or pushes, ran no SSH, signed nothing, sent no transactions or chain
writes, changed no service, and read no private configuration. Chain access was read-only, through public Base RPCs.
I did not edit any CLI, native-client, site/browser, custody, Windows, bootstrap-schema or existing capture-script file.

## Files (all new, in `enclave/`)

| File | Purpose |
| --- | --- |
| `network/authority-profile.mjs` | Defines the profile: fixed v1 layout, canonical encoding, SHA-256 digest, strict validation, internal link checks, export to the strict contract pin format, bounded RPC clients, and paced reads per peer. Verification uses `LeaseReader.agreed`, then compares the agreed answers with the profile. |
| `scripts/network/verify-profile.mjs` | Command with two modes. `verify` requires `--expect sha256:…` and `--rpc` ×2–8, with optional `--recompile`, `--check-pins`, `--export-pins` and `--out`. `draft` re-derives the profile from explicit inputs. Neither mode reads the address book, and neither overwrites a file. |
| `contracts/deployments/network-profile-base.json` | The reviewed profile: 18 contracts, review block 52830935. |
| `contracts/deployments/contract-pins-base.json` | The strict contract pin document exported from the profile, in the format of `network/contract-pins.mjs`. |
| `test/authority-profile.test.mjs` | 11 tests. |
| `docs/network/authority-profile.md` | Usage, what is checked, the contract table, owner powers, compatibility with legacy sessions, the mapping for the browser, re-derivation, and the remaining gates. |

Evidence saved outside the repository, next to this report:

- `claude-profile-live-verification.json`: the full live `verify --out` result.
- `claude-profile-live-negative.json`: a live failover check and a live refusal of a changed profile.

## Profile identity

```
sha256:ee957827032cf7208434e4c73f9e859a27e4fc5c6cab5f4a2153308c09eb4cb8   contracts/deployments/network-profile-base.json
```

- **The digest is the SHA-256 of the exact file bytes**, so `sha256sum` gives the same value.
- **The bytes must be canonical**: sorted keys, 2-space indent, safe integers and a trailing newline. A duplicate key or
  any reformatting therefore fails, even when the attacker supplies a matching digest.
- **The file does not contain its own digest.** The verifier refuses to run without the digest the user supplies, and it
  checks that digest before making any network request.

## What it pins

**New path.** These come from `independent-authorities-base.json`. Each address, `codeHash`, `runtimeBytes` and recorded
binding is copied from the record. The draft step refuses if a live value differs from the record:

- `PinnedSessionVaultFactory` `0xEc92…097b`
- `PinnedSessionAuthority` `0xF76A…CAc8`
- `SessionVault` implementation `0x87bc…1ff5c`
- `SessionVaultLib` `0xcc28…12b4`
- `EnclaveHostOwnership` `0xF5E9…90ea`
- `EnclaveSecretVaultV2` `0x56b8…8228`

The build section names the record's compiler and source commit, and the source SHA-256 values. `--recompile` matched
all six against fresh compiler output; the recorded hashes were not taken on trust.

**Host pins.** These six come from the public pin document, recorded with its SHA-256 `b687a8da…`:

- `registry`
- `deployments`
- `appCatalog`
- `proofOfTime`
- `enclavePay`
- `verificationFees`

**Other contracts:**

- `connectivity` `0x5f8b…5111`.
- USDC, PaymentRouter and KeyAttestations. Their addresses come from the record inputs.
- Legacy factory `0x1f5c…9c9c` and its implementation `0x66c7…1F65`. These are labelled `legacy-compatibility` and are
  never exported as pins. The implementation's `book` binding is pinned. It is the mutable book `0xab21…0907`, so the
  compatibility difference is visible on chain.

**Two kinds of getter.** Immutable getters are code-embedded bindings. Reviewed-state getters are:

- owner and pendingOwner;
- payout and the ETH/USD feed;
- the one-shot `bandwidthRouter`, `feeRouter` and `prover`;
- `importsSealed` and `retired`.

If any reviewed-state value drifts, verification refuses until a new review is done. Owner-tunable economic parameters
are deliberately not pinned.

**Internal consistency.** 35 cross-contract link rules are checked statically, and then again on chain.

**Contracts without compiled-runtime proof are labelled `observed`**: the ledger, catalog, registry, proof-of-time, pay,
verificationFees, connectivity, router, key attestations and USDC proxy. The label means two agreeing RPCs served these
bytes. It does not mean they are source-verified. The deployed registry reports schema 4, while source HEAD declares 5.

**Pin export.** `contractPins.sessionVaultFactory` is the pinned factory `0xEc92…` and `secretVaultV2` is `0x56b8…`.
Production session components still use the legacy factory. The doc explains this without claiming a migration:

- the relay;
- the CLI's unpinned default;
- the Windows `FACTORY_V2`;
- legacy-captured directory pins.

Pinned-mode CLI already refuses legacy factories. No grants, bundles, owners or book entries moved.

## Tests

**Command:**
`node --test test/authority-profile.test.mjs test/host-contract-pins.test.mjs test/lease-reader.test.mjs`

**Result:** 29/29 pass. 11 of those are new; the other 18 are the existing pin and lease-reader suites, which still
pass.

**Coverage of the new tests:**

- **Committed profile.** The digest is checked, the profile is checked against the record and the public pins, and its
  export equals `contract-pins-base.json`.
- **Byte-exact re-derivation.** `draftSkeleton` plus `buildProfile` rebuild the committed bytes exactly from the record
  and the observation. The build refuses:
  - an observed hash or binding that differs from the record;
  - a getter that did not answer;
  - public pins that conflict with the record's ledger, catalog or registry;
  - public pins that name a different factory.
- **Digest and parsing.** Refused cases:
  - missing digest, or a digest without the `sha256:` prefix;
  - wrong digest, or a tampered byte;
  - a minified file, a duplicate key, or `8453.0`;
  - invalid UTF-8, truncated JSON, or an oversized file.
- **Schema and bindings.** 25 refusal cases, including:
  - an unknown or missing field, contract or getter;
  - wrong chain, version or role;
  - duplicate, zero or upper-case addresses;
  - bad hashes or sizes;
  - flipped code provenance, or a wrong build reference;
  - a miswired binding (vault→legacy factory, implementation→mutable book, zero `bandwidthRouter`);
  - wrong value types.
- **Scripted peers: success.**
  - Two agreeing fresh peers verify at head−2.
  - The verifier never reads the address book, and every read targets a profile address.
- **Scripted peers: failover.** One bad peer cannot block or sway two honest peers. The bad peer is one of:
  - dead;
  - on the wrong chain;
  - stale;
  - serving oversized code;
  - lying about code;
  - lying about an owner.
- **Scripted peers: refusals:**
  - a single client;
  - no quorum (dead peer, or wrong chain);
  - disagreement over code or block hash;
  - both peers stale;
  - two agreeing liars: code hash mismatch, empty code (`undefined` and `0x`), a binding mismatch to the mutable book, a
    reverting `authorityPins`, a changed owner, a changed `retired`;
  - an invalid profile.
- **RPC and transport limits.** RPC origins must number 2–8, be HTTPS on distinct hosts, and carry no credentials. The
  bounded fetch rejects oversized response bodies (both streamed and declared by `content-length`) and refuses
  redirects.
- **The command, before any network request.** It refuses:
  - a missing `--expect`;
  - a wrong digest;
  - a missing `--rpc`;
  - a mismatched `--check-pins`;
  - an incomplete `draft`.
- **Scope text.** Owner powers and the scope disclaimers are present.

I did not run the full test suite.

## Live read-only checks (Base mainnet)

**Draft.** Block 52830935 (`0x40ec8c62…dd4ce`), RPCs publicnode, drpc and base.org.
- `--recompile` matched all six compiled-runtime contracts.
- 0 peer failures.
- This became the committed profile.

**Verify.** Block **52831028** (`0xc8531b272b8f1c32d39792c6b59b8c9be28944308c56ad116bd0fcb5d07adca1`, timestamp 1792451403).
- Run with `--expect` for the digest above, plus `--recompile`, `--check-pins contract-pins-base.json` and
  `--export-pins`.
- Result: `verified`, 0 peer failures. Recompiled: `hostOwnership`, `pinnedSessionAuthority`, `secretVaultV2`,
  `sessionVaultFactory`, `sessionVaultImplementation`, `sessionVaultLib`.
- The exported pins were byte-identical to `contract-pins-base.json` (`cmp`).

**Failover.** Block 52831046. The first RPC was `https://rpc.invalid` and could not be resolved; the profile still
verified through publicnode and base.org.

**Changed profile.** In a copy, I set the factory's code hash to the legacy factory's hash and changed the ledger owner.
The verifier refused, reporting both problems:
- `deployments.owner: reviewed mutable state changed`
- `sessionVaultFactory: code hash mismatch`

My first attempt at this check, run straight after other runs, failed instead with `chain quorum unavailable`. That was
a public RPC rate limit; it still refused, and is recorded in the negative evidence file.

## Not claimed

- **No production change or proof.** This is a trust choice for the new path. It does not migrate production, seal
  governance, activate the independent committee, or show that any service is independently operated.
- **Owner powers remain.** Wallet `0x0b2d…` still holds owner powers over:
  - the ledger: slashBond, sweepEscrow, economic parameters, payout, retire;
  - the catalog: approval, grantCid, transferApp, the fee cap;
  - proof of time;
  - pay;
  - key attestations.

  These powers act on the new path transitively. The full list is in the doc and in each contract's `ownerPowers`.
- **External trust remains.** Base and its sequencer, Circle's upgradeable USDC (the implementation is not pinned), and
  the chosen RPCs are still trusted. Verification uses an RPC quorum, not a light client.
- **No browser discovery list.** Native directory origins are plain-HTTP IP addresses, which an HTTPS page cannot use
  (mixed content, CORS). The doc only maps the verified pin export into the browser workstream's own validated profile.
  It does not define the browser's interface.

## Remaining gates

1. **Distribute the digest outside this repository** (site build, IPFS, ENS text record, or reviewer signatures). Until
   then, a first user is trusting the repository for both the file and its digest.
2. **Source-verify the `observed` runtimes**, especially the ledger, catalog and registry. The registry's schema 4 shows
   the deployed registry is older than source HEAD.
3. **Activate the governance seal.** Until then the owner powers above stay in effect.
4. **Build consumers.** These are owned by other workstreams:
   - CLI `profile verify`/import;
   - native-client profile import;
   - browser independent mode loading a verified export.
5. **Owner-by-owner session migration** to the pinned factory. Each owner signs their own; nothing has moved.
6. **Re-review whenever reviewed state changes** (owner, payout, feed, seal). Verification refuses until a new profile
   with a new digest is reviewed. There is deliberately no update key.
