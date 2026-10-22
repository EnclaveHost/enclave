NATIVE G2 KERNEL HARNESS - prepared by e49, for ROOT to review and run ONCE (e49 runs nothing remotely).
Purpose: prove the provider's DNS 53 packet path (wg-provider/kernel.mjs dns ruleset, map updates, conntrack flush) on a
real kernel that has nft_nat, nft_limit and nft_connlimit. This dev host's running kernel has no module tree, so here
it is parser-checked only. Root named ca-east: Ubuntu 6.8.0-146, nft 1.0.9, ip/unshare/wg/systemd-run/python3, about 350 MiB
spare. Node/Go are deliberately NOT needed there.

FILES (MANIFEST.sha256 covers the harness; frozen/SHA256SUMS the frozen inputs):
  gen-frozen.mjs   local only: freezes EXACTLY what tree/network/wg-provider/kernel.mjs produces
  frozen/          ruleset-dns.nft (publicAddress 47.0.0.2, uplink eth0, default limits), ruleset-plain.nft (no dns: a
                   rollback), sync-h1.nft / sync-h2.nft / sync-none.nft (Kernel.sync for target H1, target H2, nobody),
                   conntrack-flush.txt, flush-decisions.json, limits.json
  control/         rev3-ruleset-dns.nft, rev3-sync-h1.nft, rev3-sync-h2.nft: the rev3 freeze root ran at 16:33Z (no gate),
                   kept ONLY as the flush mode's negative control
  run.sh           the one command root runs (preflight + one transient systemd unit)
  stage2.sh        PID 1 of the private namespaces: topology, fixtures, tests
  dnsfix.py        stdlib Python DNS answerer (UDP+TCP, logs sources) and clients (query, burst, tcphold)
  local-scaffold.sh  local validation (queue 256): freeze, manifest, scaffold mode under `unshare -r`

TO RUN (root, on the chosen host): copy this directory there (e.g. scp -r), then
    sudo bash run.sh                      # refuses if a needed module is not already loaded
    sudo bash run.sh --allow-module-autoload   # only if root approves loading nft_nat/nft_limit/nft_connlimit/... into that kernel
    sudo bash run.sh --flush-only              # FOCUSED N2 proof once conntrack-tools is installed (the full run's SKIP)
Remove the copied directory afterwards. That copy is the only file placed on the host, and it is placed by root.

THE DNS GATE (rev4; final review N2/P1/P2): the first forward rule, BEFORE the established-accept, drops a DNATed UDP 53
packet toward wg-exit unless it goes to the CURRENT target (dns_target4, updated with the map in one transaction); the
DNS-disabled (plain) table drops every such packet. So a stale UDP flow - one conntrack still DNATs to an old host,
kept alive for as long as its resolver keeps the port busy (no timeout bounds a steady resolver) - is DROPPED, never
answered by a revoked host, even when a conntrack delete fails. The delete (kernel.mjs: pending until it succeeds, retried
at every sync) then moves the flow to the current target. TCP 53 is not gated: an open connection finishes on its host.

FLUSH MODE (--flush-only; refuses without conntrack): one fixed-port UDP flow F, a steady resolver. For EACH effect step,
STRICT evidence before the delete:
  - F's conntrack entry to the OLD host EXISTS (conntrack -L ... --orig-port-src 40053);
  - F gets NO answer and the old host's query log does not grow (the gate drops it: fail closed).
Then the delete removes >= 1 entry, none to the old host remains, and F reaches the expected target.
Steps:
- run 1: first assignment H1 (no prior flow to prove), F reaches H1;
- NEGATIVE CONTROL: the rev3 table and sync (control/, the ones root ran at 16:33Z, no gate) after a switch to H2: the OLD
  host H1 still answers F - the leak the gate closes;
- H1 -> H2 (strict), then a new flow reaches H2;
- H2 -> nobody (strict); an open TCP 53 connection finishes on its host across the revoke;
- provider RESTART: the table is re-created and the first assignment is H2 (strict, old host H1);
- ROLLBACK to the plain table: F (entry to H2 present) is dropped with NO delete; root's rollback delete removes the
  entry.
Each delete runs only where frozen/flush-decisions.json (kernel.mjs's own decision per step, from a fake-exec Kernel)
says kernel.mjs runs it. That file proves the decisions; the kernel evidence above proves their effect.

BOUNDS AND ISOLATION:
- Refuses unless root, the manifest and frozen hashes match, MemAvailable >= 200 MiB, and the tools are present.
- Modules: the loaded set is listed. Loading any module (the only possible host-global effect) needs the flag.
- One transient unit: MemoryMax=128M, MemorySwapMax=0, RuntimeMaxSec=60, CPUQuota=50%, TasksMax=64.
- `unshare --net --mount --pid --fork --mount-proc`: stage2 is PID 1. When it exits, every process, namespace, veth,
  WireGuard interface, nft table and conntrack entry goes with it. No namespace is bind-mounted.
- Keys and logs live in a private tmpfs mounted over /tmp inside the mount namespace (16 MiB).
- Nothing touches a host interface, firewall table, sysctl or route. ip_forward is set only inside the private
  namespaces.

TOPOLOGY (inside):
- C (client) 48.0.0.2 -- outer router -- P (provider) eth0 47.0.0.2.
- P has kernel wg-exit 10.77.0.1/16 and the frozen ruleset. Its kernel WireGuard peers are H1 10.77.0.5 and H2 10.77.0.6
  (allowed-ips /32, as kernel.mjs setPeer does).
- Each host runs a Python DNS answerer on its tunnel address: H1 answers 192.0.2.1, H2 answers 192.0.2.2.

TESTS (PASS/FAIL/SKIP lines; G2-RC=0 means all passed):
- the frozen ruleset loads; empty map: UDP 53 is forwarded to nobody;
- map -> H1: UDP and TCP 53 are answered by H1; H1 sees only 10.77.0.1 (masquerade);
- nothing but 53: UDP 5353 is not forwarded (H1's 5353 listener stays silent); TCP 80 is not forwarded;
- rate: a 200-query burst from one source is cut to about the per-source burst + rate;
- TCP: at most tcpPerSource concurrent connections per source;
- switch to H2 (failover):
  - new UDP and TCP flows reach H2;
  - an EXISTING UDP flow (fixed source port) is DROPPED by the gate (H1 never sees it);
  - after kernel.mjs's own conntrack delete (frozen/conntrack-flush.txt), the same flow reaches H2. If conntrack-tools
    is absent: SKIP - the flow stays dropped until its entry idles out, and a steady resolver keeps it, so no timeout
    bounds it;
- revoke: an empty map answers nothing; a target whose WireGuard peer was removed receives nothing.
Expected duration about 25 s, under the 60 s RuntimeMax. If it cannot finish within 128 MiB/60 s, it fails. Report that;
never raise the limits.

LOCAL VALIDATION DONE BY e49: see ../RESULT.txt (scaffold run through the queue at 256).
