# READ-ONLY recovery monitor, ONE round per run (queue it; >= 60 s between rounds; <= 10 rounds after activation).
#   nucbox (scoped SSH): manager pid/start + the two activated files' sha256; "[run] exited" crash lines in shield.log;
#     manager /vms status counts and the three apps' records; Hyper-V enclave-app states; for 59f1273d / d9798e4c /
#     7ae476a3 the LAST cert line (node.log), last guest-proof / egress lines (network.log) and a self-signed count over
#     the last 1500 network.log lines. No keys, env, secrets, app data or full logs.
#   public: route map labels/pending for the three; DNS (ns-us-west authoritative, 1.1.1.1); a VERIFYING HTTPS GET to each
#     app (system CA store, hostname checked: issuer, notAfter, status); enclavehost.eth.limo HEAD (bounded).
# Appends one JSON line to monitor.jsonl and prints a one-line summary.
import subprocess, base64, json, time, ssl, socket, urllib.request, urllib.error, pathlib, datetime
HERE = pathlib.Path(__file__).parent
IDS = {"59f1273d": "/", "d9798e4c": "/api/status", "7ae476a3": "/healthz"}
ps = r'''$ErrorActionPreference='Continue';$ProgressPreference='SilentlyContinue'; $o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')}
function trim($s,$n){ $s=[string]$s; $s=($s -replace '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]',''); if($s.Length -gt $n){$s.Substring(0,$n)+'…'}else{$s} }
$ids='59f1273d','d9798e4c','7ae476a3'
$l=@(Get-NetTCPConnection -State Listen -LocalPort 8091 -ErrorAction SilentlyContinue)
$o.mgr=@($l | ForEach-Object { $p=Get-CimInstance Win32_Process -Filter ("ProcessId="+$_.OwningProcess); [ordered]@{pid=$_.OwningProcess; started=$p.CreationDate.ToUniversalTime().ToString('o')} })
$d='C:\Program Files\Enclave\control\windows\vbslike\manager'
$o.hash=[ordered]@{server=(Get-FileHash -LiteralPath (Join-Path $d 'server.mjs') -Algorithm SHA256).Hash.ToLower().Substring(0,8); wmiserve=(Get-FileHash -LiteralPath (Join-Path $d 'wmiserve-run.mjs') -Algorithm SHA256).Hash.ToLower().Substring(0,8)}
$sh=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\shield.log' -Tail 3000)
$o.crashes=@($sh | Where-Object { $_ -match '\[run\] exited' } | Select-Object -Last 6 | ForEach-Object { trim $_ 120 })
$o.crashErrors=@($sh | Where-Object { $_ -match '^Error \[|ERR_STREAM|Unhandled' } | Select-Object -Last 3 | ForEach-Object { trim $_ 160 })
try{ $v=Invoke-RestMethod -TimeoutSec 8 'http://127.0.0.1:8091/vms'; $o.vmStatus=@($v.vms | Group-Object status | ForEach-Object { $_.Name+'='+$_.Count });
  $o.vmApps=@($v.vms | Where-Object { $n=[string]$_.name; $ids | Where-Object { $n -like ('0x'+$_+'*') } } | ForEach-Object { (trim $_.name 10)+' '+$_.status+' '+(trim $_.reason 120) }) }catch{ $o.mgrError=trim $_.Exception.Message 160 }
$o.hv=@(Get-VM | Where-Object { $_.Name -like 'enclave-app-*' } | Group-Object State | ForEach-Object { $_.Name+'='+$_.Count })
$nl=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\node.log' -Tail 2000); $wl=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\network.log' -Tail 1500)
$o.apps=[ordered]@{}
foreach($i in $ids){ $o.apps[$i]=[ordered]@{
  cert=(trim (@($nl | Where-Object { $_ -match $i -and $_ -match 'certificate' } | Select-Object -Last 1)) 230);
  isolation=(trim (@($nl | Where-Object { $_ -match $i -and $_ -match 'isolation|retired|giving up|held' -and $_ -notmatch 'adopted' } | Select-Object -Last 1)) 200);
  proof=(trim (@($wl | Where-Object { $_ -match $i -and $_ -match 'local guest proof' } | Select-Object -Last 1)) 200);
  egress=(trim (@($wl | Where-Object { $_ -match $i -and $_ -match 'egress (OFF|back)' } | Select-Object -Last 1)) 200) } }
$o.selfSigned1500=@($wl | Where-Object { $_ -match 'self-signed certificate' }).Count
'RESULT '+($o | ConvertTo-Json -Depth 5 -Compress)
'''
out = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
try:
    r = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'minipc', 'powershell', '-NoProfile', '-NonInteractive',
                        '-EncodedCommand', base64.b64encode(ps.encode('utf-16le')).decode()], capture_output=True, timeout=120)
    t = r.stdout.decode('utf-8', 'replace'); i = t.find('RESULT ')
    out["host"] = json.loads(t[i + 7:].strip().splitlines()[0]) if i >= 0 else {"error": t[-300:] + r.stderr.decode('utf-8', 'replace')[-300:]}
