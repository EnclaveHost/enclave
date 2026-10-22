NATIVE-WIN (rev4) - Windows proof of the host-service DNS path, by component. Prepared by e49 for ROOT to run ONCE on minipc
as Administrator. UNTESTED HERE: the dev host has no PowerShell. Root reviews first; e49 runs nothing remotely.

FILES (MANIFEST.sha256): win-udp-fixture.ps1, probe.mjs (sandboxed probe), listener.mjs (loopback stand-in for route-dns).
Binaries to stage beside it (sha256 from the 1024 Go job, logs/go-job2.log):
  enclave-wg.exe     dea45347af329bdde8a3d9011e712c27ed38985cd123d9749cad5d27a45d5c89  (the NEW binary; production keeps its own)
  wg-udp-test.exe    9a4b7bc667fbbd18b8f04d8f1928363298814ced81bd08e7f40f30b952c9409f  (network/wg tests, same source, windows/amd64)
RUN:
  powershell -NoProfile -ExecutionPolicy Bypass -File win-udp-fixture.ps1 -NewWgExe <path>\enclave-wg.exe `
    -WgTestExe <path>\wg-udp-test.exe -NodeExe <the agent's node.exe> -Peer <a public DO provider guard ip:port>
  -ReadOnly: R and E3 only (nothing installed). -Peer is only written into a policy; it is never contacted.

WHAT EACH PART PROVES (and does not):
  Q  Argument quoting self-check. A native parser (node) must see exactly: paths with spaces, quotes, trailing
     backslashes, an empty argument. Every launch goes through Process.Start with CommandLineToArgvW quoting. A launch
     failure or timeout is fatal and goes to cleanup. The ephemeral root itself contains spaces.
  R  Read-only production check: binary hashes, and that no INSTALLED circuit policy grants loopback UDP.
  E3 The NEW relay code natively, unsandboxed: wg-udp-test.exe -test.run ^TestUDPIngress (7 tests). It covers UDP 53
     framed onto loopback TCP to a TCP-only role; two queries in flight from one sender; EDNS/512 limits and
     truncation; flood eviction; non-loopback refusal. Everything runs on real Windows sockets with in-process
     WireGuard devices: no peer, no provider.
  E1 POLICY ACCEPTANCE ONLY. The new enclave-wg.exe is the program file of the exact tunnel-mode policy
     circuitFirewallPolicies emits for a DNS service circuit: UDP only to -Peer, loopback TCP incl. 127.0.0.1:18153.
     - It installs; the filters listed in ITS OWN manifest are present; on remove none of them remain.
     - The rev2 loopback-UDP shape is refused and leaves no manifest.
     - The binary is NOT executed.
  E2 SANDBOX GRANT SEMANTICS with node.exe as worker.exe (NOT the new binary), in a real circuit AppContainer + WFP
     policy with one loopback TCP grant:
     - TCP to it works; TCP to another loopback port and UDP to the granted port are blocked;
     - removal leaves none of ITS filters and no loopback exemption for ITS AppContainer SID.
  Ownership: every check is scoped to this fixture's own filter IDs and SID, never global counts (production circuits may
  change meanwhile). Cleanup removes only what this script installed. A directory whose remove fails is KEPT as the
  receipt and reported FAIL. Cleanup rules (2026-10-21, after R4-1):
  - every install that left a firewall.json is tracked, whatever its exit code; an unreadable manifest is tracked too
    (its remove is still tried, but can never be verified, so its directory is kept);
  - a directory is deleted ONLY if it holds no firewall.json or its remove was verified (none of its filters, and for
    E2 no exemption, remain); after any throw (before tracking, or inside cleanup) a directory holding a firewall.json is
    kept and reported FAIL (a directory without one installed nothing: the tool writes the manifest before any rule);
  - a timeout kills that process's tree (taskkill /T /F, then Kill) and WAITS up to 45 s for it to be gone; if it cannot
    be confirmed stopped, cleanup still tries every remove but deletes NO fixture directory;
  - the run ends with "KEPT <dir>" for each receipt left. Root then inspects by hand: the kept firewall.json lists the
    rule IDs and AppContainer SID; `netsh wfp show filters` output naming "native win <hex>" shows anything left.

THE REMAINING COMBINED GATE (not covered by any isolated fixture):
- What: the new enclave-wg.exe INSIDE the circuit sandbox, carrying DNS over a real tunnel.
- Why no fixture: enclave-circuit-firewall admits only a PUBLIC IPv4 WireGuard peer (main_windows.go publicIPv4), so the
  tunnel needs a real provider.
- Proposed bounded ROOT canary (activation-adjacent, root's call):
  1. after A1 (provider hostServices without dns) and A2 on minipc (the new binary staged, the hostServices block with
     dns {tcp:18153, udp:18153}, route-dns with the transport aggregate);
  2. pin minipc in hostServices.dns.hosts on ONE provider only;
  3. pass: that provider's log shows "dns role of host <minipc> at 10.77.x.y: answering" (its SOA probe goes through
     the sandboxed binary's UDP relay to route-dns's TCP port), and `dig @<that front> <a derived name> A` plus
     `dig +tcp ...` are answered with the exit list;
  4. rollback: remove the pin (the gate drops stale flows; kernel.mjs deletes them), then remove the block if needed.
- Until it passes, W1 is "component-proven" (E1 + E2 + E3), NOT closed end to end.
