#!/usr/bin/env python3
"""ROOT-ONLY: ONE controlled relaunch of sia-s3 0.1.8 (deployment 0xef514ed3) on nucbox, through root's existing operator
path. PREPARED by reviewer 9d; NOT run by 9d.
The path is POST http://127.0.0.1:9600/v1/claim-hint {"id","force":true,"enclave":"nucbox-k11-4"}: a forced re-ensure,
the same call root-held-force.py ad2dc618 made at 12:16Z.
- Same lease, artifact, envelope/config and sealed secrets: the node re-reads them from the ledger/catalog. Nothing is
  claimed, released or signed.
- The partition is RETIRED and ONE fresh one started. So VM and TLS are NOT preserved: a new domain key, a new
  certificate request, open connections dropped. The runtime has no in-place reload.
- 0.1.8 rebuilds its index at boot from the sealed metadata pinned with every object: nothing committed is lost.
  In-flight uploads are lost.
This is a remedy EXPERIMENT (fresh egress front, SiaMux connections, SDK host/account state), NOT a diagnostic: guest
stderr is /dev/null on this tier, so a relaunch adds no log.

  root-sia-s3-relaunch.py                       read-only preflight -> relaunch-preflight-<UTC>.json
  root-sia-s3-relaunch.py --execute --expect-vm <the preflight's manager VM id>
      re-checks the predicate on the host and POSTs once; a second, read-only session follows for <= 300 s
Transport: the reviewed nucbox-tls-20261021/root-activate-reviewed.py (m.ps, encoded <= 7900, in-session watchdog).
"""
import argparse, hashlib, importlib.util, json, pathlib, sys, time

HERE = pathlib.Path(__file__).resolve().parent
T = (HERE.parents[1] / "nucbox-tls-20261021/root-activate-reviewed.py", "c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f")
ID = "0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238"
# one predicate, read on the host: node row, manager records, no recovered/unattributed VM, root's restart gates for THIS
# deployment (lease >= 10 min left; no host-wallet-policy flap in node.log's last 10 minutes: a flap retired 0x59f1273d at
# 17:10:43Z, and a relaunch during one leaves sia-s3 held/down)
PRED = (r"$id='IDX';$s=Invoke-RestMethod -TimeoutSec 15 'http://127.0.0.1:9600/v1/host/state';$d=@($s.deployments|Where-Object{$_.id -eq $id});"
        r"$v=Invoke-RestMethod -TimeoutSec 15 'http://127.0.0.1:8091/vms';$mine=@($v.vms|Where-Object{[string]$_.name -eq $id});"
        r"$t=(Get-Date).ToUniversalTime().AddMinutes(-10).ToString('HH:mm');"
        r"$flap=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\node.log' -Tail 2000|Select-String -SimpleMatch 'host wallet policy unavailable'|ForEach-Object{$_.Line.Substring(0,5)}|Where-Object{$_ -ge $t}).Count;"
        r"$lease=$(if($d.Count -eq 1 -and $d[0].leaseUntil){[int64]$d[0].leaseUntil-[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()}else{$null});"
        r"$p=[ordered]@{at=[DateTime]::UtcNow.ToString('o');node=@($d|ForEach-Object{[ordered]@{status=[string]$_.status;reason=[string]$_.reason}});"
        r"vms=@($mine|ForEach-Object{[ordered]@{id=[string]$_.id;status=[string]$_.status;recovered=[bool]$_.recovered}});"
        r"recoveredOrUnattributed=@($v.vms|Where-Object{$_.recovered -or $_.unattributed}).Count;leaseLeftSec=$lease;policyFlapLast10min=$flap;"
        r"managerPid=@(Get-NetTCPConnection -State Listen -LocalPort 8091 -ErrorAction SilentlyContinue|ForEach-Object{$_.OwningProcess})};")
CHECK = (r"$why=@();if($p.node.Count -ne 1 -or $p.node[0].status -ne 'running'){$why+='node row is not exactly one running'};"
         r"if($p.vms.Count -ne 1 -or $p.vms[0].recovered){$why+='not exactly one non-recovered manager record'};"
         r"if($p.recoveredOrUnattributed -ne 0){$why+='a recovered/unattributed VM exists'};if($p.policyFlapLast10min -ne 0){$why+='host wallet policy flapped in the last 10 min'};"
         r"if($null -eq $p.leaseLeftSec -or $p.leaseLeftSec -lt 600){$why+='lease under 10 min'};")
