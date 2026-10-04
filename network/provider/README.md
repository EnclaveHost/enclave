# us-west TUNA provider

These units host the standard NKN TUNA provider protocol. The reverse service
offers public TCP/UDP port allocations; the forward service offers TCP SOCKS5
through a loopback-only Dante instance. Neither service implements Enclave's old
relay API. Both advertise the same provider identity and beneficiary, so clients
can recognize them as the same operator.

## Current installation

Host: `us-west` (`5.78.85.108`, `2a01:4ff:1f0:ea2f::1`). Ubuntu 26.04.
TUNA source is pinned to `nknorg/tuna` commit
`7e0f776a7c3bf30d7d932defd15383bf5143c4b8`, matching the upstream revision used
by the Enclave clients. Build with:

```sh
CGO_ENABLED=0 go build -trimpath -buildvcs=false \
  -ldflags='-s -w -X main.Version=7e0f776-us-west' -o tuna ./cmd
```

The binary is `/opt/tuna-provider/tuna`; the installed SHA-256 is
`455c6514af0a95ad861b2f4aa6b71d6cd5e2e3b76dbec6b1db9d9bc4720479ef`.
Dante is Ubuntu's `dante-server` package, version `1.4.4+dfsg-1build1`.

Both public services are active and enabled on boot as of 2026-10-02. The old
Enclave relay services remain disabled. The provider identity is
`119f60a60d323d4bf689e610cbd97fc7f4eec769b33dd8ed2d736cb891569c46`.
Revenue is paid to `NKNNBs8F14nnfH4RZvKfM9PB5MVT7w87AgMn`, whose spending key
is kept off us-west. Its separate operational wallet is
`NKNJmMyrYdDscEHwBNfmer7EysiHL1N1rN2V`, initially funded with 0.05 NKN
(plus 0.001 NKN transfer fee).
The collection wallet received a confirmed 0.012838 NKN payment from the
synthetic traffic test. This is test funding, not third-party revenue.

Live acceptance passed reverse TCP echo on ports 80 and 443 through an
independent guard; reverse UDP echo (five of five replies); public HTTPS through
paid SOCKS; and a SHA-256-verified 40 MiB echo payload (80 MiB of billed traffic).
SOCKS refused loopback, private networks, metadata, and the server's own
IPv4/IPv6. An unauthorized local user could not access the proxy.
RISC Box automatically selected this provider as its second public route; its
`/ping` returned HTTPS 200 when explicitly routed through `5.78.85.108`.

## Configuration and activation

Create system accounts `tuna-provider` and `tuna-proxy`. Store the provider's
encrypted operational wallet and password in `/etc/tuna-provider/identity`,
readable only by root and `tuna-provider`. Keep a local backup. The operational
wallet pays subscription fees; its key need not be the beneficiary's spending
key. The beneficiary is a separate native NKN wallet kept off this server.

An Ethereum `0x...` address cannot receive native NKN payments. The requested
eventual Ethereum destination is
`0x0b2d009c0c9Af05b12100D77F3c815fea822eE61`; this is not a TUNA beneficiary.
No automatic conversion is configured or promised.

Render configuration using the selected native beneficiary:

```sh
python3 render-config.py --beneficiary NKN_NATIVE_ADDRESS \
  --ipv4 5.78.85.108 --ipv6 2a01:4ff:1f0:ea2f::1 --output ./config
```

Install config under `/etc/tuna-provider` and the units under
`/etc/systemd/system`. The upstream CLI validates the native address checksum.
Price is `0.0002` NKN per TUNA traffic unit (1 MiB); subscription fee is `0.001`
NKN, duration 40,000 blocks, with separate reverse and SOCKS subscriptions.

Validate using `nft -c -f /etc/tuna-provider/proxy.nft`,
`danted -V -f /etc/tuna-provider/danted.conf`, and `systemd-analyze verify`.
Start reverse first, confirm its public subscription, then start forward to avoid
concurrent initial subscription transactions from the shared operational wallet.
Confirm both subscriptions have the same identity, public IP, price and beneficiary.
Fund only a small operational balance and record signed transfers before broadcast.

Public protocol ports: TCP 30020 / UDP 30021 for reverse, TCP 30010 / UDP 30011
for forward. Reverse clients also allocate public service ports, including 80/443.
One public IP can have only one active allocation of a particular TCP port.
SOCKS on 127.0.0.1:30489 is never public. Only root and the TUNA provider uid may
reach it; the proxy uid cannot initiate connections to private, reserved or local
destinations or SMTP port 25. Rules apply to resolved IP addresses as well.

