# External signer (`--signer`) in independent mode: result

Repository: `work/enclave` at HEAD `45801c22`.

I made no commits and no staging. I did not edit any shared file (`cli/enclave.mjs`, `cli/independent.mjs`,
`docs/network/independent-cli.md`); the glue is reviewable patches. The full contract is in
`work/independent-signer-interface.txt`.

## Source inventory (sha256)

New files I own:

| file | sha256 | lines |
|---|---|---|
| `cli/independent-signer.mjs` | `d6eb8771f0153a33557935df39696a0d211995bde9a5b84b4a2f9c9d14559303` | 610 |
| `test/cli-independent-signer.test.mjs` | `5e7e27893a9619a463aef5b3f191e17785accb5511498477b88fe51e8925251f` | 407 |
| `docs/network/independent-signer.md` | `a6919e60a0ddfd21d9c83881f9c8a8e5559f121d7cb8289c3acdbff42ccc039b` | |
| `work/independent-signer-interface.txt` | `ad51a9b81aaa64bdf7e71bc442405a902d1ffab15b58c48445110c9df8668032` | |

Integration under `work/independent-signer-integration/` (NOT applied):

| file | sha256 | lines |
|---|---|---|
| `enclave.patch` | `ca6d94e6b79f061451bb3654d53fd7b0b92d10e64fced23ee721d39770fff2fe` | 127 |
| `independent.patch` | `e9318d49d08512f3f6702e98f7a84564bad66a67946930b2f6301234bfbc3406` | 13 |
| `independent-cli-doc.patch` | `3ae6ad5cc94444dd024c6aa9af767e317f7ae1aac62b334966bc3fd03f5e1f30` | 19 |
| `cli-independent-signer-cli.test.mjs` (goes to `test/` once the patches land) | `1239f9b7fb8d7f3c678c408f33614cf97597391ea740b3876089c0aec0f87f14` | 123 |

The patches apply to the current WORKING-TREE files, which are dirty relative to HEAD. `cli/enclave.mjs` is modified
and `cli/independent.mjs` is untracked; both are other workers' uncommitted work. `git apply --check` passes for all
three.

| base file | base sha256 | after the patch (fresh apply == tested tree) |
|---|---|---|
| `cli/enclave.mjs` | `5c21db40f393806f9da44392c35174d626e580356a7b206c0f30a361e599125d` | `24777e2771aff8fedca41310ac7c6109c5aa592bc5d579f5f83f063c6b49482b` |
| `cli/independent.mjs` | `36b3a364e3252cdcf795f12b2de0e28dccc2bba53e2185b6b6a912c86589561f` | `82996c8c27e67217c21764ca8275643d5a2bef25678025d32d045e38386a72d1` |
| `docs/network/independent-cli.md` | `d3660d23c4eda701d19e9cbae883c811ff294a5bc7eec884bf699106baa6f918` | `af5fc0aa4bb6087b04bbf9260a00758088923c13dae107f3170e6100a7c2fc1d` |

Dependency: `network/rpc-identity.mjs` (`74cb965e…5d57`), the shared URL helper. It is already committed (`50a37f6d`,
in HEAD), so it adds no integration step. (Corrected: an earlier version of this report said it was uncommitted.)

## What it does

- **Sign path.** The CLI prepares every transaction field from the quorum (agreed simulation, agreed pending nonce, gas
  and fee caps). The wallet signs it with Clef `account_signTransaction` or `eth_signTransaction`.
  - Before anything is broadcast, the returned bytes must:
    - match every field: chainId, nonce, to, value, data, gas, maxFee, priority fee, an empty access list, type 2, and
      no blob or authorization fields;
    - re-serialize to the same bytes (canonical encoding), with a low-s signature;
    - recover to `--from`.
  - The raw bytes are journaled; then the unchanged `sendQuorumTx` broadcasts those bytes to every quorum RPC and
    confirms one hash.
- **Wallet-send.** Secondary, for wallets that only send. `auto` falls back to it only after a DEFINITE "method not
  supported", and announces it.
  - The intent is journaled first, and `eth_sendTransaction` is called once with every field explicit.
  - The returned hash is accepted only when the quorum shows the mined transaction, re-encoded to that hash, from that
    sender, with exact to/data/value/nonce/chain/type. Fee edits are accepted within the caps and reported.
  - A different transaction is DETECTED and reported, not prevented. That is weaker than sign-only, and the docs say so.
- **Handoff.** For MetaMask or any wallet without an endpoint: the exact transaction is printed, and
  `signer attach <id> <hash>` confirms it.
- **Messages and typed data.** `personal_sign` / Clef `account_signData`, and `eth_signTypedData_v4` / Clef
  `account_signTypedData`. Each signature is recovered and must come from `--from`. Typed data for another chain is
  refused before the wallet is asked.
- **No silent selection.** `--from` is required and must be in the signer's account list. The wallet's chain must
  match.
- **Transport.** The shared URL policy (https, or http only on loopback; no credentials or fragment), redirects
  refused, a 1 MiB response cap, deadlines on every request, and never a retry. Errors carry scheme, host and port
  only, with wallet error URLs redacted.
