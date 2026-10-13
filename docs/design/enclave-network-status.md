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

## Not yet proven in production

- **An owner changing mode, applied by a host**: on the production relay (2026-10-13, a test deployment owned by the
  agent wallet): the owner's signed policy was accepted (nonce 1, then 2), a non-owner's was refused and changed nothing,
  a BYO config was stored sealed (only a redacted view comes back, no key material in any response) and its release to
  anyone but the current runner was refused (403). The test app (cron) could not start without its secrets, so no host
  applied the change in production; the host side (circuits rebuilt on a policy change, BYO egress + network ingress,
  fallback only when authorized, revocation) is covered by `test/wg-manager.test.mjs` and the netns BYO tests. Every
  production app runs the default policy (Enclave network, free providers) until its owner changes it.
- **Direct hosting**: policy, UI and disclosure exist; no host that opted in has a public IP today (the NucBox and metal0
  are behind CGNAT), so the Network tab says none is available. The Linux `DirectRuntime` is not yet driven by v5 policies.
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
