#!/usr/bin/env python3
# Mutation checks for the owner-read change, ONLY in the isolated copy (iso/). Each mutant: replace one exact occurrence,
# run the focused test under the memory guard (foreground), record killed/survived, restore the file from the live tree.
import os, re, subprocess, sys, time, shutil
ROOT = "/home/steven/Documents/Codex/2026-10-18/wo/work"
ISO, LIVE, LOGS = f"{ROOT}/owner-secrets-logs/iso", f"{ROOT}/enclave", f"{ROOT}/owner-secrets-logs/mutants"
os.makedirs(LOGS, exist_ok=True)
OR, CLI = "test/custody-owner-read.test.mjs", "test/custody-secrets-cli-independent.test.mjs"
C, P, S, CI = "custody/v2/custodian.mjs", "custody/v2/protocol.mjs", "custody/v2/owner-secrets.mjs", "cli/custody-independent.mjs"
M = [
  ("o1", C, "e.exp <= now() || e.purpose !== purpose)", "e.exp <= now())", 0, OR, "purpose separation"),
  ("o2", C, "if (!ownerReadAllowed(rules)) refuse", "if (false) refuse", 0, OR, "ownerRead missing"),
  ("o3", C, 'if (pol.paused) refuse(403, "paused", "The owner has paused releases for this deployment (owner reads included).");', "", 0, OR, "refused by the custodians"),
  ("o4", C, 'if (!s.lease || s.beneficialOwner !== pol.owner) refuse(403, "owner_mismatch", "The ledger no longer names the policy\'s owner for this deployment.");\n    if (s.ownerIsContract)', "if (s.ownerIsContract)", 0, OR, "refused by the custodians"),
  ("o5", C, "if (!signer || signer !== pol.owner)", "if (!signer)", 0, OR, "refused by the custodians"),
  ("o6", C, "if (s.erc1271 !== ERC1271_MAGIC) refuse", "if (false) refuse", 0, OR, "ERC-1271"),
  ("o7", P, 'fixed(recipientKey, 32, "recipientKey"), u64(expiry)));', 'fixed(recipientKey, 32, "recipientKey")));', 0, OR, "protocol:"),
  ("o8", P, 'recipientKey: "0x" + hex(fixed(recipientKey, 32, "recipientKey")), expiry', 'recipientKey: "0x" + "00".repeat(32), expiry', 0, OR, "an EOA owner reads"),
  ("o9", C, 'if (req.purpose !== undefined) refuse(422, "bad_request", "A guest release names no purpose (an owner read goes to /v2/custody/owner-read).");', "", 0, OR, "purpose separation"),
  ("o10", P, "if (c2 !== c) throw", "if (false) throw", 0, OR, "lying custodian"),
  ("o12", CI, "const withOwnerRead = (o) => (ownerReadFlag === undefined ? o : { ...o, ownerRead: ownerReadFlag });", "const withOwnerRead = (o) => o;", 0, CLI, "ownerRead off"),
  ("o13", C, "if (hw && (s.blockNumber < BigInt(hw.block)", "if (false && (s.blockNumber < BigInt(hw.block)", 1, OR, "high-water"),
  ("o14", C, 'if ((ownerReads.get(id) || []).filter((x) => x > nowMs - OWNER_READ_WINDOW_MS).length >= OWNER_READ_MAX_PER_WINDOW) refuse(429, "rate_limited", "Too many owner reads for this deployment; retry later.");',
          'if ((ownerReads.get(id) || []).filter((x) => x > nowMs - OWNER_READ_WINDOW_MS).length >= OWNER_READ_MAX_PER_WINDOW) refuse(429, "rate_limited", "Too many owner reads for this deployment; retry later."); ownerReads.set(id, [...(ownerReads.get(id) || []), nowMs]);', 0, OR, "budget"),
  ("o15", C, 'if (counted.length >= OWNER_READ_MAX_PER_WINDOW) refuse(429, "rate_limited", "Too many owner reads for this deployment; retry later.");', "", 0, OR, "budget"),
  ("o16", C, "if (!Number.isInteger(expiry) || expiry <= nowSec || expiry > nowSec + OWNER_READ_TTL_SEC)", "if (!Number.isInteger(expiry))", 0, OR, "refused by the custodians"),
  ("o17", CI, "for (const n of r.names) h.say(f.show ?", "for (const n of r.names) h.say(true ?", 0, CLI, "full CRUD"),
]
only = set(sys.argv[1:])
for (mid, rel, old, new, occ, test, pat) in M:
  if only and mid not in only: continue
  path = f"{ISO}/{rel}"
  src = open(path).read()
  idx = [m.start() for m in re.finditer(re.escape(old), src)]
  if len(idx) <= occ: print(f"{mid} NOT APPLIED (pattern found {len(idx)}x)", flush=True); continue
  i = idx[occ]
  open(path, "w").write(src[:i] + new + src[i + len(old):])
  try:
    while int(next(l for l in open("/proc/meminfo") if l.startswith("MemAvailable")).split()[1]) < 18874368: time.sleep(10)
    log = f"{LOGS}/{mid}.log"
    t0 = time.time()
    r = subprocess.run(["timeout", "600", "node", "test/helpers/memory-guard.mjs", "--max-rss-mib", "512", "--floor-available-mib", "16384", "--",
                        "node", "--test", "--test-concurrency=1", f"--test-name-pattern={pat}", test], cwd=ISO, stdout=open(log, "w"), stderr=subprocess.STDOUT)
    out = open(log).read()
    npass = re.search(r"^# pass (\d+)", out, re.M); nfail = re.search(r"^# fail (\d+)", out, re.M)
    peak = re.search(r"peakTreeRssMiB=(\d+)", out)
    killed = r.returncode != 0 and nfail and int(nfail.group(1)) > 0
    print(f"{mid} {rel} exit={r.returncode} pass={npass and npass.group(1)} fail={nfail and nfail.group(1)} peak={peak and peak.group(1)}MiB "
          f"{int(time.time()-t0)}s -> {'KILLED' if killed else 'SURVIVED/INCONCLUSIVE'}", flush=True)
  finally:
    shutil.copyfile(f"{LIVE}/{rel}", path)
    assert open(path).read() == open(f"{LIVE}/{rel}").read()