Before enabling on boot, verify reverse echo on both 80 and 443, outbound HTTPS
through the paid forward service, and the destination restrictions through TUNA.
Do not change Enclave provider diversity rules or pin apps merely to test this host.

## Stop

Disable and stop `tuna-reverse`, `tuna-forward`, and `tuna-socks`. The nftables
table affects only the proxy uid and local proxy access; it does not alter SSH.
It can be removed with `nft delete table inet tuna_proxy` after stopping the proxy.
Existing NKN advertisements expire on-chain; a stopped provider cannot accept
allocations. Do not re-enable the retired Enclave relay services as part of this
operation.

## Per-app warm fallbacks

Every enrolled fleet app reserves its own TUNA reverse port pair on us-west.
`sync-fallback.mjs` allocates stable, non-reused pairs in 20000–29999 across both
host agents and validates the generated HAProxy configuration before changing
an agent. The `tuna-web` service holds ports 443 and 80. Port 443 uses HAProxy
TCP mode and forwards the original encrypted TLS stream, selected by SNI, to
that app's TUNA port. It has no app certificates, no private app keys, and no
TLS termination. Port 80 forwards to the app's own HTTPS redirect listener.

Each app retains separate public, guard and egress wallets in each circuit.
The fallback still has to satisfy price, owner exclusions and network/operator
independence. The primary remains first in signed discovery and guest egress.
DNS includes the fallback only while no healthy primary is published. A signed
`directPort` lets native clients reach the same guest without sending SNI.

On Windows, `shield.ingress` points the trusted privacy agent at the literal
loopback partition manager (`http://127.0.0.1:8091`) and its data plane
(`127.0.0.1:8092`). The broker is bound to a deployment; its route must match
that deployment's app, runtime and independently verified TLS key. Ciphertext
is sent to that partition directly. The shared node ingress continues to require
its existing hostname gate. No guest image or admission policy was changed.

The fleet's `enclave-tuna-fallback-sync.timer` runs once a minute under the same
lock as the app reconcilers. Once a new app is enrolled, its fallback pair and
frontend mapping are provisioned automatically. Existing wallet keys and guest
secrets are neither read nor copied by this job. A stopped frontend is restarted
when its listener ports are free. Allocation state is kept under the operator's
`enclave-prod/tuna-privacy/fallback` directory, with backups before rollout.

## USDC transport release (not yet activated)

`network/build.mjs` builds `enclave-usdc-provider` and the bundled
`tuna-provider-control.mjs`. The new provider negotiates USDC inside the encrypted
NKN connection and advertises on `enclave_usdc_v1.*` topics. Legacy providers
cannot negotiate it. Application streams are metered independently at both ends;
control frames are excluded. The runner submits a receipt signed by both the
runner and provider. The ledger credits the actual provider operator and the
platform using the split snapshotted by the owner's authorization.

The example JSON files intentionally contain required placeholders. Install keys
and configuration under `/etc/enclave-tuna-usdc`, mode 0600 and owned by
`tuna-provider`. Use a separate native transport seed from the legacy provider.
The proof key must match the provider's registry entry. Generate a 32-byte random
hex control token and share it only with these two local services. Never place a
provider proof key in an app worker, browser, advertisement, or customer config.

The systemd units use separate transport ports and the existing restricted
loopback SOCKS service. They do not take over HAProxy, public 80/443, legacy TUNA,
or live app routing. Paid reverse allocations require public ports that are free
and reachable. Multiple apps sharing an address still need a TLS-passthrough
frontend with per-app port allocations; a single provider IP does not create
additional independent routes. The current strict two-route policy requires at
least four qualifying operators on separate networks, with USDC transport support.

Activation requires a schema-16 ledger with backed app balances, its bound
connectivity contract, an active registered provider, current qualification,
and a matching advertised rate. The qualification implementation currently uses
a governance-maintained probe-signer allowlist; it is not permissionless
qualification. Do not describe a production deployment of it as having removed
that trust dependency. Owner authorizations, operator diversity, real forward and
reverse transport, TLS verification, receipt settlement, and revocation must pass
before switching customer traffic.

`maxPending6` is credit the provider is willing to lose on revocation or a failed
settlement (the example allows 0.01 USDC). It is not additional app funding. The
controller stops accepting traffic beyond it. A crash leaves `controller-lock`
in the state directory. Reconcile the durable meters and pending wallet journal
and confirm no controller remains before removing that lock; never automatically
erase counters to restart service.

These payments avoid native NKN for app data traffic. Provider advertisements
still require native NKN subscription fees. Automatic bidirectional native-NKN
conversion remains unavailable until a real executable liquidity route is
configured; an ERC-20 NKN quote is not a native-NKN conversion route.
