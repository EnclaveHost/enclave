# NucBox crash recovery: TLS incident

Verified 2026-10-23 09:25 UTC. Eight app endpoints pass system-CA certificate and hostname verification: c13d4b6a, ef514ed3 (Sia-S3), e64f7cba, 59f1273d (EnclaveDNS), d9798e4c (IPNS), a77d0c57 (jot), 38f368d6 (cron), and 7ae476a3 (storage adapter).

## Cause and applied recovery
Repeated crashes left stale SSH reverse-tunnel sessions holding storage forwarding ports. Fast 10-second reconnects entered the provider SSH rate limiter. Two control entry points lost their reverse forwarding listeners. Actual Windows Node selected a broken DNS address and failed HTTPS with ECONNRESET without trying a healthy address. Certificates could be issued but not retrieved; secrets-state reads also failed and safely prevented app admission/renewal.

- Set control and storage tunnel RestartSec=60s across the existing four frontends; restarted only failed tunnel services. Healthy tunnel processes were preserved.
- Added server ClientAliveInterval=15 / ClientAliveCountMax=3, scoped to the two restricted tunnel accounts; validated sshd config and effective settings. Root SSH, authentication, forwarding permissions and firewall remained unchanged. Reloaded SSH, without restarting the daemon.
- Terminated exactly three stale storage sshd sessions after checking listener ownership, account, command, boot-relative age and PID identity. All four storage and four control tunnels subsequently active.
- All four API frontends returned verified HTTPS 200. Eight app TLS endpoints subsequently recovered. EnclaveDNS recovered its existing artifact automatically after storage recovery; no republish or new signing was performed.

## Remaining / limits
API-MCP a69dcbba is unavailable for a separate startup failure. Its logs show sealed-secret relay HTTP 403, then a five-minute readiness timeout and release back to fleet at 08:55:53 UTC. At 09:26 it has no manager VM. No authorization bypass, forced claim or reset was performed. This is not a current certificate issuance failure.

SSH keepalives apply to new sessions. Existing healthy control and US storage sessions were not rotated during the user's running experiment. No crash drill or NucBox host, VM or agent restart was performed. The offline Claude same-origin HTTPS DNS failover patch remains in progress and is not deployed. This repair does not establish full decentralization; current provider placement remains a separate migration gate.

## Source and verification
Operational source commits be8a71d, edac1dc, 9bc2053. repair/run scripts default to preflight; historical --apply invocations are not general-purpose safe reruns against changed PIDs or unit hashes. All mutation receipts and final TLS results are preserved under evidence/. The public TLS verification used normal trust and SNI; no insecure flags. These results prove certificate validity at observation time, not every application feature or every future crash scenario.
