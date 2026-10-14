# Enclave network: status

What is implemented, what is tested and how, what is deployed, and what is still blocked. Updated with each change;
the design is `docs/design/enclave-network.md`. Nothing below is described as working unless it ran.

## Deployed and serving (2026-10-13)

| Piece | Where | State |
|---|---|---|
| Providers (kernel WireGuard + nftables + SNI router + control API) | 4 DigitalOcean Droplets: sfo3 134.199.235.187, tor1 146.190.246.39, sgp1 165.245.191.129, fra1 134.209.248.172 | live, systemd `enclave-network-provider` (bundle of main 9c198fef9, 08:59Z, peers restored, no interruption), all roles, price 0, transfer budget 850 GB/month each |
| Qualification checkers | nan (`enclave-network-checker`, 0x57144c90…) and warden-host (user unit, 0x033bc2b9…), every 4 min each | live (81ed3ebac, with chain access for on-chain attestations); both pass all four providers on all nine checks through WireGuard |
| Relay API (`/v1/network/*`), v5-only route acceptance, DNS label `enclave` | nan (main 418aec41b) | live; TUNA publications and the NKN funding endpoint are gone |
| Network tab (status, privacy, owner-signed mode setting, paid-provider authorization; passkey-vault signing) | site (main 418aec41b) | live |
| NucBox (Windows, Enclave Shield): all apps on the Enclave network, own control traffic on control circuits | nucbox-k11-4 | live; Windows host release 2026.10.12.24 (TUNA-free, paid-provider settlement configured with the box's proof and operator keys; published 02:53Z, installed 02:54Z; every app ready again 03:01Z - a Windows update restarts each Shield partition) |
| metal0 (Linux, SEV-SNP): eyesoff incl. custom domain eyesoff.ai | warden-host | live (release-wg-418aec41bdf7) |
| pVM host agent | warden-host | on the Enclave network (release-wg-418aec41bdf7; serving no app at the moment) |
| EnclaveConnectivity (paid-provider settlement) | Base 0x5f8b636e0768e84bd47b736652030b65db615111 (block 52534480) | ACTIVE since 2026-10-13 03:06Z: ledger `setBandwidthRouter` (tx 0x68dd499d…, block 52535715) and address book `connectivity` (tx 0x0f6ebcb3…, block 52535719), signed on the Trezor 0x0b2d |

Verified in production: every app answers HTTPS 200 through both exits with a valid certificate, the same certificate
fingerprint as before the switch (keys stay in the enclave); custom domain eyesoff.ai; DNS returns both exits; the
providers' per-peer counters show each app's inner tunnel on the exit and outer tunnel on the guard; the exit sees only
the guard's address.

## Tested locally (not production paths)

- `test/netns/wg-e2e.sh` (real kernel WireGuard + nftables in unprivileged network namespaces, 30 checks): guard hop,
  egress, DNS through the tunnel, ingress with TLS ending at the host's server, custom domain, unknown SNI refused,
  route probe through the guard, provider refusals (private, metadata, own address, own tunnel address, SMTP) as prompt
  resets, guard refuses non-provider destinations, unregistered key gets no handshake, the host's real runtime
  (worker + broker + grant renewal), a host control circuit, the qualification checker (mutation: removing the SMTP rule
  fails it), bring-your-own WireGuard (egress from the VPN's address, names through its tunnel, IPv6 refused without an
  IPv6 tunnel address, nothing leaves once the VPN is gone).
- Unit tests: `test/network-policy.test.mjs` (policy validation, owner signatures, nonce replay; BYO parser: hooks,
  partial tunnels, private endpoints, salted digest, redaction), `test/wg-provider.test.mjs` (runner/lease checks,
  policy authorization, price limits, replay, roles, probe and control peers, sweeps, budget), `test/network-api.test.mjs`
  (directory, qualifications, policies, sealed BYO configs: owner-only view, release to the current runner only,
  replay), `test/windows-node-tuna-enroll.test.mjs` (wallet-free enrollment, one-time switch), `test/site-eip191.test.mjs`,
  `network/wg` Go tests.

## Owner configuration applied by a host in production (2026-10-13)

Test deployment 0x5ece7c2e… (s3-ipfs-adapter, owner = the agent wallet, on the NucBox, since refunded), each step
signed by the owner with `scripts/network/owner-policy.mjs` through the public relay API and applied by the NucBox's
production agent without a restart:

| Owner change (nonce) | What the host did | Seen |
|---|---|---|
| default -> `routes 1` (1) | rebuilt on one circuit | within ~30 s; DNS one exit; HTTPS 200; host reported nonce 1 |
| -> BYO WireGuard, ingress on the Enclave network (2) | BYO tunnel for egress + one ingress-only network circuit | test VPN on fra1 saw the handshake; the app's DNS (1.1.1.1) and HTTPS calls left inside the BYO tunnel |
| BYO server taken down, `fallback none` | dropped the BYO circuit after its egress probes failed (~1.5 min); NO switch to another network; app not ready, reason shown; website circuit kept | VPN up again: BYO back immediately |
| -> `fallback enclave-network` (3), BYO down | egress through the authorized fallback; status `fallbackActive` | first try closed the website circuit too (~2 min dark): fixed (2ccd5f07a, own egress-only fallback circuit), re-tested: website circuit c3aaed2a unchanged through failover and failback |
| -> Enclave network, `routes 2` (4); BYO config deleted | BYO tunnel closed (VPN silent since), two network circuits, DNS both exits | owner view of the config afterwards: none |

Also verified on the relay: a non-owner's policy is refused and changes nothing; the stored BYO config only ever comes
back redacted (no key material); its release to anyone but the current runner is refused (403).

Found and fixed during these tests (all deployed to the NucBox, metal0 and the pVM agent the same night):
- a config reload on a network-only host refused every app as "TUNA": a newly claimed app was never served until the
  agent restarted (c498e4c9a);
- one provider losing its qualification took every app with `routes 2` offline (it built nothing when it could not
  build two): it now degrades to the circuits the qualified providers allow, reported as `degraded` (828ef2803);
- one incident at a provider escalated its cooldown once per app (five apps: 1 min -> 16 min): failures during a
  cooldown no longer escalate it (db35b8781).
The provider incident itself was mine: the first test VPN on fra1 reused fra1's own wg-exit address 10.77.0.1, its
/24 route took the return traffic of exit peers in 10.77.0.0/24, both checkers saw fra1 fail "refusals must be
prompt" and disqualified it (01:18-01:21Z); every app was off its fra1 circuits, and for ~3 min had none. The VPN was
recreated on 10.250.0.0/30.

## Paid provider tested in production (2026-10-13 03:10-04:28Z)

The Singapore provider (165.245.191.129) was turned into a paid community provider for the test: registered as a
registry host (`scripts/network/provider-register.mjs`: host 0x668a609b..., its own receipt proof key made on the box),
price 0.05 USDC/GiB set on chain (setHost), both checkers attesting it on chain. A test app owned by the agent wallet
(0x942555ba..., on the NucBox; refunded after) set a v5 policy with a price limit and budget, authorized the provider on
chain (authorizeTuna, budget 0.2 USDC) and funded the escrow the ledger asked for. The NucBox built a circuit with the
paid provider as its guard (sgp1 -> sfo3); ~85 MiB of uploads to the app went through it. Settled on Base by the host's
real settlement, co-signed by the provider's real meter: **bytesServed 46,926,050 (the payload the app received), the
owner's budget charged 2,186 micro-USDC, the provider operator credited 1,748 (its 80% share)**. Afterwards: the app
refunded ($1.00), Singapore back to a free Enclave provider; its registry host entry stays (it takes no compute work).

Found and fixed during the test (deployed: relay c92678519, providers, checkers, NucBox, metal0/pVM; Windows release .25):
- checkers and provider guards rejected every community record (no registry lookup); the provider never passed its
  hostId to its own gate; the host never read its runner proof key, so it could not sign receipts;
- the on-chain qualification (5 minutes) lapsed between full checks: checkers now refresh a paid provider's attestation
  every minute (the relay accepts it against the same verdict) and the provider submits every 30 s - sampled 8 min, no gap;
- a refused paid debit cooled down the circuit's free providers for every app on the host: it no longer counts against them;
- settlement stuck forever on a mined transaction because publicnode refuses receipt lookups ("archive requests"): the
  settlement client falls back across RPCs, and a journaled transaction whose nonce is spent is resolved from the
  chain's metered bytes (also covers the host's operator key spending the nonce itself);
