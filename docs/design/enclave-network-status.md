# Enclave network: status

What is implemented, what is tested and how, what is deployed, and what is still blocked. Updated with each change;
the design is `docs/design/enclave-network.md`. Nothing below is described as working unless it ran.

## Deployed and serving (2026-10-12/13)

| Piece | Where | State |
|---|---|---|
| Providers (kernel WireGuard + nftables + SNI router + control API) | 4 DigitalOcean Droplets: sfo3 134.199.235.187, tor1 146.190.246.39, sgp1 165.245.191.129, fra1 134.209.248.172 | live, systemd `enclave-network-provider`, all roles, price 0, transfer budget 850 GB/month each |
| Qualification checkers | nan (`enclave-network-checker`, 0x57144c90…) and warden-host (user unit, 0x033bc2b9…), every 4 min each | live; both pass all four providers on all nine checks through WireGuard; a provider stays eligible while one current verdict passes and no checker that reached it saw a failure |
| Relay API (`/v1/network/*`), v5 route acceptance, DNS label `enclave` | nan (main f16b792e0, 1ae64aa45) | live |
| Network tab (status, privacy, owner-signed mode setting; passkey-vault signing) | site (main 1ae64aa45) | live |
| NucBox (Windows, Enclave Shield): all apps on the Enclave network, own control traffic on control circuits | nucbox-k11-4 | live since 2026-10-12 23:51Z; Windows host release 2026.10.12.22 (published 00:35Z, installed 00:37Z: ENCLAVE_NETWORK=1, both checkers, no NKN) |
| metal0 (Linux, SEV-SNP): eyesoff incl. custom domain eyesoff.ai | warden-host | live since 23:53Z |
| pVM host agent | warden-host | on the Enclave network (serving no app at the moment) |

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

## Not yet proven in production

- **Direct hosting**: implemented end to end (7e6287724, deployed: relay on main db35b8781, host agents): a host opts
  in with `enclaveNetwork.direct {address, qualificationFile}`, a trusted checker's signed qualification of exactly that
  runner, operator and public address; the host serves direct-mode apps through the Linux `DirectRuntime` (SNI to the
  enclave, TLS ends inside, policy-judged egress), publishes a v5 `direct` route carrying the qualification, and the
  relay accepts it only from the network's checkers; the route is withdrawn the moment the qualification lapses.
  Tested in `test/netns/wg-e2e.sh` (direct ingress with the enclave's certificate on the host's IP, egress from the
  host's address, private destinations refused) and `test/wg-manager.test.mjs`. Not exercised in production: no
  compute host with a public IPv4 exists today (the NucBox and metal0 are behind CGNAT; the pVM is a phone), so every
  host answers "direct hosting is not available" and the Network tab shows none. Windows hosts have no direct runtime.
- **Paid providers / USDC settlement**: price limits and budgets are enforced at grant time; settlement needs the
  connectivity contract published in the address book (governance signature). All current providers are free.
- **Community providers on Enclave hosts**: the opt-in record and qualification work for any Linux server with a public
  IPv4; no Enclave host has opted in, and there is no Windows provider.
- **WebSockets / streaming / sustained traffic** (verified on the production providers, not on a customer app):
  `scripts/network/wg-soak.mjs` from nan through the tor1 exit's real ingress (probe peer, TLS ending at the test
  server): 2000 WebSocket messages up to 60 KB over one connection, all echoed intact (33.6 s); 8 parallel streams,
  200 MiB in 23.9 s = 70.1 Mbit/s, every byte intact. A real app's server-sent-events stream (risc-box `/display`) held
  45 s through both exits. No app in production uses WebSockets today, so none is tested on a customer app.

## TUNA

Retired from service 2026-10-13: no app uses it. Stopped: NKN top-up, funding sync, us-west fallback sync and the NucBox
SSH reconcile timers on warden-host; the TUNA services on the DigitalOcean nodes. Hosts keep the TUNA binaries for one
release as a rollback. Remaining cleanup: the relay's NKN funding endpoint, the TUNA code paths in the agent.

Code removal (branch `network/tuna-removal`, not merged or deployed): the relay's `/v1/hosts/tuna-funding` endpoint and
its queue; the relay refuses every route publication that is not under a v5 policy (TUNA v1 host allocations, policies
v2/v3/v4); the privacy agent requires `enclaveNetwork` and ignores leftover TUNA settings; the Windows enrollment and
the Linux reconciler make no NKN wallets; the TUNA Go adapter, its containers, provider units and the site's old
network controls are deleted (the USDC settlement modules stay, unwired, for paid providers). Deploying it ends the TUNA rollback: hosts updated to it cannot run TUNA again.
