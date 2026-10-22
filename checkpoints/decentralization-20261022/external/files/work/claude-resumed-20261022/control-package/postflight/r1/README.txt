POST-CUTOVER SEMANTIC VERIFICATION: ROOT EXECUTION INSTRUCTIONS (prepared by Claude; never executed by its author)

Target: frozen work/root-control-final-20261022/control-package (helper 613b6f38, cutover 943a5f01, manifest 5094dca0).
Every remote text is READ-ONLY and bounded:
  * file reads and Get-FileHash
  * ONE GET http://127.0.0.1:9600/v1/host/state (10 s)
  * Win32_Process lookups for exactly the two PIDs the cutover journaled (15 s each)
  * one 25 s sleep between the two channel samples
There is no process listing, no task or service call, no write and no restart.
Output: booleans, counts, categories, sha256s, public paths, ids, pids and times only. The pwsh fixture asserts that planted
secret values never appear.

Copy this directory as <frozen package>/postflight/ (the same path depth; the transport pin c50aac8e resolves from it).

0. Native parse first (as for R-ISO). `python3 postflight.py texts --pre` and, after the cutover,
   `python3 postflight.py texts --receipt <cutover-result>` print every text with its sha256 and encoded length (<= 7600).
   Parse them on Windows PowerShell 5.1 before trusting a verdict. They were run only on pwsh 7 (Linux).
1. P0 marker. Immediately before `root-node-hold.py --cutover` (after its <= 600 s preflight; nothing mutating in between):
       python3 postflight/run-postflight.py --pre                  -> postflight/runs/p0-<ts>.json
   This records the node.log/network.log byte lengths and the enclaveNetwork operator blocks (key names + PS-canonical
   sha256). Without P0, P1/H1/C1 stay UNKNOWN; the other checks still run.
2. The cutover runs. Postflight applies only after a DONE* final. Otherwise follow REVIEW.txt RECOVERY; the runner refuses.
3. Right after DONE:
       python3 postflight/run-postflight.py --post --receipt helper/runs/cutover-result-<RUN>.json --p0 postflight/runs/p0-<ts>.json
   Expect P1 UNKNOWN until the new node agent is >= 420 s old (first enrollment pass at +60 s, then every 300 s).
4. AUTHORITATIVE sample: run the same --post command again at >= agent start + 420 s (for example +10 min). Optionally
   repeat near the end of root's observation window. Each run saves runs/post-<ts>.json and runs/verdict-<ts>.json
   (O_EXCL; never overwritten).

Verdict = required PASS only if ALL of these are PASS:
  C0 cutover final DONE: (DONE_PARTIAL -> UNKNOWN). Referenced from the receipt, not re-proved.
  F1 the 9 semantic files are the frozen bytes:
     agent 76cac355, host 9634cb40, network-enroll a9729786, host-admission.bundle 6bef372d, wallet-admission 0fa7678f,
     host-service-names a46123cb, host-service-transport de5bb98a, privacy-agent cfb69370, host-service-ingress c952dce4
  W1 the node agent PID+start equals journal start-node.agent, and the privacy agent equals journal privacy-restart
     newPid/newStart. A privacy change with a logged enrollment restart -> UNKNOWN; without one -> FAIL.
  W2 wallet-admission.json in both samples:
       version 1; runner = this host; generation = journal channelGeneration; revision strictly increases over 25 s
       (10 s heartbeat); 0 < expiresAt-now <= 31 s
  W3 status.json in both samples:
       version 2; updatedAt < 5 s old
       walletAdmission: runner = this host; same generation; fresh=true; applied=true; error=null; revision >= sample A's
       document revision; unexpired
  W4 each expected id:
       in the document allows, with appRef AND configCid equal to its network expectation (compared ON the host)
       0 < validUntil-now <= 90 s
       in status allows, exactly one status app with walletUntil, leaseUntil and proofUntil in the future
       an egress route
       a node record that is running, not walletHeld, with lease in the future
  A1 admin platform host policy:
       no ENCLAVE_PLATFORM_HOST_POLICY assignment of category off/empty/other in node-config.cmd / node-config.local.cmd /
       run-node.cmd, and at least one production/json assignment. Unset = OFF on this node (it passes book:null).
       node.log since the cutover's nodeLogOffset: "[host-policy] this host is ADMITTED" >= 1; "is not serving" /
       "is NOT serving" = 0
       node\platform-host-admission.json absent, or hostId = this host with knownRefusal null
  A2 owner wallet admission:
       ENCLAVE_HOST_OWNERSHIP / REGISTRY_PIN / CATALOG_PIN / POLICY_DIR and ENCLAVE_NETWORK_AGENT_DIR present (names only)
       ENCLAVE_NETWORK_WALLET_HOLD=1
       since the offset: "written EMPTY" >= 1, "wallet hold channel OFF" = 0, "NOT written" = 0
  P1 propagation: agent >= 420 s old; walletAdmission is exactly {file: C:\ProgramData\Enclave\network\wallet-admission.json};
     no P0 key dropped; no P0 block hash changed; a block hash that is not 64-hex/absent -> UNKNOWN (never "unchanged");
     an unexpected new key -> UNKNOWN
Optional (reported separately):
  H1 host services: NOT_CONFIGURED unless enclaveNetwork.hostServices exists. Then worker = Program Files\Enclave\network\
     host-service-ingress.mjs c952dce4, no INVALID/REFUSED, and "[privacy] host services:" since P0.
  C1 challenge replica: NOT_CONFIGURED unless enclaveNetwork.challengeReplica exists (the expected state now: hs2/DNS is
     still old and no 31053 listener is assumed). Then "challenge replica serving:" and no not-started/STOPPED/refused
     since P0.
Missing or unreadable evidence is UNKNOWN, never PASS. "required" is PASS, FAIL or NOT PROVEN (UNKNOWN).

Scope of the proof: A1 proves the platform gate is ON and admits THIS host. It does not prove that the admin has anchored
a ban list; an un-anchored policy also admits. W4 compares against the network expectation, which network-enroll builds
from the ledger row; it is not a fresh chain read. For a later hostServices/challengeReplica activation, take a NEW P0
before the privacy restart that applies it. W1 will then report that planned restart (UNKNOWN/FAIL by design); read
H1/C1/P1.