- attestation and price transactions now fail on a reverted receipt.

CI note: the relay deploy job starts by updating the DNS service on RELAY_SSH_HOST (46.62.128.36, the old nan-relay box),
which no longer answers (the authoritative DNS now runs on nan from /opt/enclave-dns). CI relay deploys fail there until
that is updated; c92678519 was deployed to nan with the same steps by hand (04:18:53Z).

## Bugs found and fixed after the switch (2026-10-13)

- **Shield egress "short body" - FOUND: the upstream ends the reply, not the Enclave path**: s3-ipfs-adapter (0x7ae476a3)
  loses ~1 in 100 4 MiB R2 range GETs to a clean early end. Fixes along the way (.27 no bridge write timeout, .28
  half-close) were sound but not the cause. A bisection cleared the app's circuit (300 of 300 4 MiB downloads through
  its own SOCKS proxies, fast and at its 1.2 MB/s). Release .31 logs every big egress stream's bytes: at the 12:41:03Z
  failure shield-egress received upstream-to-guest = 3,286,788 bytes (full windows: ~4,205,550) and the stream ended
  CLEANLY; the bridge wrote all of it into the guest's hv_sock. 3,286,788 = TLS handshake and headers + exactly 200 whole
  16 KiB records = the 3,276,800 body bytes the app saw. So the guest, hv_sock, bridge and shield-egress delivered
  everything; the sender (R2, or the exit's path to it) closed after a complete write. Platform-side nothing is lost.
  The fix belongs in the app: resume a short window from its received offset (enclave-88, with Steven's catalog publish).
  Also understood: for a few minutes after every partition restart, egress is refused ("refused:admit") until the node
  adopts the partition and its guest proof refreshes; the agent now says when an app leaves and rejoins the egress map.
- **An outage lapsed every app's egress**: the authorization round treated a failed chain read or policy fetch as an
  answer. When nucbox-k11-4's control circuits went down for about a minute (15:21Z), three apps' egress went OFF with
  their leases running. Now (d45fe2ef2) a refresh with no agreeing answer holds each running lease up to 10 min after its
  last agreeing read (the providers' rule) and goes on to the guest proofs; an unreachable relay keeps the last owner
  policy for up to 10 min. Live on metal0's agent 22:11Z (release-wg-949a47f89); on the NucBox with Windows .32.
- **An owner's version switch was adopted away**: the node adopted the partition named for a deployment whatever version
  it ran, so after a setAppRef the old version kept serving and the relay refused it (cron, 22:16Z). The node now compares
  the running domain's catalog version and CID with the ledger's and replaces it (d0f6b45f5); expectations are re-checked
  every 30 s while a new version's partition is starting (efab4ba9a). Windows .32 (23:28Z).
- **A host's tunnel blip withdrew its apps' DNS**: the route map dropped every label the moment the host's tunnel
  detached, and resolvers cached the NXDOMAIN. Routes are now kept for 3 min after the host was last eligible
  (relay/route-grace.mjs, live on nan 23:39Z).
- **A partition that ended by itself was replaced without a word**: the node now says when a domain it recorded as
  serving is gone from the manager before it starts the new one (949a47f89, Windows .32).
- **Egress-map writes failed on Windows**: Windows refuses a rename over `egress-routes.json` while ANY reader holds
  it, FILE_SHARE_DELETE or not (checked on the NucBox), and shield-egress reads it on every outbound connection: 91
  failures before, still 11 in 15 min after .27's retries (618c7d156). The egress map now overwrites the file in place
  after a few refused renames (padded so one write replaces every byte), and shield-egress re-reads a torn copy
  (aed5fd228 + isolation/egress-torn-reread 93429cf58, release .28).
- **A failed public-RPC read tore down circuits**: the provider's sweep removed every peer whose lease or registry
  read failed, so one moment of RPC disagreement dropped every circuit through a provider. Only a definite answer
  (lease ended, another runner, host inactive) removes a peer now; a renewal may use the last agreeing lease read
  (at most 10 minutes old, lease still running) (9c198fef9, deployed to all four providers 08:59Z).
- **Operator gas ran out with only a log line**: the Windows node counted renewals ("200 = four days"), but proof
  checkpoints for every app spend from the same key, so the NucBox ran dry in hours. The node now measures the
  balance's fall, calls it low under 48 hours, and the tray shows a warning with the address to top up (94f4dca1c).
- Paid-path fixes found by the production paid test (registry lookup, host id, host payout, attestation refresh,
  refused debits no longer strike providers, settlement RPC fallback, reverted receipts detected): main, deployed.

Windows host releases tonight: .27 (09:19Z: timeout-free bridge, rename retry, gas warning), .28 (09:59Z: half-close,
in-place routes write), .29 (10:54Z: egress diagnostics), .30 (11:47Z: referral codes), .31 (12:21Z: byte counts, egress-map log), .32 (23:28Z: outage hold, version-change replace, 30-s expectations), .33 (23:53Z: the WebView2 tray, enclave-40). The gas warning is live on the
NucBox: GET /v1/local/hosting and the relay's availability report a measured runway (205 h at 11:47Z).

## Implemented, not in use in production

- **Direct hosting**: implemented end to end (7e6287724, deployed: relay on main db35b8781, host agents): a host opts
  in with `enclaveNetwork.direct {address, qualificationFile}`, a trusted checker's signed qualification of exactly that
  runner, operator and public address; the host serves direct-mode apps through the Linux `DirectRuntime` (SNI to the
  enclave, TLS ends inside, policy-judged egress), publishes a v5 `direct` route carrying the qualification, and the
  relay accepts it only from the network's checkers; the route is withdrawn the moment the qualification lapses.
  Tested in `test/netns/wg-e2e.sh` (direct ingress with the enclave's certificate on the host's IP, egress from the
  host's address, private destinations refused) and `test/wg-manager.test.mjs`. Not exercised in production: no
  compute host with a public IPv4 exists today (the NucBox and metal0 are behind CGNAT; the pVM is a phone), so every
  host answers "direct hosting is not available" and the Network tab shows none. Windows hosts have no direct runtime.
- **Paid providers / USDC settlement**: live since 2026-10-13 03:06Z and exercised in production (section above). No
  community provider is offering paid service right now.
- **Community providers on Enclave hosts**: the opt-in record and qualification work for any Linux server with a public
  IPv4; no Enclave host has opted in, and there is no Windows provider.
- **WebSockets / streaming / sustained traffic** (verified on the production providers, not on a customer app):
  `scripts/network/wg-soak.mjs` from nan through the tor1 exit's real ingress (probe peer, TLS ending at the test
  server): 2000 WebSocket messages up to 60 KB over one connection, all echoed intact (33.6 s); 8 parallel streams,
  200 MiB in 23.9 s = 70.1 Mbit/s, every byte intact. A real app's server-sent-events stream (risc-box `/display`) held
  45 s through both exits. No app in production uses WebSockets today, so none is tested on a customer app.

## TUNA

Retired from service 2026-10-13 ~00:00Z and removed (main e4eb6fff5, deployed 01:54Z): the relay's NKN funding
endpoint and its queue are gone (`/v1/hosts/tuna-funding` answers like any unknown path; the env entry removed); the
relay refuses every route publication not under a v5 policy; the privacy agent runs only the Enclave network and
refuses a configuration without it (leftover TUNA settings are ignored and logged); Windows enrollment makes no NKN
wallets; the TUNA Go adapter, runtimes, inventory, control guards, currency conversion, containers, units and the
site's old network controls are deleted (191 files, -25k lines). Hosts updated: NucBox (Windows release .23, no TUNA
executables in the bundle), metal0 and the pVM agent. Leftovers removed: the TUNA units, `/opt/enclave-tuna-usdc` and
the `tuna_proxy` nftables table on all four Droplets (archived to `/root/retired-tuna-20261013.tgz` on each), the four
TUNA timers on warden-host (moved to `~/.config/systemd/user/retired-tuna-20261013/`), `tuna-funding.mjs` on nan.
Names kept for installed hosts: `tuna-enroll.mjs`, the `/v1/network/tuna` route-map path,
the `C:\Program Files\Enclave\tuna\` directory, `enclave-tuna-privacy.service`. There is no TUNA rollback any more.

Names retired 2026-10-14 (all hosts moved, then the aliases removed):
- Route map: `/v1/network/routes`, format `enclave-network` (main 4764a023c). `/v1/network/tuna` answers 404 since the
  02:40Z relay deploy (main 30536f806), after every reader and publisher moved: the nan DNS (`ROUTE_MAP_URL`, 01:49Z),
  metal0's agent (02:06Z), the phone's standalone bundle (enclave-88, pvm-cpu/standalone ea8210a55), the NucBox (Windows
  2026.10.12.35, 02:27Z), the site and the deploy preflight. Relay state in `route-state`.
- `network.transport` accepts only `enclave-network` (no live ledger envelope carried `tuna`: 0xB1783B61, 79 rows).
- Supervisor egress: `EGRESS_SOCKS_UPSTREAM`; no `TUNA_*` variable is read anywhere.
- metal0: `enclave-network-agent.service`, `enclave-network-reconcile.timer`, tree `~/enclave-prod/enclave-network`;
  the TUNA tree and units are archived (`~/enclave-prod/retired-tuna-20261014`, `~/.config/systemd/user/retired-tuna-20261014`).
  `~/enclave-prod/tuna-privacy/metal0/state` remains only as a symlink for the running `enclave-guestd`, whose drop-ins
  already name the new path: delete it after guestd's next restart.
- pVM: `network-enroll.mjs`, transport and egress capability `enclave-network` (pvm-cpu/cpu-only 744218aa3).
- Windows .35: `ProgramData\Enclave\network`, `Program Files\Enclave\network`, task `\Enclave\Network`,
  `logs\network.log`, `network-enroll.mjs`, `ENCLAVE_NETWORK_*` (installer moves an older box once; verified on k11-4).
- Site: no user-facing TUNA text (main 77131a7dc).

What still says TUNA, and why:
- **The deployed `EnclaveConnectivity` contract (0x5f8b636e)**: its provider mode is named `tuna` (`hosts().tuna`,
  `authorizeTuna`, `settleTuna`, `tunaProviders`, the `tuna-policy.v1`/`tuna-receipt.v1` digest domains), so the code that
  calls it (connectivity-chain, onchain-qualification, provider-settlement, vaultsvc, the site's paid panel, scripts)
  uses those names. A renamed v2 is ready on branch `connectivity/provider-mode` (dc560667a; Foundry 26/26, paid fork e2e
  22/22), but it cannot be activated on the live ledger: `EnclaveDeployments.setBandwidthRouter` binds once and 16d is
  bound to v1. It ships with the next ledger revision (it must not merge before: callers would use functions v1 lacks).
- Code that recognizes the retired transport: the privacy agent's and Windows enroll's lists of retired settings, the
  "TUNA is retired" refusals, the relay's refusal of TUNA-era route publications, and the installer's one-time
  migration. `tuna` stays a reserved host name (relay/host-names.mjs).

## Relay restarts no longer take apps off DNS (2026-10-14)

Measured on k11-4's 8 apps: a relay restart cost ~60 s (01:33Z) because the relay started with no host rows and no
accepted publications, and the DNS service applied each partial map. Fixed (main a64942d25, 882dae8ca, 9345c9d90):
the detach grace is saved (`route-grace.json`) and holds while a re-attached Shield host's app awaits its verdict
(bound to the deployment's ledger fingerprint: a transfer still withdraws at once); accepted publications are kept in
the route state and restored while still the committed record; dns-relay holds the previous labels for 12 s after a map
drops more than half. Verified on the 01:55:53Z relay deploy: the first map served all 9 labels, DNS never changed
(one failed poll, kept), every app answered 200 throughout.
