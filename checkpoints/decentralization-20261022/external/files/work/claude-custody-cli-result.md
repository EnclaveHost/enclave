# Independent custody CLI: result (claude, 2026-10-20)

Repo: `wo/work/enclave` (main working tree).

**Constraints kept:**
- Nothing committed or staged.
- No edits to `cli/enclave.mjs` (the move worker owns it); the glue is a patch below.
- No edits to measured `custody/v2` code, Windows, browser, contracts or SDK.
- No production, SSH, GUI, Wine, real keys or funding. Every chain was a local anvil with generated keys.
- I did not touch the candidate clone, builds, provenance or Rust target (coordinator-owned).

## Delivered

| File | sha256 |
|---|---|
| `cli/custody-independent.mjs` (new, mine) | `1fac6dc4d8971fed78fa03b1314523b7d31fadd934382e47abc23bb42ed80cb2` |
| `test/custody-cli-independent.test.mjs` (new, mine) | `28550e4292d76c719330f9a067a963d3d63d3933e8f94aa6c321ac719f9a38e5` |
| `docs/security/custody-independent-cli.md` (new, mine) | `4882139f7ac9dfb3476248698c3d41e96c7488070051d3a6cdef3789a7f22867` |
| `work/custody-cli-interface.txt` (API contract + exact glue patch) | `7b7645c5bca1714d91415106df0473648416d7c44983f75b78df3f585613adef` |
| `work/custody-cli-logs/glue/glue.patch` (the same patch, standalone) | `f343ebd5b1ae9ba2acf312c64797080dcbf38ce5d82e26c3070db6c673d15780` |
| `work/secret-editor-parity-proposal.txt` (design only) | `64722f23ac6330e0c71f78a2514c230dc8ff72c2e02b7ad89e9eb5146cc21b9a` |

