# The wallet on a seller's PC

The original ask was "link a wallet through WalletConnect, or generate one, with
lots of warnings that a hardware wallet is much safer." The warnings are the
right instinct, but the protocol makes the problem smaller than it looks --
**there are two keys, and only one of them has to be hot.**

## Two keys, two very different risk profiles

`metal/config.json` carries both, and PROTOCOL.md is explicit about what each
does:

| | `registryKey` | `payoutAddress` |
|---|---|---|
| what it is | an operator EOA private key | a destination address |
| lives | **on the machine**, necessarily | anywhere |
| signs | `register`, `claim`, `renew`, `release` | nothing |
| holds | a few dollars of Base ETH for gas | **all accrued earnings** |
| if stolen | the thief burns your gas and can grief your claims | the thief takes the money |

Earnings accrue on-chain to the operator, and the supervisor sweeps them to
`payoutAddress` once they clear a minimum (default $5). So the money **never has
to sit** on the gaming PC. It passes through a contract and lands wherever the
seller says.

That gives the honest version of the flow the ask wanted:

- **Generate** the `registryKey` locally. It is a gas key. It should hold a few
  dollars and never more. Generating it is fine, and asking a first-time seller
  to hardware-sign every `claim` and `renew` would make the product unusable --
  those are automated, frequent, and unattended by design.
- **Link** the `payoutAddress` with WalletConnect, and push hard for a hardware
  wallet, because that is the address the money goes to. This is where the
  warnings belong, and they can be specific instead of generic.

A generated key that holds nothing is a very different object from a generated
key that holds your earnings. Conflating them is what makes "generate a wallet"
sound reckless; separating them is what makes it reasonable.

## Why the warnings should be concrete

This project has a first-hand incident to point at rather than a hypothetical:
a CLI burner wallet was drained **within seconds** of being funded. Sweeper bots
watch for freshly funded keys continuously. So the copy should say what actually
happens, not "keys can be stolen":

- the generated key is for **gas only** -- fund it with a few dollars, never
  more, and never send earnings to it;
- if malware reads it, it costs you the gas balance and the ability to claim,
  **not** your earnings, provided `payoutAddress` is a wallet this machine does
  not hold the key to;
- a gaming PC is precisely the machine most likely to be running something
  untrusted. That is not an insult to the seller, it is the reason the split
  above exists.

## Reuse, not reinvention

[`site/js/core/wallet.js`](../site/js/core/wallet.js) already implements the
whole WalletConnect path: `EthereumProvider` from the vendored bundle,
`showQrModal: false` with the pairing code rendered locally, a copy-pairing-link
affordance, and a Trezor Suite flow (Suite holds the Bluetooth link to a Safe,
so it signs with no cable and no phone).

That is a browser bundle, so the tray popup should be a **WebView2** window
rather than native controls -- which also means the popup inherits DESIGN.md and
looks like the rest of Enclave instead of like a separate product. The same code
that links a wallet on enclave.host links one here.

One caveat carried over: the site's WalletConnect session is single-tab by
design (a Web Lock arbitrates, so the second tab is told the session is live
elsewhere). A desktop popup that can be opened while enclave.host is also open
in a browser needs to expect that message and explain it, rather than surfacing
it as an error.

## `declare-payout` is worth surfacing in the UI

A seller who publishes their payout wallet on-chain
(`EnclaveRegistry.setPayoutWallet`, one transaction, sent **from that wallet**)
gets their own deployments hosted free on their own box from a rev-12 ledger.
That is a genuinely good deal and it is currently a CLI command
(`enclave host declare-payout`) that a Windows seller will never discover.

It must come from the payout wallet itself -- the operator key cannot send it,
which is exactly what stops a box naming a stranger -- so in a WalletConnect
flow it is a natural second signature right after linking, while the wallet is
already connected. One prompt, at the only moment the user is already holding
their hardware wallet.
