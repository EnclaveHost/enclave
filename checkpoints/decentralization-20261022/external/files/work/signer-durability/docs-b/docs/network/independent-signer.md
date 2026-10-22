# External signers in independent mode

`enclave --independent … --signer URL --from 0xADDR <command>` uses a wallet you choose as the **signing authority**.
It is never a source of chain state. The agreeing RPC quorum (`cli/independent.mjs`) supplies the nonce, gas, fees,
simulation and receipts. The wallet only approves. The implementation is `cli/independent-signer.mjs`, and the exact
contract is in `work/independent-signer-interface.txt`.

## Paths

| path | wallets | what the CLI can guarantee |
|---|---|---|
| **sign** (preferred; `--signer-mode sign`, and the first try in `auto`) | Clef (`account_signTransaction`, `account_signData`, `account_signTypedData`), any endpoint with `eth_signTransaction` | Every field of the returned bytes is checked before broadcast: chain, nonce, recipient, value, calldata, gas, both fees, the empty access list, the type, a canonical encoding and a low-s signature. The sender is recovered and must equal `--from`. The **identical bytes** go to every quorum RPC, and one hash is confirmed. |
| **wallet-send** (`auto` falls back to it only when the wallet DEFINITELY answers that it cannot sign; `--signer-mode wallet-send` asks for it directly) | wallets that only offer `eth_sendTransaction` | The wallet gets one fully prepared transaction. The intent is journaled first, and the returned hash is accepted only when the quorum shows it mined with this sender and these fields. Fee edits made in the wallet's UI are accepted within `--max-fee-gwei` and the gas cap, and reported (`exact` refuses them). **Weaker:** the wallet chooses where to broadcast, and a different transaction can only be detected afterwards, not prevented. |
| **handoff** (`--signer-mode handoff`, no URL) | MetaMask, or any wallet without an endpoint the CLI can call | The exact `eth_sendTransaction` parameters (nonce, gas and fees included) are printed and the command stops. `enclave --independent … signer attach <intent> <0xhash>` then confirms the mined transaction the same way. |

The fallback is always announced on stderr. It is never silent.

## Rules

- `--from` is required. The signer's account list must include it, and nothing is ever chosen for you.
- An EIP-1193 wallet's `eth_chainId` must match the quorum's chain before anything is asked of it. Clef refuses a
  request for another chain, and the decoded bytes are checked either way.
- Typed data whose domain names another chain is refused before the wallet is asked.
- Signer URLs follow the shared policy (`network/rpc-identity.mjs`): https, or plain http only on loopback (Frame
  `http://127.0.0.1:1248`, Clef `--http` on `:8550`). URLs with credentials or a fragment are refused. Redirects are
  never followed. Responses are size-capped, and every request has a deadline.
- Messages name a signer by scheme, host and port only. Wallet error text has its URLs redacted.
- Message and typed-data signatures (uploads, encrypted volumes, session grants) are recovered and must come from
  `--from`. Contract (ERC-1271) accounts are not signers here.

## Unknown outcomes

Every transaction is an intent: a file under `--state-dir`/signer, or `~/.config/enclave/independent-signer`. On
Linux and macOS each file is 0600 and the directory is kept 0700. On Windows these modes do not apply; the files take the
access control of the directory they are in. An intent is on disk before the bytes or the request leave the process: it
is written to a temporary file, flushed, renamed into place, and then the directory is flushed. Two cases are best
effort only. On Windows, Node cannot flush a directory, so the renamed file is flushed again and the rename itself
relies on NTFS's own metadata log. Some network and FUSE mounts refuse to flush a directory. While an intent from an
account is unresolved, new sends from that account are refused. Nothing is retried automatically.

Only one send per account runs at a time. Before a send reads the nonce or asks the wallet anything, it takes a
reservation file in the same directory. The file is created exclusively, so this holds across processes. The
reservation lasts while the send's intent is open, and ends when the intent is decided by any command below. A
second send, in this process or another, is refused at once; it never waits. Some cases are not covered:
- Two different `--state-dir`s are two separate journals, so do not point concurrent sends for one account at
  different ones.
- An older `enclave` that predates reservations does not take one.
- Filesystems without exclusive create (old NFS) give no guarantee.

An intent file (`tx-….json`) that cannot be read, or an intent in a state this version does not know, also stops
every send. It may hold an unresolved transaction, so it is never skipped silently.

| command | what it does |
|---|---|
| `signer resolve <id>` | One agreed look. Possible outcomes: confirmed, reverted, mismatch (the wallet sent something else), replaced (the nonce went to another transaction), or still open (the nonce is unused). With no hash, each peer finds the transaction that used the nonce by binary search inside one agreed snapshot. Ranges older than the RPCs' state window need archive-capable RPCs. |
| `signer rebroadcast <id>` | The same signed bytes again (sign path only); never a new signature. |
| `signer attach <id> <hash>` | For a handoff, or an unknown intent without a hash. |
| `signer abandon <id>` | Explicit. The next send reuses the nonce, so at most one of the two can ever be mined. |
| `signer release <reservation>` | Explicit. For a reservation whose send stopped (was killed, or crashed) before it recorded an intent. Unless one of its intent files was set aside with quarantine, such a send broadcast nothing and asked no wallet to broadcast. A signature it may have asked for was never journaled or sent. `signer list` shows the holder's process and host. Refused while an intent holds the reservation; settle that intent instead. If that send is in fact still running, it notices the release once it has recorded its intent, and stops before it broadcasts or asks the wallet to; it does not go on next to a later send. |
| `signer quarantine <id>` | Explicit, after you review the file. Renames an unreadable intent file to `<id>.json.quarantined-<time>`, keeping it. Readable intents are refused (settle them). If the file held an unresolved transaction, the next send reuses its nonce, as with abandon. |
| `signer list`, `signer show <id>`, `signer probe` | Inspect: intents, open reservations and unreadable files. A probe lists accounts and the chain, and signs nothing. |

## Wallet capabilities (what was checked)

- **Clef:** go-ethereum v1.13.5 source.
  - It serves only the `account_*` namespace and never broadcasts.
  - Its UI may edit a request before signing; the field check catches that.
  - The old non-independent `--signer` sent `eth_sendTransaction`, which Clef does not serve.
- **Anvil:** `eth_signTransaction`, `personal_sign` and `eth_signTypedData_v4`, probed locally.
- **Frame:** not verified here. `auto` learns at run time whether it answers `eth_signTransaction`.
- **MetaMask:** browser-only (`site/js/core/wallet.js`), so it uses handoff. A returned hash is not proof of
  broadcast: smart transactions can be cancelled after a hash is handed back.
