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

For hosts with the newer `public-web` runtime, use
`native-guestd-public-web-tuna.patch` instead. It adds per-app routing to the
current HTTP/HTTPS dialer and browser DNS service; both fail closed without a
valid app route. The source snapshot before this patch reproduces the production
`guestd.public-web-922dad14e656` binary exactly (SHA-256
`922dad14e65691a1bbccd2d1cabaf02c7f49c38de973e7b44dae781d5582c63c`).
Build with `CGO_ENABLED=0 GOEXPERIMENT=nodwarf5 go build -trimpath -buildvcs=false
-ldflags='-s -w -buildid='`. The patched manager passed the adoption preflight for
all four live Linux guests. This patch does not require a guest image change.

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

## Per-app privacy transport (version 2)

The version 2 agent is being integrated; the production migration above still
uses version 1. Do not infer a completed privacy rollout from these modules or
from the canary results below.

`privacy-agent.mjs` manages two circuits for each deployment. Each circuit has
separate funded guard, public-ingress and egress identities. The public and egress
processes run behind a guard in a container with an outbound firewall, no Linux
capabilities and only that app's IPC broker. Guard/public separation and separation
between sibling circuits require different payment beneficiaries and ASNs. That
is a diversity heuristic, not proof of independent corporate ownership.

Authorization runs independently of allocation work: two recent, agreeing Base
RPC snapshots and a fresh guest proof are required. Neither a failed refresh nor
a stalled allocation extends authorization. On Linux, `GuestdIngress` uses the
existing authenticated guest-manager protocol and verifies the expected app,
runtime and launch measurement before opening the app's data socket. The control
CVM is not in that path. The pairing key stays in the agent, outside workers.

Default policies require two guarded routes and prohibit direct fallback. Custom
provider allow/prefer/deny lists require a deployment-owner signature. Funds are
bounded by six distinct role wallets; the agent refuses shared identities and
manifests exceeding the app's budget. The public-role wallets also fund their NKN
discovery subscriptions (0.001 NKN per registration). Automatic wallet top-ups are
not implemented.

An operator delegates an Ed25519 route key to one deployment. Route records and
IPNS pointers carry durable sequence numbers, short expiries and the policy hash.
Each circuit serves the signed pointer and CID-addressed block over NKN messaging;
the NKN subscription topic is `enclave.route.v2.<64-character-deployment-id>`.
The subscription is a locator, never authorization. Clients verify the pointer,
block hash, runner delegation, fresh lease and replay floor independently.
Optional delegated IPNS publication follows the
[IPFS HTTP routing protocol](https://specs.ipfs.tech/routing/http-routing-v1/).
A raw-block gateway reader is included; a production IPFS block-storage backend
and automatic NKN subscription renewal still need integration.

`native-route-client.mjs` resolves the full deployment ID through NKN. It can
connect without DNS, SNI or a CA-issued application certificate: it authenticates
fresh hardware evidence first, then pins that attested TLS key **before** sending
an application request. This requires explicit trusted app/runtime/measurement
policy. Ordinary browsers continue to use HTTPS names and CA certificates.

The optional Nan mirror accepts verified version 2 records and gives DNS both
current addresses. After an app migrates, a persistent replay floor prevents
falling back to its old shared host route, including after mirror restart.
Mirror failure does not revoke native serving authorization. Authoritative DNS
itself remains a compatibility service; native discovery is the independent path.

`native-guestd-tuna.patch` additionally implements `-egress-app-routes FILE`,
mutually exclusive with the earlier shared `-egress-socks` flag. The agent writes
`egress-routes.json`; guestd binds guest CID to deployment ID itself. DNS and TCP
both travel through that app's circuits, and either a DNS failure or a subsequent
TCP failure can try its sibling. Missing/expired maps, private DNS answers and
cross-app proxy reuse fail closed. Rebuild against the **currently deployed** host
runtime, preserving its other changes, before using this patch in production.

The Windows helper installs persistent WFP rules for private executables and the
entire AppContainer SID, including unlisted child programs. Its sandbox launcher
creates the worker suspended, verifies the package identity and low integrity,
removes every privilege except directory traversal, checks that no capability
was granted, and resumes it in a kill-on-close job. The private directory is read
only to that SID, with one writable state directory. The parent environment is
replaced by a small Windows system-path allowlist. Its loopback exemption is
limited by the circuit's exact WFP permits. A live NucBox canary passed the guard,
other-app, IPv4/IPv6, other-app-file and state-directory checks. Full Windows
runtime orchestration, independent Shield proof collection and per-guest outbound
integration remain rollout gates.

### Live validation on 2026-10-02

* Twelve simultaneous public 443 allocations passed TCP echo tests; stopping the
  guard closed all twelve, with no unexpected outbound IPv4 packets captured.
* EyesOff served HTTPS through two circuits on four different ASNs, with fresh
  SNP/AppID/runtime/TLS-key verification. HTTP 80 redirects also passed.
* The integrated agent published both signed routes through NKN. Killing one
  guard caused a separate client to resolve only the surviving route.
* A native client resolved EyesOff via NKN and received `/ping` HTTP 200 without
  Enclave DNS, Nan or SNI, after fresh attestation through guestd's data socket.
* A delegated public IPNS router accepted the signed pointer; readback verified
  its signature and CID.
* Native Linux egress passed real DNS and HTTPS through an app circuit. A test
  proxy that forwarded DNS but rejected destination TCP caused the same app's
  sibling to succeed; an unbound guest was refused.

These canaries did not change production DNS or guest egress configuration. The
remaining rollout includes full provider inventory refresh/selection, standalone
control bootstrap, owner-facing controls, Windows integration and deployment-wide
failure tests. Linux runtime rebasing and adoption preflight passed. Discovery
subscriptions renew before expiry; the signed renewal transaction is persisted
before broadcast and retried unchanged after ambiguous RPC responses. An exited
discovery helper withdraws its circuit. Allocation and health checks run
independently per app, with public ports reserved across concurrent allocations.

Each Linux guard now runs in a read-only container as UID 1000 with no
capabilities and only its own guard configuration/seed mounted. It uses host
networking to reach the public NKN/TUNA network, binding its local SOCKS listener
only to the private bridge gateway. Public/egress workers retain their separate
firewalled network namespace; they can reach only their assigned guard endpoint.
