# The `enclave` CLI

One file, wallet-native; your wallet is your account. Every command maps 1:1 onto the
[public API](https://enclave.host/#api) and the on-chain contracts on Base;
full reference in the site's [Develop → CLI](https://enclave.host/#cli) chapter,
or `enclave help`.

```
enclave key new                      # bring a wallet; fund it with USDC on Base
enclave login                        # …or sign in with your Enclave account (passkey):
                                     # approve a link from your phone/browser; then ls,
                                     # whoami and account read your credit deployments
enclave publish app.wasm --slug hello-world
                                     # add --fee <$/hr> to charge deployers an hourly
                                     # publisher fee, paid straight to your wallet
                                     # (capped on-chain; immutable per version)
enclave deploy hello-world:1 --fund 2  # create + fund $2 + wait for live; prints the URL
                                       # (a paid app's publisher fee shows in the rate)
enclave attest 0x3xk9…               # verify the enclave locally BEFORE sending data
enclave logs 0x3xk9… -f
```

## Install

Needs node ≥ 20 on every platform.

```sh
curl -fsSL https://get.enclave.host | sh          # Linux/macOS, no checkout needed
```

```powershell
irm https://get.enclave.host/install.ps1 | iex    # Windows, no checkout needed
```

The hosted one-liners fetch the source tarball of this repo from GitHub and
build the CLI locally; no prebuilt binary is downloaded. From a checkout the
same scripts run directly:

```sh
./cli/install.sh           # Linux/macOS: one ~1 MB file -> ~/.local/bin/enclave
```

```powershell
.\cli\install.ps1          # Windows: %LOCALAPPDATA%\enclave\bin + `enclave` shim (+ user PATH)
```

```sh
cd cli && npm install && npm install -g .   # any OS: npm makes the platform shims itself
```

(npm symlinks a local-directory global install, so the deps have to exist in
`cli/node_modules`, hence the `npm install` first.)

Dependencies are pinned in `cli/package-lock.json`; the installers use `npm ci`
(exact locked versions) rather than resolving the caret ranges fresh: this is a
key-holding binary, so its supply chain is locked, not floated.

or run it straight from a checkout (`node cli/enclave.mjs …`; deps resolve
from the repo's `node_modules`). Both installers share `cli/build.mjs` for the
esbuild bundling step.

On Windows the key file lands in `%USERPROFILE%\.config\enclave\key` (override
with `XDG_CONFIG_HOME`); note the 0600 tightening is a POSIX permission; on
NTFS the file is only as private as your user profile.

## How it holds your trust

- **Key** (`~/.config/enclave/key`, 0600, or `ENCLAVE_KEY`): never leaves the
  machine. API auth signs a one-time SIWE challenge; create/fund/publish sign
  Base transactions locally and broadcast to `--rpc`.
- **Account sessions** (`enclave login`, passkey users): the platform's device
  flow — the printed link/QR carries only a short-lived code; the claim secret
  stays in this process, and approval happens in your own signed-in browser.
  The resulting token reads your account's deployments and credit; it can never
  sign transactions (that stays with the key), and `enclave logout` discards it.
- **Payment**: `fundWithAuthorization` is an EIP-3009 `ReceiveWithAuthorization`
  signature over USDC, its nonce bound to the deployment id's first 16 bytes, so
  the money can land on that deployment's balance and nowhere else.
- **Attestation**: `enclave attest` runs Tinfoil's verifier *locally* (hardware
  quote → vendor root, Sigstore code provenance, measurement match, TLS
  binding) and exits non-zero on FAIL.
- **No hidden traffic**: any command run with `-x` prints every REST call and
  transaction before it is sent, ready to replay with `curl`.

## Sessions (agents, no wallet key)

A session is a key the owner's wallet approved once, under a policy the owner's
SessionVault enforces on-chain (actions, apps, environments, budget, expiry).
`enclave session new --preset …` prints the approval link; `status`, `list`,
`use`, `terminate` and `top-up-link` manage it.

With a session active (or `ENCLAVE_SESSION` set), these commands act **through
it** instead of the wallet: `publish`, `deploy`, `fund --usdc`, `upgrade`,
`resize`, `config set|clear`, `stop`, `resume`, `rate-cap`, `refund`. A refusal
prints its code and the next step and never falls back to the wallet key;
`--wallet` uses the wallet for one command.

They reach the deployments the session's **vault** holds and, once the owner
allows it, the ones the owner's **wallet** holds. To a session a wallet-held
deployment is always production:

| Command | Wallet-held deployment, through a session |
|---|---|
| `stop`, `resume` | yes |
| `resize` | yes (under a live lease it may not raise the host's rate) |
| `fund --usdc` | yes; the refundable escrow is credited to the wallet. A paid app must be named in the grant (`--app`), at the catalog's own fee, within the grant's fee ceiling |
| `rate-cap` | lower only; raising it is `--wallet` |
| `refund` | yes; the ledger pays the wallet |
| `upgrade`, `config set\|clear` | never: "a session can't change what a production app runs" (`--wallet`) |
| `transfer` | never |

Only a grant that covers `prod` reaches them; a staging-only agent is refused.

```
enclave session delegate             # the OWNER, with the wallet: one ledger transaction,
                                     # setDelegate(vault, true)
enclave session delegate --status    # supported / granted; no key needed
                                     # (--owner 0x… to ask about another wallet)
enclave session delegate --revoke    # setDelegate(vault, false): every session of the
                                     # vault loses the wallet's deployments at once
```

`session delegate` is signed like any wallet transaction here (the key file,
`ENCLAVE_KEY`, `--signer`, or `--unsigned --from`) and is never relayed. The
ledger is the one the on-chain address book names as `deployments`, never a
baked address. The vault is `vaultFor(owner)` at the book's
`sessionVaultFactory`, or the v2 factory pinned in `DEFAULTS` while the book
names none. `--status` reads the ledger's storage and falls back to the
sessions relay (`GET /v1/sessions/owner/<addr>`) when the chain can't be read.
Until the owner delegates, a session acting on a wallet-held deployment is
refused with `delegation` and told to run `enclave session delegate`.

Contract addresses are pinned in `enclave.mjs` (`DEFAULTS`) and kept in
lockstep with the enclave configs by `scripts/sync-contract-addresses.sh`.

Tests: `node --test test/cli.test.mjs` from the repo root: an offline double
of the platform (stub API with real SIWE verification + stub Base RPC that
decodes the CLI's actually-signed transactions). `node --test
test/cli-session.test.mjs` runs the session commands and `session delegate`
against the real sessions relay, SessionVault and ledger on anvil (needs Foundry).
