# Open participation: provider bootstrap without Enclave, and an ownerless service index (2026-10-19)

**Repository:** `enclave`, branch `decentralize/nan-retirement`.

**Not done:** no commits, pushes, SSH, subagents, private configuration, production access, chain writes or deployment.
All chain activity ran on local Anvil.

**Files touched:** only the assigned ones:

- `network/wg-provider/install.sh` and `network/wg-provider/main.mjs` (bootstrap defaults only);
- new `network/service-index.mjs`, `contracts/EnclaveServiceIndex.sol`, `scripts/network/service-index.mjs`,
  `test/service-index.test.mjs`, `test/EnclaveServiceIndex.t.sol` and `docs/network/open-participation.md`.

Other workstreams' files were left alone.

## Result

| Requirement | Status |
| --- | --- |
| Provider bootstrap with no Enclave approval, name reservation, fleet secret, address book or `enclave.host` probes | **Done.** Explicit mode in `install.sh` and `main.mjs`. |
| Caller-selected pins, RPCs, directories and probe targets required; legacy only by opt-in | **Done.** The positional form needs `--legacy-enclave-defaults`; existing configs without `bootstrap` run unchanged. |
| Existing capabilities preserved | **Done.** Paid/community fields, `localRoutes`, the relay domain map (opt-in), checkers and signed records. Updates now *keep* the operator-managed fields; the old installer overwrote them. |
| Ownerless service index (self-register, replace, withdraw; bounded; expiry and sequence; no admin) | **Done, source only.** Not deployed. |
| Chain, contract and operator binding; no cross-network signatures | **Done.** EIP-712 with the chain id and contract address; low-s only; nonzero operator. |
| Reads at a fixed block with fresh, agreeing RPCs; ads returned as UNTRUSTED candidates | **Done** |
| No SSRF or private probing; no automatic endpoint writes or credentials | **Done.** The reader never fetches; unsafe targets are dropped; publishing needs an explicit `--yes`. |
| Tests on real Anvil plus Foundry | **Done.** 9 of 9 Anvil tests; 7 of 7 Foundry tests. |

## Why the index materially helps first-user bootstrap

Today a first user can learn where directories, checkers, storage and replicas are only from Enclave-hosted defaults or
hand-supplied profiles. The index turns that into **one immutable value**: the index pin `{chainId, address, codeHash}`.
That pin never needs updating and can be replicated anywhere. Its `codeHash` is reproducible from source with
`service-index.mjs pin`.

Operators add and remove themselves without anyone's approval. Readers get bounded candidate lists. The index is **only**
discovery: what is trusted is still decided by signatures, owner policies and the checkers each user chooses.

## Design

**`contracts/EnclaveServiceIndex.sol`**

- **No owner, administrator, pause, upgrade or global delete.**
- **Slots and kinds.** An ad is keyed by (operator, slot), with at most 8 slots. Kinds: directory 1, checker 2,
  storage 3, dns 4, replica 5. Each ad carries a format version (nonzero).
- **Bounded content.**
  - Endpoints: 1 to 4, each 1 to 256 printable ASCII bytes. They are stored as the ad's locators.
  - An optional `bytes32` sha256 of a content-addressed descriptor (4 KiB or less) carries anything else, such as a
    directory's record key.
  - Expiry is greater than now and at most now + 90 days.
- **Sequences.** Each publish or withdraw needs a strictly higher per-slot sequence. The sequence survives withdrawal and
  pruning, so an old signature can never be replayed, and a withdrawal also revokes signed ads never submitted.
- **Signatures.** `publishFor` and `withdrawFor` take an EIP-712 signature (domain: name, version, `block.chainid`,
  `address(this)`), so anyone may pay the gas.
- **Pruning.** `prune` removes only ads that have already expired.
- **Paging.** `page(kind, start, limit≤64)` reads from per-kind arrays that stay dense by swap-and-pop. Spam costs gas,
  expires, and is bounded per read.

