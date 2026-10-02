# TUNA application transport

Enclave uses the official NKN TUNA SDK for provider discovery, encrypted transport,
port allocation and native NKN NanoPay payments. Nan continues to run the control API,
ledger/attestation checks and certificate orchestration. Its fleet tunnel carries
control requests only. Application bytes travel between the TUNA provider and the
host adapter, then through the existing local application ingress. Guest TLS keys
stay in their application guests.

The adapter runs beside the Metal control CVM or Windows node. It accepts TLS on
loopback port 443 and routes SNI to the host's existing `/x/:id/https` WebSocket
handler. Loopback port 80 redirects admitted app names to HTTPS; TUNA allocates
both public ports on the same provider. On Windows, use the node agent with its loopback upgrade handler enabled;
`upstream` is normally `http://127.0.0.1:9600`. Metal normally uses port 18080.
The public provider must allocate ports 443 and 80. Raw TCP/UDP use separate TUNA reverse
allocations with random public ports; the published mappings contain both the
application's logical port and the actual public port. SSH uses such a TCP mapping.

The Node adapter only performs local routing and lifecycle management. It does not
implement another public relay protocol. The small Go executable wraps the pinned
upstream TUNA SDK. It reconnects and reports allocations over local stdin/stdout.
A TUNA SOCKS entry listens on loopback 30489 for outbound traffic. Supervisors can
set `TUNA_SOCKS_UPSTREAM=socks5://HOST_GATEWAY:30489`; `egress.js` retains tenant
credentials and blocks private destinations, then uses this standard SOCKS upstream.
Existing guest images must be updated/configured before their outbound traffic uses
that entry. Starting the sidecar alone changes no guest's outbound routing.

For the separately maintained native Linux host runtime, `native-guestd-tuna.patch`
adds `guestd -egress-socks 127.0.0.1:30489`. Apply it to the full host source tree
(validated against `e56b5b76f`), run its Go tests and rebuild guestd. It keeps the
guest CID admission, rate limits and public destination checks, sends the judged
IP literal through SOCKS, and never falls back to direct outbound connections.
The production baseline was reproduced byte for byte before applying the patch:
`guestd.model-ram-61e2d31ce65e`, SHA-256
`61e2d31ce65eb51bbe03a968fa30c8539a6db7a64396b8062bd19c6b14061503`.
Use `-adopt-check` with the exact existing launch arguments before switching the
host manager; guest images and their attestation measurements do not change.

## Build and configure

Run `npm ci`, then `node network/build.mjs /path/to/output` with Go 1.23 or newer.
The output contains the bundled Node agent, Linux and Windows binaries and a
Dockerfile. `docker build -t enclave-tuna:VERSION /path/to/output` creates the Linux
runtime. Node 22 or newer runs the same bundled agent directly on Windows.

Create one wallet per host with `enclave-tuna --init-wallet /private/path/nkn.seed`.
The command prints only the native NKN address and refuses to overwrite a wallet.
Fund that address with **native NKN**, not the Ethereum ERC-20 token. Store the seed
with owner-only access and keep it out of the repository. On Windows, restrict its
ACL to the service account, SYSTEM and Administrators.

Copy `config.example.json` and set the registered endpoint, local upstream, wallet
seed path and operator key path. Metal can instead use `operatorConfigFile` pointing
at its existing launcher config. The registry operator signs route publications;
this does not require or expose tenant TLS keys. `maxPrice` is the maximum native
NKN/MiB (one value for both directions, or `upload,download`). `minBalance` prevents
connecting an unfunded wallet. Bound spending by the wallet's funded balance.
RPC endpoints are explicit, replaceable bootstrap peers; discovery uses NKN's
subscription registry rather than an Enclave provider directory.

Run `node agent.mjs --config /private/path/config.json`. Keep the process supervised
and allow it to bind loopback 443 and 80 (Linux needs NET_BIND_SERVICE). A container uses
host networking to reach the local CVM forward, read-only mounts for config and
keys, and a writable status directory. Include system CA certificates for HTTPS
RPC endpoints. The seed must remain readable by the container's service identity.
Never mount the Docker socket or tenant guest files into the adapter.

## Publication and failover

The host signs `enclave-tuna-route:v1\n` followed by its publication's exact JSON.
Nan checks the currently registered operator. Publications expire after 60 seconds,
are refreshed every 10 seconds, and cannot replay an older expiry. DNS reads
`/v1/network/tuna`; it never falls back to retired Enclave relay addresses. Effective
expiry is bounded by the deployment lease and, for Shield hosts, app evidence.
The adapter also consults this admission map and closes connections when admission
expires. Local tenant ingress still checks the running deployment and declared port.

Provider disconnects withdraw the allocation. Reconnection can change both IP and
raw port. HTTPS clients should use the app hostname; custom domains should CNAME
that hostname where supported. A custom domain pinned to an A/AAAA record must be
updated on allocation changes. TLS remains end to end, but TUNA does not promise a
dedicated IPv4, preserved visitor IP, Enclave relay traffic logs or fixed raw ports.

## Production migration

1. Add the signed publication endpoint on Nan while preserving its current control
   and attestation changes. Install the Windows local upgrade handler and adapters.
2. Fund wallets and wait for real `ready` allocations. Test each running app through
   its assigned IP with the correct hostname and verify guest attestation. Test raw
   TCP/UDP and outbound SOCKS before claiming those paths work.
3. Publish DNS and custom-domain changes only after every running app is verified.
   Keep rollback copies of active files and the previous DNS answers.
4. Switch Nan to control-only forwarding, stop and disable the retired
   `enclave-{tcp,tcp6,udp,egress}-relay` and `enclave-relay-agent` services. Keep
   `enclave-api-relay` on Nan and `enclave-dns` on the authoritative DNS host.
5. Confirm public application responses and attestation again after the old data
   services stop. Updating the repository or starting an unfunded adapter alone
   does not complete this migration.

Deploying an operator's own TUNA provider is a separate operation. It can join the
same NKN subscription network; it is not an Enclave fleet-tunnel relay.

## Production verification, 2026-10-02

The six running deployments (EyesOff-AI, RISC Box, s3-ipfs-adapter,
ipns-publisher, jot and api-mcp-adapter) were switched to TUNA. Canonical app
DNS uses the live allocation map; eyesoff.ai follows its canonical app CNAME.
Public HTTPS, readiness and HTTP redirects were checked after disabling the old
data services on nan-relay and us-west. Nan remains the control API and nan-relay
continues authoritative DNS. Configuring us-west as a TUNA provider is deferred.

The four Linux guests passed fresh SNP signature, nonce, TLS-key, deployment,
runtime and measurement checks. Windows public probes checked their nonce, TLS
key, AppID and runtime; Nan separately reverified the authenticated host and app
evidence. Guest VMs and TLS keys survived the host-manager/control updates.
Native Linux outbound connections now use the loopback TUNA SOCKS entry.

Paid raw TCP echo and SOCKS HTTPS passed. Raw UDP echo timed out on three public
providers, so UDP is **not production-validated**. None of these six deployments
declares raw UDP ports. One initial HTTPS provider disconnected; the adapter
withdrew its allocation and connected to another. Provider IPs are therefore
dynamic, and this rollout does not establish a dedicated-IP or uptime guarantee.

The main unit CI job still has measurement/scheduler and timeout failures;
targeted transport checks, native egress race tests and guest-manager tests passed
(the two Node-backed guest-manager tests were rerun after installing dependencies).