except Exception as e:
    out["host"] = {"error": str(e)}
def get(url, method="GET", timeout=20):
    t0 = time.time()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method=method, headers={"User-Agent": "enclave-recovery-monitor/1"}), timeout=timeout) as res:
            return {"status": res.status, "body": res.read(4000).decode("utf-8", "replace") if method == "GET" else "", "s": round(time.time() - t0, 1)}
    except urllib.error.HTTPError as e: return {"status": e.code, "s": round(time.time() - t0, 1)}
    except Exception as e: return {"error": f"{type(e).__name__}: {str(e)[:160]}", "s": round(time.time() - t0, 1)}
rm = get("https://api.enclave.host/v1/network/routes")
try:
    j = json.loads(rm.get("body", "") or "{}") if rm.get("status") == 200 else {}
except Exception: j = {}
if rm.get("status") == 200 and len(rm.get("body", "")) >= 4000:     # the map can exceed the sample: fetch fully
    try:
        with urllib.request.urlopen("https://api.enclave.host/v1/network/routes", timeout=20) as res: j = json.loads(res.read())
    except Exception as e: j = {"error": str(e)}
now = time.time() * 1000
out["routes"] = {"labels": len(j.get("labels", {})), **{k: (f"{round((j['labels'][k]['expiresAt'] - now) / 1000)}s" if k in j.get("labels", {}) else
                 next((p["reason"] for p in j.get("pending", []) if p["id"][2:10] == k), "absent")) for k in IDS}}
def dig(name, server):
    try:
        o = subprocess.run(["dig", "+time=4", "+tries=1", *(["+norec"] if "ns-" in server else []), "A", name, "@" + server], capture_output=True, text=True, timeout=12).stdout
        st = [l for l in o.splitlines() if "status:" in l]; a = [l.split()[-1] for l in o.splitlines() if "\tA\t" in l or " A " in l and not l.startswith(";")]
        return (st[0].split("status:")[1].split(",")[0].strip() if st else "?") + (" " + ",".join(a) if a else "")
    except Exception as e: return "error " + str(e)[:60]
out["dns"] = {k: {"auth": dig(f"{k}.app.enclave.host", "ns-us-west.enclave.host"), "1.1.1.1": dig(f"{k}.app.enclave.host", "1.1.1.1")} for k in IDS}
def tls_get(host, path):
    t0 = time.time()
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((host, 443), timeout=15) as s, ctx.wrap_socket(s, server_hostname=host) as t:
            c = t.getpeercert(); iss = dict(x[0] for x in c["issuer"]).get("organizationName")
            t.sendall(f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: enclave-recovery-monitor/1\r\nConnection: close\r\n\r\n".encode())
            t.settimeout(15); first = t.recv(200).decode("latin1").split("\r\n")[0]
            return {"verified": True, "issuer": iss, "notAfter": c["notAfter"], "status": first, "s": round(time.time() - t0, 1)}
    except Exception as e: return {"verified": False, "error": f"{type(e).__name__}: {str(e)[:140]}", "s": round(time.time() - t0, 1)}
out["https"] = {k: tls_get(f"{k}.app.enclave.host", p) for k, p in IDS.items()}
out["ethlimo"] = {k: v for k, v in get("https://enclavehost.eth.limo/", "HEAD", 25).items() if k != "body"}
with open(HERE / "monitor.jsonl", "a") as f: f.write(json.dumps(out) + "\n")
h = out["host"]
print(json.dumps({"at": out["at"][11:19], "mgr": h.get("mgr"), "hash": h.get("hash"), "crashes": h.get("crashes", [])[-2:], "vm": h.get("vmStatus"), "hv": h.get("hv"),
                  "selfSigned1500": h.get("selfSigned1500"), "routes": out["routes"], "dns": out["dns"],
                  "https": {k: (f"OK {v['issuer']} {v['status']}" if v.get("verified") else v.get("error")) for k, v in out["https"].items()}, "ethlimo": out["ethlimo"]}, indent=1))
