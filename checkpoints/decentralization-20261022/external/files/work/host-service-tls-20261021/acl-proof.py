#!/usr/bin/env python3
"""ROOT-EXECUTABLE, READ-ONLY native proof of the service-tls key-directory ACL preflight on the hs2 host (NOT run by Claude).
Through the hs2 helper's own ps() transport (root-hs2-activate.py 67c5ac44, imported unchanged), it runs the role's EXACT
ACL query (service-tls.mjs ACL_PS: Get-Acl as SIDs) against the hs2 state directory, which a role key directory
(<state>\\service-tls\\keys) inherits from, plus the inheritance flags of each entry. Nothing is created, changed, started or
read beyond the ACL. The result is judged locally by the role's own evaluateWindowsAcl (node, composition tree).
  python3 work/claude-test-queue.py --mib 256 --log <abs>/aclproof.guard.log -- python3 work/host-service-tls-20261021/acl-proof.py [--keys]
PASS = exit 0 and acl-proof-<UTC>.json pass:true: owner and every allow entry within SYSTEM/Administrators/LOCAL SERVICE/
CREATOR OWNER, and LOCAL SERVICE's entry inherits to child containers and objects (so keys\\ gets it).
Limits: run elevated over SSH, so it proves the ACL, not that LOCAL SERVICE itself can run Get-Acl (the role does that at its
own start, fail-closed). It does not prove no OTHER LOCAL SERVICE process exists (shared account; see interface.txt)."""
import datetime, importlib.util, json, pathlib, subprocess, sys
HERE = pathlib.Path(__file__).resolve().parent
HELPER = HERE.parent / "resume-20261021/hs2-activation-prep/review-fix"
COMPOSE = HERE / "compose"
STATE = r"C:\ProgramData\Enclave\host-services\hs2\state"
# --keys: the role's ACTUAL key directory, once its first start created it (root verified the parent state ACL natively
# at 16:09:33Z; the created keys\ directory and its owner still need this native check)
if sys.argv[1:] == ["--keys"]: STATE += r"\service-tls\keys"
elif sys.argv[1:]: sys.exit("usage: acl-proof.py [--keys]")
sys.path.insert(0, str(HELPER))
spec = importlib.util.spec_from_file_location("helper", HELPER / "root-hs2-activate.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
acl_ps = subprocess.run(["node", "--input-type=module", "-e", "import { ACL_PS } from './network/host-services/service-tls.mjs'; process.stdout.write(ACL_PS)"],
                        cwd=COMPOSE, capture_output=True, text=True, check=True, timeout=60).stdout
assert acl_ps.startswith("$ErrorActionPreference='Stop';$a=Get-Acl -LiteralPath $env:ENCLAVE_KEY_DIR;") and "'" + "ACL '" in acl_ps
script = ("$env:ENCLAVE_KEY_DIR='" + STATE + "';$aclLine=(& {" + acl_ps + "});"
          "$inh=@((Get-Acl -LiteralPath $env:ENCLAVE_KEY_DIR).GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])|ForEach-Object{$_.IdentityReference.Value+'|'+$_.InheritanceFlags+'|'+$_.PropagationFlags+'|'+$_.AccessControlType});"
          "'RESULT '+(@{acl=[string]$aclLine;inh=$inh}|ConvertTo-Json -Compress -Depth 4)")
o = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "helperSha256": m.sha(HELPER / "root-hs2-activate.py"), "dir": STATE,
     "aclPsSha256": __import__("hashlib").sha256(acl_ps.encode()).hexdigest()}
try:
    rc, out, _ = m.ps(script, 60)
    o["rc"] = rc; o["inheritance"] = out.get("inh"); line = out.get("acl") or ""
    o["acl"] = json.loads(line[4:]) if line.startswith("ACL ") else None
except Exception as e:
    o["error"] = f"{type(e).__name__}: {e}"[:200]
if o.get("acl"):
    ev = subprocess.run(["node", "--input-type=module", "-e", "import { evaluateWindowsAcl } from './network/host-services/service-tls.mjs';"
                         "try { console.log(JSON.stringify({ ok: true, evidence: evaluateWindowsAcl(JSON.parse(process.argv[1])) })); } catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); }",
                         json.dumps(o["acl"])], cwd=COMPOSE, capture_output=True, text=True, timeout=60)
    o["evaluation"] = json.loads(ev.stdout.strip().splitlines()[-1])
ls_inherits = any(str(x).startswith("S-1-5-19|") and "ContainerInherit" in str(x) and "ObjectInherit" in str(x) and str(x).endswith("|Allow") for x in (o.get("inheritance") or []))
o["localServiceInheritsToChildren"] = ls_inherits
o["pass"] = bool(o.get("rc") == 0 and o.get("evaluation", {}).get("ok") and ls_inherits)
p = HERE / f"acl-proof-{datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
p.write_text(json.dumps(o, indent=1) + "\n"); print(json.dumps(o, indent=1)); sys.exit(0 if o["pass"] else 1)