EXEC = (r"if($p.vms.Count -eq 1 -and $p.vms[0].id -ne 'VMX'){$why+='the manager record is not the preflight VM'};"
        r"if($why.Count){$p.refused=$why}else{$b=@{id=$id;force=$true;enclave='nucbox-k11-4'}|ConvertTo-Json -Compress;$p.postedAt=[DateTime]::UtcNow.ToString('o');"
        r"try{$p.reply=Invoke-RestMethod -Method Post -ContentType 'application/json' -Body $b -TimeoutSec 240 'http://127.0.0.1:9600/v1/claim-hint'}catch{$p.replyError=[string]$_.Exception.Message}};")
# a SEPARATE read-only session (the encoded-length limit): follow until a NEW partition runs, at most 300 s
FOLLOW = (r"$id='IDX';$end=(Get-Date).AddSeconds(300);do{Start-Sleep 10;$v=Invoke-RestMethod -TimeoutSec 15 'http://127.0.0.1:8091/vms';$n=@($v.vms|Where-Object{[string]$_.name -eq $id});"
          r"$s=@((Invoke-RestMethod -TimeoutSec 15 'http://127.0.0.1:9600/v1/host/state').deployments|Where-Object{$_.id -eq $id})}"
          r"until((Get-Date) -gt $end -or ($s.Count -eq 1 -and $s[0].status -eq 'running' -and $n.Count -eq 1 -and $n[0].id -ne 'VMX'));"
          r"[ordered]@{at=[DateTime]::UtcNow.ToString('o');node=@($s|ForEach-Object{[ordered]@{status=[string]$_.status;reason=[string]$_.reason}});"
          r"vms=@($n|ForEach-Object{[ordered]@{id=[string]$_.id;status=[string]$_.status;recovered=[bool]$_.recovered}})}|ConvertTo-Json -Depth 5 -Compress")

def main(argv):
    a = argparse.ArgumentParser(); a.add_argument("--execute", action="store_true"); a.add_argument("--expect-vm", default="")
    o = a.parse_args(argv)
    if hashlib.sha256(T[0].read_bytes()).hexdigest() != T[1]: raise SystemExit("transport is not the reviewed pin")
    sp = importlib.util.spec_from_file_location("transport", T[0]); m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)
    ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    if not o.execute:
        r = m.ps("[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);" + PRED.replace("IDX", ID) + CHECK + r"$p.wouldRefuse=$why;$p|ConvertTo-Json -Depth 5 -Compress", 90)
        (HERE / f"relaunch-preflight-{ts}.json").write_text(json.dumps(r, indent=1) + "\n"); print(json.dumps(r, indent=1))
        return 0 if not r.get("wouldRefuse") and "error" not in r else 1
    import re
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", o.expect_vm): raise SystemExit("--expect-vm <the preflight's vms[0].id>")
    att = HERE / f"attempt-relaunch-{o.expect_vm}.json"
    try:
        with open(att, "x") as f: json.dump({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "id": ID, "vm": o.expect_vm}, f)
    except FileExistsError: print(f"REFUSED: {att} exists; a relaunch is never retried automatically"); return 4
    r = m.ps("[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);" + PRED.replace("IDX", ID) + CHECK + EXEC.replace("VMX", o.expect_vm)
             + r"$p|ConvertTo-Json -Depth 6 -Compress", 300)
    if not r.get("refused") and "postedAt" in r:   # follow ALWAYS once posted, also after a reply error (the outcome is unknown)
        r["after"] = m.ps(FOLLOW.replace("IDX", ID).replace("VMX", o.expect_vm), 420)
    (HERE / f"relaunch-result-{ts}.json").write_text(json.dumps(r, indent=1) + "\n"); print(json.dumps(r, indent=1))
    a2 = (r.get("after") or {})
    ok = not r.get("refused") and len(a2.get("node", [])) == 1 and a2["node"][0].get("status") == "running" and len(a2.get("vms", [])) == 1 and a2["vms"][0].get("id") != o.expect_vm
    print("RELAUNCHED (a new partition is running): now verify /healthz, /api/status, sia-diag" if ok else "NOT CONFIRMED: ROOT reads the result; do not repeat (respawn budget 3/h)")
    return 0 if ok else 3

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