The patch targets `cli/enclave.mjs` sha256 `5c21db40…125d` (today's file) and passes `git apply --check`. Hosted
`cli/custody.mjs` and `cli/custody-v2.mjs` are unchanged, so the hosted behaviour is unchanged.

## What works now, independently (once the glue is integrated)

`status`, `set`, `migrate`, `pause`, `resume`, `clear` and `claim`, plus a local `seal-export`.

**Reads.** Every read goes through `custody/v2/chain.mjs` (`createChainReaderV2`) over the CLI's own quorum peers
(`leaseReaderClients`), with:
- minAgree = max(`--quorum`, majority);
- the CLI's confirmations and block age.
There is no `h.api`, relay, `relayRead`/`relayClear`, first-answer client or platform-committee default (a source test
checks this).

**Writes.** Through the CLI's independent writer (`INDEPENDENT.send`): simulate at an agreed block, sign once, broadcast
the same bytes, confirm by quorum. Then an **exact readback** through the quorum at or after the receipt block: revision,
owner, committee, paused flag, rule bytes, secretRev and bundle bytes.

**Trust:**
- **Vault.** The reviewed `secretVaultV2` pin. With a profile, its code hash and every immutable binding are checked. With
  pins only, the ledger, registry and session factory are checked against the pins, and the result is reported as
  `codeReviewed:false`.
- **Committee.** Explicit the first time, then the policy's own. An Enclave seat is refused without
  `--allow-enclave-seat`.
- **Rules.** The owner's file: SNP rules v1, or Shield rules parsed by their own validator. Existing rule bytes are
  re-written verbatim; nothing is relabelled or lowered, and `--rules-from-relay` is refused.

**Owner and gas:**
- The owner is checked before signing:
  - the policy owner, or the ledger's beneficial owner for a first write;
  - after a ledger move, only the new owner's `claim` (which destroys the old bundle).
- `--payer-key` makes the owner sign `updateBySig`/`claimPolicyBySig` (EIP-712, 600 s), so the payer only pays. Tested
  with an owner holding zero ETH.

**Migrate.** From the owner's own export: plaintext `{env}` (a saved hosted `secrets ls --show --json`) or `{KEY:value}`,
or a sealed `enclave-secrets-export/1` (scrypt N=2^15 + AES-256-GCM, bound to the deployment id). There is no mandatory
relay; the relay copy is never cleared here (the command says to clear it with the hosted CLI and rotate).

## Tests (real local contracts and crypto; synthetic custodians)

`test/custody-cli-independent.test.mjs`:
- **Setup.** anvil (chain 8453, interval-mined) with the REAL `EnclaveSecretVaultV2` and `EnclaveHostOwnership`, compiled
  output reused from the rig's cache, with no solc run. Ledger and registry are stand-ins.
- **Committees.** A REAL independent committee: 3 hosts with distinct non-Enclave owners, genesis signed by every machine
  and host operator, and a key the test knows (f(x) = a0 + a1·x). Also an Enclave-founded committee.
- **The CLI.** It runs with the real `QuorumChain`, quorum writer and v2 reader over three JSON-RPC proxies (ok | lie |
  down).

What the 12 tests cover (11 in-process, plus one entry-point test):
1. **set.** It writes SNP rules and the whole map, and is read back exactly. **The stored bundle opens with S = a0·R** to
   exactly the values and the config sha256. A second `set` keeps the rule bytes verbatim and replaces the whole map.
   Values are never printed.
2. **Separate gas payer.** The owner holds 0 ETH and signs; the payer pays. A non-private payer key and the owner's own
   key as payer are refused.
3. **Shield rules.** Status names the T0-hv tier; `pause` and `resume` change only the flag, and the rule bytes are
   identical. A malformed `acceptTier` is refused.
4. **Refused with nothing signed** (the send counter stays 0):
   - no rules, no committee, an unknown committee;
   - an Enclave-seated committee without the opt-in (with it, accepted and stated);
   - another wallet;
   - `--rules-from-relay`, a prefix id.
5. **Stale state.** A racing update lands between the read and the send. The vault's `expectPolicyRev` guard refuses at
   simulation; only the racing update landed.
6. **Wrong vault.** A wrong code hash or wrong immutable binding (profile or pins) is refused; pins-only reports
   `codeReviewed:false`; no vault pin is refused.
7. **Ledger transfer.** Neither the old nor the new owner can write. The old owner cannot claim. The new owner claims
   (paused, bundle destroyed), then sets.
8. **Migrate.**
   - From plaintext (the hosted JSON shape), and from a sealed export (written 0600, no plaintext inside).
   - Refused: a missing passphrase, a wrong passphrase, an export for another deployment.
   - `clear` needs `--yes`, and destroys the bundle while keeping the rules.
9. **Lying RPCs.** With 3 RPCs (one lying), the lie is outvoted and the agreed committee key is used. With 2 (one lying),
   it is a refusal (a veto), never a value. With one down of 2, nothing is written.
10. **Source test.** No Enclave or relay route.
11. **Exact readback.**
    - A writer that reports a receipt but wrote nothing is caught.
    - A writer that wrote a different bundle under the same revision is caught.
12. **Entry point** (opt-in: `CUSTODY_GLUE_CLI=<patched cli/enclave.mjs>`).
    - A subprocess of the real CLI with `--independent --contract-pins --rpc`, an isolated HOME and XDG config, and
      `ENCLAVE_KEY`.
    - It runs `custody status`, then `custody set` (read back and opened), and checks that `secrets ls` is still refused
      by name.

**Runs** (serial, `test/helpers/memory-guard.mjs --max-rss-mib 512 --floor-available-mib 16384`):

| Run | Result | Peak tree | Start MemAvailable |
|---|---|---|---|
| run2 (tests 1-10) | 10/0 | 408 MiB | **17.91 GiB: below the 18 GiB start rule (my slip; the 16 GiB floor held)** |
| run3 (tests 1-11) | 11/0 | 484 MiB | 18.1 GiB |
| glue-run3 (test 12 against a patched isolated copy of the CLI) | 1/0 | 494 MiB | 18.8 GiB |

**About the runs:**
- **First runs failed on test errors.** run1 had 3 failures (two missing `--no-config`, one regex); glue-run1 and 2 failed
  on missing modules in the isolated copy, before I copied whole source trees.
- **Start checks.** After run2, every launch first checked MemAvailable ≥ 18 GiB. One attempt was skipped below it.

**Mutation checks** (isolated copy, each restored byte-identical; copy deleted): 5 of 5 killed. Peaks 357-424 MiB.
- the Enclave-seat refusal removed;
- the readback bypassed;
- the policy-owner check removed;
- pause re-encoding the rules;
- the vault binding check removed.

**Not run:** the hosted `test/custody-cli.test.mjs` (the hosted code is unchanged; re-run after integrating the glue).

## Interpretation (CORRECTED 2026-10-20)

**What I got wrong.** The requirement was "Enclave veto only own hosts". It is about **accepted HOST WALLET ownership**,
not RPCs. My earlier reading ("a lying RPC can only veto") was wrong. Test 9 is RPC-quorum coverage only, not this.

**What the code does.**
- The independent path decides "Enclave seat" ONLY from the vault's own per-machine `enclave` flag. The contract computes
  that flag from `hostOwnership.authority(registryId)`: the host's accepted wallet owner equals the vault's `enclaveOwner`.
  So Enclave's share and veto in a committee reach only the hosts whose accepted owner wallet is the Enclave wallet.
- An independent committee (`createIndependentCommittee`) refuses any such host and requires distinct owners.
- The CLI refuses an Enclave-seated committee unless the user opts in (`--allow-enclave-seat`). It reports the seats by
  that flag.

**Tested.**
- The Enclave-founded committee in test 4 has one host whose accepted owner IS the Enclave wallet.
- The independent committee's three hosts have distinct non-Enclave owners.

**Not tested.** A host-wallet ownership transfer changing a seat's flag across an epoch handover. That is
contract/governance behaviour, outside the CLI.

## Open, honestly

1. **Secrets parity is not done.**
   - Done: `custody clear` (`secrets clear` parity) and whole-map `set`/`migrate`.
   - Open: `secrets ls` (names), `ls --show`, `rm KEY` and a merging `set KEY`. They need an **owner read** that does not
     exist.
   - `work/secret-editor-parity-proposal.txt` recommends an owner-authorized, purpose-, challenge- and HPKE-bound release
     to an ephemeral owner key. It requires `signer == policy.owner == beneficialOwnerOf`.
   - That needs a **new measured custodian image** (custodian.mjs, http.mjs, the rules parsers) plus `code-approve`. That
     is FLAGGED; no measured code was edited.
   - The alternative, an owner recovery-key sidecar, needs a new owner-written pointer contract instead.
   - The glue keeps `secrets` refused in independent mode, with that reason.
2. **Glue integration.** The coordinator applies the patch after the move change, then runs test 12 with
   `CUSTODY_GLUE_CLI=cli/enclave.mjs`, and the hosted custody CLI test.
3. **Not offered independently.**
   - custody v1 (Enclave bootstrap committee);
   - `--unsigned`/`--signer` for custody (owner signing is local here);
   - a browser editor.
4. **Hardware.** No custodian ran and no guest was released. The bundles were opened with the test committee's known
   secret.
