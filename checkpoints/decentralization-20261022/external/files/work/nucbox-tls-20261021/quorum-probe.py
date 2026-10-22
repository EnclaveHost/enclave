# READ-ONLY, bounded: is a chain-quorum failure taking routes and leases down (route map 0 labels; "host wallet policy
# unavailable (no fresh agreeing chain quorum)" retiring nucbox apps)?
#   public: route map (labels, pending reasons, updatedAt), relay /health, and eth_blockNumber from public Base RPCs (timing)
#   nucbox (scoped): node.log/network.log lines about quorum / RPC / policy unavailable in the last 1500 lines (count + last 12)
import json, time, urllib.request, subprocess, base64, pathlib, datetime
out = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
def req(url, data=None, timeout=12):
    t0 = time.time()
    try:
        r = urllib.request.Request(url, data=json.dumps(data).encode() if data else None, headers={"content-type": "application/json", "user-agent": "enclave-quorum-probe/1"})
        with urllib.request.urlopen(r, timeout=timeout) as res: return {"status": res.status, "body": res.read(400000), "s": round(time.time() - t0, 2)}
    except Exception as e: return {"error": f"{type(e).__name__}: {str(e)[:140]}", "s": round(time.time() - t0, 2)}
rm = req("https://api.enclave.host/v1/network/routes", timeout=20)
if rm.get("body"):
    j = json.loads(rm["body"]); out["routes"] = {"updatedAt": j.get("updatedAt"), "labels": list(j.get("labels", {})), "deployments": len(j.get("deployments", {})),
                                               "pending": [f"{p['id'][2:10]}:{p['reason']}" for p in j.get("pending", [])]}
else: out["routes"] = {k: v for k, v in rm.items() if k != "body"}
h = req("https://api.enclave.host/health")
out["relayHealth"] = json.loads(h["body"]) if h.get("body") else {k: v for k, v in h.items() if k != "body"}
out["rpcs"] = {}
for u in ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.llamarpc.com", "https://base.drpc.org", "https://1rpc.io/base"]:
    r = req(u, {"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []})
    try: out["rpcs"][u] = {"block": int(json.loads(r["body"])["result"], 16), "s": r["s"]} if r.get("body") else {k: v for k, v in r.items() if k != "body"}
    except Exception as e: out["rpcs"][u] = {"error": str(e)[:100], "s": r.get("s")}
ps = r'''$ErrorActionPreference='Continue';$ProgressPreference='SilentlyContinue'; $o=[ordered]@{}
function trim($s,$n){ $s=[string]$s; $s=($s -replace '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]',''); if($s.Length -gt $n){$s.Substring(0,$n)+'…'}else{$s} }
foreach($f in 'node.log','network.log'){ $t=@(Get-Content -LiteralPath ('C:\ProgramData\Enclave\logs\'+$f) -Tail 1500); $m=@($t | Where-Object { $_ -match 'quorum|RPC|policy unavailable|rpc|only \d+ of \d+|chain' })
  $o[$f]=[ordered]@{count=$m.Count; last=@($m | Select-Object -Last 12 | ForEach-Object { trim $_ 230 })} }
'RESULT '+($o | ConvertTo-Json -Depth 4 -Compress)
'''
try:
    r = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'minipc', 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand',
                        base64.b64encode(ps.encode('utf-16le')).decode()], capture_output=True, timeout=120)
    t = r.stdout.decode('utf-8', 'replace'); i = t.find('RESULT '); out["host"] = json.loads(t[i + 7:].strip().splitlines()[0]) if i >= 0 else {"error": t[-300:]}
except Exception as e: out["host"] = {"error": str(e)}
pathlib.Path(__file__).with_name('quorum-probe.json').write_text(json.dumps(out, indent=1)); print(json.dumps(out, indent=1)[:9000])