- **Unknown outcomes.** Each transaction is a durable 0600 intent, and an unresolved intent blocks new sends from that
  account. Settling is explicit:
  - `signer resolve`: an agreed receipt, or with no hash a binary search by nonce inside one agreed snapshot;
  - `signer rebroadcast`: the same bytes again, never re-signed;
  - `signer attach` and `signer abandon`.
- **Capabilities.** Clef's facts come from the local go-ethereum v1.13.5 source; anvil's were probed. Frame is not
  verified (the docs fetch was not permitted); `auto` decides at run time. MetaMask has no CLI endpoint, so it uses
  handoff.
- **Finding.** Clef serves only `account_*`, so the existing non-independent `--signer` (`eth_sendTransaction`)
  cannot have worked with Clef.

## Patched-CLI diagnosis (the 1/3 → 3/3 fix)

- **Evidence.** In both failing cases the command succeeded: exit 0, `✓ funded (tx …, confirmed by 2 RPCs)`, and the
  nonce advanced by 1. Only the stderr assertions failed. stderr lacked the `signed <hash> (intent …)` line, and in the
  auto case it lacked the fallback announcement.
- **Cause, an implementation bug.** The `sendQuorumTx` hook passes the CLI's `log` (the `-x` trace, silent by
  default). `send()` let that override the signer's own log, so the fallback to the weaker path was silent in the real
  CLI. The interface forbids that.
- **Fix.** These user-facing notes now always go to the signer's own log (stderr `signer: …`), and to the caller's log
  as well. The assertions were right; they were not changed.
- **Regression.** The module tests now call `sendQuorumTx` with a separate or silent caller log, as the hook does.
  Negative control: the same two tests fail against the old module (`39f97c42…`) with exactly those messages, and pass
  on the fixed one.

## Tests actually run

Every run used `systemd-run --user --scope -p MemoryMax=512M -p MemorySwapMax=0`, in the foreground, under
`timeout`, with `--test-concurrency=1`. MaxRSS is the test runner's; the scope cap covers the anvil children too.

| suite | source | result |
|---|---|---|
| `test/cli-independent-signer.test.mjs` (real anvil chain via QuorumChain; a separate signer anvil behind fixtures) | fixed module `d6eb8771` | **13/13 pass, exit 0**, maxRSS 109,496 KB |
| negative control: tests 4 and 9 of that suite, in the scratch tree | old module `39f97c42` | **0/2, exit 1**, as expected |
| `cli-independent-signer-cli.test.mjs`: the PATCHED `cli/enclave.mjs` as a subprocess, anvil chain 8453, two RPC origins (anvil plus a forwarder) | scratch tree `/tmp/signer-integ/tree`: patched files as above, module `d6eb8771` | **3/3 pass, exit 0**, maxRSS 93,496 KB |

What the patched-CLI run covers:
- `host fund` signed through `--signer` (one `eth_signTransaction`, no chain-state calls to the wallet, nonce +1,
  exact balance change);
- `signer list --json` (confirmed, raw hidden);
- sign-mode refusal of a broadcast-only wallet;
- auto fallback, announced, with one `eth_sendTransaction`;
- `--from` required, and `--signer-mode` without `--independent` refused;
- handoff JSON, then the busy guard, the user's own send, and `signer attach` confirmed.

The scratch tree holds the CLI's static import closure (92 files) copied from the working tree, plus a node_modules
symlink. It was built by a fresh `git apply` of the three patches; the hashes are identical.

## Process notes (honest)

- In the previous session, one patched-CLI run started at 17.8 GiB free, below the 18 GiB start floor. It was a
  failed import (a missing scratch file), about 110 MB. Every run since was gated on ≥ 18.0 GiB; one wait of about
  30 s was needed.
- The previous module-suite passes (13/13) were before the fix. They were re-run because the source changed.

## Remaining blockers / limits

1. **Coordinator integration.** Apply the three patches to the then-current `cli/enclave.mjs` and
   `cli/independent.mjs` (owned by the move/CLI worker), and move the CLI test into `test/`.
   - If those files changed since the bases above, the patches need rebasing. The edits are small: a flag, `loadKey`,
     `configureIndependent`, the `signer` command, the help text, and a two-line hook.
   - `test/cli-independent.test.mjs:273` (`ls --signer http://127.0.0.1:1` must fail matching `/--signer/`) should
     still pass, because the failure becomes "--signer needs --from". It was not run here.
2. **Not tested with real wallets.** No Frame, Clef binary, MetaMask, Ledger or Trezor was used; there was no live
   wallet interaction. Fixtures stand in, built on real anvil-signed bytes. Frame's `eth_signTransaction` support is
   unverified.
3. **Archive data for old ranges.** Resolving an unknown outcome without a hash binary-searches historical
   `getTransactionCount`. Public RPCs without archive state may refuse ranges older than their state window.
4. **No browser page for handoff.** MetaMask's handoff page ("send this prepared intent" plus hash copy-back) belongs
   to the browser worker. Today it means pasting the printed parameters into a wallet or `cast send`.
5. **Wallet-send remains weaker by nature.** A broadcast-only wallet can send a different transaction; the CLI detects
   and reports it but cannot prevent it.
6. **EOAs only.** ERC-1271/Safe accounts as `--from` are out of scope here; the Safe path is the session-grant flow.
7. **Non-independent `--signer` is unchanged.** It still cannot sign messages and still uses `eth_sendTransaction`.
   That is outside this scope.