**`network/service-index.mjs`**

- **`readServiceIndex`**
  - Every RPC must report the pinned chain.
  - The block is the second-highest head minus 2.
  - At least two RPCs must answer, and all answering RPCs must agree on block hash, code hash and pages; otherwise it
    refuses.
  - The code hash must match the pin, and the block must be fresh (300 s by default).
  - Expired ads are dropped. A cap on ads per kind is applied, and `truncated` is reported.
  - Each candidate is marked `trust: "untrusted-candidate"`, and the result carries a notice.
- **`validateEndpoint`**: http(s) only, to a public DNS name or a public IPv4 address. It rejects:
  - private, loopback, link-local, CGNAT, multicast, documentation and reserved ranges, including numeric forms such as
    `2130706433`;
  - IPv6 literals;
  - single-label and special-use names;
  - credentials, queries and fragments.
- **Descriptor and signing helpers:** `descriptorHash`, `verifyDescriptor`, and EIP-712 `publishTypedData` /
  `withdrawTypedData`.
- **`resolveProviderBootstrap`**
  - **Legacy:** exactly the old behavior.
  - **Explicit:**
    - complete `authorityPins` (zero allowed for `connectivity` and `sessionVaultFactory`), and an `addressBook` entry is
      refused;
    - two or more https RPCs on distinct hosts;
    - 1 to 8 directories, with no relay fallback;
    - one or more checkers;
    - explicit zone and probe zone;
    - an optional https relay, used only for the domain map.

**`network/wg-provider/main.mjs`**

- Uses the resolved bootstrap for directories, the lease reader (pins; a zero placeholder for the never-read book),
  owner-signature verification, zones and the connectivity lookup.
- The custom-domain map comes only from a configured relay.
- New `--check-config <file>` mode.

**`network/wg-provider/install.sh`**

- The explicit flags described in the doc.
- The legacy positional form only with `--legacy-enclave-defaults`.
- Merges `provider.json`, keeping `kind`, `hostId`, `pricePerGiB6`, `proofKeyFile`, `localRoutes`, `noSniRoute`, `budget`
  and `ports`.
- Validates with the new release's `--check-config` before switching; a rejected config changes nothing.
- New `--config-only` mode, and an `ENCLAVE_NETWORK_ROOT` prefix.
- New `--public-address` and `--uplink` flags.
- Publishes nothing.

**`scripts/network/service-index.mjs`** (operator and first-user command)

| Command | What it does | Key? |
| --- | --- | --- |
| `pin` | Compiles the reviewed source and compares it with the deployed code, at an agreeing block. | None |
| `list` | Prints untrusted candidates. | None |
| `descriptor` | Writes a bounded descriptor and prints its sha256. | None |
| `prepare-publish`, `prepare-withdraw` | Read the next sequence from agreeing RPCs and write the typed data plus the direct call. Nothing is signed or sent. | None |
| `sign` | Signs offline. Refuses unless the key is the ad's operator. | Explicit key file |
| `send` | Requires `--yes`, a matching chain and the pinned code. Simulates first. With `--signature` the key only pays gas; without it, the key must be the operator's. | Explicit key file |

No command creates a key.

## Tests run

