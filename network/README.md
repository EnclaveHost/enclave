# Application networking: the Enclave network

Every public app reaches the internet, and is reached, through the Enclave network: WireGuard circuits through
qualified providers, the owner's own WireGuard peer, or direct hosting on a host's own qualified public address, as the
owner's signed v5 network policy says. TLS ends inside the enclave; providers route raw TCP by SNI. The design is
`docs/design/enclave-network.md`; what is deployed and tested is `docs/design/enclave-network-status.md`.

TUNA (NKN) was retired on 2026-10-13 and its code removed: hosts refuse a configuration without `enclaveNetwork`, and
the relay refuses route publications that are not under a v5 policy.

## Pieces

| Piece | Files |
|---|---|
| Host privacy agent (admission, circuits, route publication) | `privacy-agent.mjs`, `enclave-network-host.mjs`, `wg-manager.mjs`, `wg-circuit-runtime.mjs`, `wg-control.mjs`, `wg-grants.mjs`, `route-publisher.mjs` |
| Circuit ingress worker (SNI gate, one per circuit; the name is historical, Linux runs it too) | `windows-circuit-worker.mjs`, `app-ingress.mjs`, `app-redirect.mjs`, `broker-client.mjs`, `app-broker.mjs` |
| WireGuard-in-WireGuard circuit process | `wg/` (Go, `enclave-wg`) |
| Windows circuit sandbox (AppContainer + WFP, tunnel mode) | `windows-firewall/` (Go, `enclave-circuit-firewall.exe`) |
| Provider daemon and qualification checker | `wg-provider/`, `../scripts/network/wg-qualify.mjs` |
| Policies, provider records, routes | `network-policy*.mjs`, `provider-directory.mjs`, `route-record.mjs`, `owner-signature.mjs` |
| Direct hosting (v5 `direct`) | `direct-runtime.mjs`, `direct-egress.mjs`, `traffic-meter.mjs`, `provider-qualification.mjs` |

## Build

`node network/build.mjs /path/to/output` (Node 22, Go 1.23 or newer) writes the bundled privacy agent, the circuit
ingress worker, the provider daemon (`wg-provider.mjs`), the checker (`wg-qualify.mjs`), `enclave-wg` for Linux and
Windows, and `enclave-circuit-firewall.exe`.

## Run

`node privacy-agent.mjs --config /private/path/privacy-config.json`. The configuration (version 2) names the apps (their
expectation files and names), the host's measured platform (`linux`, `shield` or `pvm`), the chain RPCs and
`enclaveNetwork`: `{relay, checkers, apps: "all" | [ids], control, wgBinary, nodeBinary, workerModule, firewallBinary
(Windows), direct (optional: address, qualificationFile)}`. Settings left over from TUNA (`nknRpc`, `inventory`,
`control`, `runtime`, `defaults`, `tunaUSDC`, `currencyManagement`, the top-level `connectivity`/`direct` of TUNA-era
direct hosting, and per-app `walletsFile`/`ownerPolicyFile`) are ignored.

Routes are published to the relay's `/v1/network/tuna` (a historical path) as signed per-app records; DNS answers with
both exits of an app's circuits.
