#!/usr/bin/env python3
"""ROOT-ONLY: activate the non-destructive wallet hold on minipc with the FINAL CONTROL PACKAGE. PREPARED by Claude (control-package
20261022); NEVER run by its author; no remote call was ever made with it. Successor of work/g4-node-ai-final-20261021/helper/
root-node-hold.py 0829847e: every remote text (IDN/CFGS/ACLS/COV/PUT/UNPUT/AGENT/LOADER/LAUNCH/JOURNAL), the transport pin
and bundle-swap.ps1 pin are kept VERBATIM. Changed:
  * the file set is ../manifest.json (pinned): network = privacy-agent 7ef4e230 -> cfb69370 ONLY (ingress c952dce4 and worker
    13ce44f1 are already live and are verify-only KEEP pins, never replaced); control = 18 files (5 PUT + 13 CAS swaps) = the
    part of the node agent's exact runtime import closure (81 files) that ROOT's fresh snapshot (2026-10-22T01:44:55Z) shows
    differing from the candidate; KEEP = 67 verify-only pins (the unchanged agent/
    manager closure + ingress/worker + enclave-wg cbaf8313 + firewall 78daec71); manager-only files are OBSERVED (report only).
  * hashing is BATCHED under the transport's 7900-char encoded limit (exact length computed with the transport's own HEAD).
  * group apply/rollback first reads every target (read-only): any target that is neither the old nor the new bytes REFUSES the
    whole group before anything changes; already-new (apply) / already-old (rollback) targets are skipped, so a rollback after a
    partial apply restores exactly the applied files (0829847e stopped at the first unapplied file: bundle-swap refuses its CAS).
  * the cutover is the ROOT-ACCEPTED cutover-review candidate 943a5f01 (r2; r1 pinned d88bab63; copied verbatim); its params carry
    runId (0829847e sent none: the journal would have been cutover-.jsonl and the poll would never see a final line) and the
    lease budget of cutover-review/candidate/budget.json (= node-stop-proof d88's leaseBudget: revert 550 / margin 180 / forward 180 / startNode 150).
  * the static 20-minute lease guard is replaced by budget.json's minimumRemainingBeforeStop (910 s), estimated from the
    preflight's remote clock; the cutover's own pins and BeforeStop read remain AUTHORITATIVE.

  root-node-hold.py                                          read-only preflight -> runs/preflight-*.json
  root-node-hold.py --stage --preflight P                    NEW C:\\ProgramData\\Enclave\\staging\\nodehold-<uuid12>: files+scripts, sha-verified
  root-node-hold.py --apply network --stage-receipt S        privacy-agent 7ef4e230 -> cfb69370 (no restart)
  root-node-hold.py --restart-agent --preflight P            the privacy agent's own restart (pinned PID+start); NO walletAdmission yet
  root-node-hold.py --apply control --stage-receipt S        5 PUT + 13 CAS swaps (inert for running processes; see REVIEW.txt)
  root-node-hold.py --cutover --stage-receipt S --preflight P          THE switch-on (node-hold-cutover.ps1 -Mode cutover)
  root-node-hold.py --status --stage-receipt S --run-id R              read the remote journal (read-only)
  root-node-hold.py --rollback-cutover R --stage-receipt S --preflight P   exact config restore (node-hold-cutover.ps1 -Mode rollback)
  root-node-hold.py --rollback control|network --stage-receipt S       CAS file rollback (reverse order, applied files only)
Every mutating call writes an attempt record (O_EXCL) BEFORE the remote call; an existing record refuses (never retried).
Never read: config values (only shas, key names, ids, appRef shape), keys, logs (only pattern COUNTS of node.log lines).
"""
import argparse, base64, calendar, hashlib, importlib.util, json, os, pathlib, re, subprocess, sys, time, uuid

HERE = pathlib.Path(__file__).resolve().parent; PKG = HERE.parent; W = PKG.parents[1]; OUT = HERE / "runs"
T = (W / "nucbox-tls-20261021/root-activate-reviewed.py", "c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f")
SCRIPTS = {"bundle-swap.ps1": (W / "cron-startup-20261021/respawn-activation/bundle-swap.ps1", "21d85c69b2b70564cc04f7ea7d72e9f763ef8ae65059fdb9972f0413f042b103"),
           "node-hold-cutover.ps1": (HERE / "node-hold-cutover.ps1", "943a5f0173a291c8ed2a3d160552dd5ab8633069cc331ba9c39b6806460e2093")}
MANIFEST = (PKG / "manifest.json", "MANIFEST_SHA_PIN")
RUN_NODE = "3366a005f8530903c83a334053280f41ed904df09133e92505c44f558acb6686"
LOCAL_CFG = "85698d20b4f8fb494c8620aeb80d5b4fbd2ec637ef40c7fa02693ba41ee2aa73"      # node-config.local.cmd (probe 21:20Z)
PF = r"C:\Program Files\Enclave"
NODE_EXE, NODE_SHA = r"C:\Program Files\nodejs\node.exe", "b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3"
# cutover-review/candidate/budget.json leaseBudget (sha pinned in the manifest) and its minimumRemainingBeforeStop
LEASE = {"revertSec": 550, "marginSec": 180, "forwardMinSec": 180, "startNodeSec": 150}; LEASE_NEED = 910
LIMIT = 7600                                                            # encoded chars per batch (transport refuses > 7900)

def _manifest():
    b = MANIFEST[0].read_bytes(); j = json.loads(b)
    files = {d["name"]: (PKG / "files" / d["name"], d["target"], d["old"], d["new"], d["how"]) for d in j["deploy"]}
    groups = {g: [d["name"] for d in j["deploy"] if d["group"] == g] for g in ("network", "control")}
    return hashlib.sha256(b).hexdigest(), files, groups, {k["target"]: k["sha256"] for k in j["keep"]}, [o["target"] for o in j["managerOnlyObserved"]]
MANIFEST_SHA, FILES, GROUPS, KEEP, OBSERVE = _manifest()
CFG = r"C:\ProgramData\Enclave\network\privacy-config.json"; RUNNER = "0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a"
APPREF = re.compile(r"^catalog://0x[0-9a-f]{64}/(?:0|[1-9][0-9]{0,8})$"); ID = re.compile(r"^0x[0-9a-f]{64}$")
FRESH_S, CUT_FRESH_S, BOUND_S = 1800, 600, 900
q = lambda v: "'" + str(v).replace("'", "''") + "'"
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
now = lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
U = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);"