| Command | Result | Covers |
| --- | --- | --- |
| `FOUNDRY_TEST=test forge test --match-path test/EnclaveServiceIndex.t.sol` | **7 of 7 pass** | Own-slot publish, replace and withdraw, with kinds moved; failed takedown by the former governor (live prune, forged `withdrawFor`, unsigned `publishFor`; `owner()`, `pause()` and `transferOwnership` don't exist); wrong signer, high-s, a second contract instance and another chain id refused; signed submission by a gas payer, and no replay after withdrawal; a withdrawal revoking an unsent signature; expiry bounds and prune-only-expired; slot, endpoint and printable-content bounds; 70-entry paging capped at 64 and dense after withdrawal. |
| `node --test test/service-index.test.mjs` | **9 of 9 pass**, on real Anvil (two separate chains) | **Pin:** reproducible; other code and the wrong chain refused; a wrong pinned code hash refused. **CLI on chain:** independent registration by two operators (one direct, one signed with a gas payer); `--yes` required; wrong signer refused; descriptor verified. **Replacement and withdrawal:** replacement with a higher sequence, no replay of an older signed ad, withdrawal. **Takedown and signatures:** the deployer can't withdraw, prune or forge; wrong-signer and other-chain signatures revert; no administrative selectors. **Expiry:** expired ads excluded, then pruned by anyone, with the sequence kept. **Agreement:** two chains with the same address but different state are refused as disagreement; one RPC, the wrong chain id and a stale view are refused. **Bounds:** 70 ads with a 50 cap stay bounded and report `truncated`; 8 unsafe targets dropped with reasons. **Provider bootstrap:** legacy unchanged; explicit refuses an address book, missing directories or pins, one RPC, a duplicate RPC host, missing checkers or zones, or an http relay. **Installer:** `install.sh --config-only` explicit run with no `enclave.host` or address book; positional form refused without opt-in; incomplete flags refused; operator key made locally; operator fields kept on update; a rejected config changes nothing; the legacy opt-in still writes Enclave defaults. |
| Existing provider and network suites (`lease-reader`, `network-authority-pins`, `provider-bootstrap`, `provider-canary`, `provider-settlement`, `public-provider-mirror`, `wg-provider`) | **44 of 44 pass** | Regressions. |
| esbuild bundle of `network/wg-provider/main.mjs` | Builds | The bundle runs `--check-config` on an explicit config (`ok`, with notes). |

**Limits:**

- Anvil stood in for Base, and two client connections to one Anvil instance stood in for two agreeing RPC operators.
  Disagreement used a second, separate Anvil chain.
- `install.sh` was run only in `--config-only` mode. Packages, ufw and systemd were not exercised; that needs a root VM.
- No public RPC was used.

## Trust assumptions (exact; also in the doc)

| Input | What is trusted |
| --- | --- |
| Contract pins | Whoever supplied the addresses. Re-derive the code hashes, compare at least two sources. The contracts are immutable. |
| RPCs | That two or more do not collude. This is not a light client. A disagreement refuses; it never chooses a side. |
| Directories | Availability only. Records are signature- and chain-verified. |
| Checkers | Explicit trust anchors chosen by each operator or user. An ad never confers checker trust. |
| Zones | Their DNS operators. |
| Index pin | Agreement on *which* address. Anyone can deploy the same code elsewhere, and ownerless means nobody can change the agreed one. `codeHash` is reproducible from source. |

## What this does not do

- It does not create independent operators. Every existing provider, directory and checker is Enclave-operated, and an ad
  would not prove otherwise.
- It does not deploy the index. That waits for coordinator review; the steps are in `docs/network/open-participation.md`
  §4.
- It does not change `network/provider-probes.mjs`, `wg-qualify` or `owner-policy`, which other files own. The outbound
  probe default (`https://enclave.host/`) in `provider-probes.mjs` remains for the checker tooling and is outside this
  scope.
- It does not wire index discovery into the CLI, native client, browser or Windows host (other owners). The reader and
  pin format are ready for them, and must stay advisory.
- The provider's own discovery of other providers still goes through directories with signed records. The index only
  helps find directories.

## Next steps

1. Coordinator review of `contracts/EnclaveServiceIndex.sol`, then deployment and a record in `contracts/deployments/`.
2. Include the index pin in the reviewed network profile (scope S6).
3. Let the profile import show index candidates for user selection, never automatic selection.
4. Make the checker tooling (`provider-probes.mjs`, `wg-qualify`) require explicit probe targets. Those files have
   another owner.
