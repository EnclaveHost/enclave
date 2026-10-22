#!/usr/bin/env python3
"""READ-ONLY live facts for the combined canary plan (reviewer 9d). No change anywhere.
minipc: through the reviewed transport nucbox-tls-20261021/root-activate-reviewed.py (m.ps: watchdog, encoded <= 7900).
fronts: ssh <alias> bash -s with a read-only script. Output: probe/<host>.json.
Reads: file sha256s, release links, unit state/ExecStart, task state, node script paths, sanitized config KEYS / public origins /
ports / zones (never key material, never log bodies, never full config content), nft table sha, public directory provider ids."""
import hashlib, importlib.util, json, pathlib, subprocess, sys, time

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "probe"; OUT.mkdir(exist_ok=True)
T = HERE.parent.parent / "nucbox-tls-20261021/root-activate-reviewed.py"
assert hashlib.sha256(T.read_bytes()).hexdigest() == "c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f"
sp = importlib.util.spec_from_file_location("transport", T); m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)

MA = (r"$PF='C:\Program Files\Enclave';$o=[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o');net=[ordered]@{};ctl=[ordered]@{}};"
      r"foreach($n in 'privacy-agent.mjs','windows-circuit-worker.mjs','host-service-ingress.mjs','enclave-wg.exe','enclave-circuit-firewall.exe'){$o.net[$n]=FileSha ($PF+'\network\'+$n)};"
      r"$o.netFiles=@(Get-ChildItem -LiteralPath ($PF+'\network') -File|ForEach-Object{$_.Name});"
      r"foreach($n in 'windows\node\network-enroll.mjs','windows\node\agent.mjs','network\host-service-transport.mjs','network\host-service-names.mjs','network\shield-expectation.mjs','network\privacy-agent.mjs'){$o.ctl[$n]=FileSha ($PF+'\control\'+$n)};"
      r"$o.tasks=@(Get-ScheduledTask -TaskPath '\Enclave\' -ErrorAction SilentlyContinue|ForEach-Object{[ordered]@{n=$_.TaskName;s=[string]$_.State}});"
      r"$o.node=@(Get-CimInstance Win32_Process -Filter ('Name=''node.exe''') -OperationTimeoutSec 20|ForEach-Object{$x=[regex]::Match([string]$_.CommandLine,'[A-Za-z]:\\[^\x22]*?\.mjs');[ordered]@{pid=$_.ProcessId;script=$x.Value;started=$_.CreationDate.ToUniversalTime().ToString('o')}});"
      r"$w=@(Get-CimInstance Win32_Process -Filter ('Name=''enclave-wg.exe''') -OperationTimeoutSec 20);"
      r"$o.wg=[ordered]@{count=$w.Count;paths=@($w|ForEach-Object{[string]$_.ExecutablePath}|Sort-Object -Unique|Select-Object -First 6|ForEach-Object{[ordered]@{dir=(Split-Path -Parent $_);sha=FileSha $_}})};"
      r"$o|ConvertTo-Json -Depth 5 -Compress")
MB = (r"$p='C:\ProgramData\Enclave\network\privacy-config.json';$o=[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o');cfgSha=FileSha $p};"
      r"if(Test-Path -LiteralPath $p){$c=[IO.File]::ReadAllText($p)|ConvertFrom-Json;$e=$c.enclaveNetwork;"
      r"$o.top=@($c.PSObject.Properties.Name);$o.en=@($e.PSObject.Properties.Name);$o.directories=@($e.directories);$o.hostServices=$e.hostServices;"
      r"$o.control=$e.control;$o.enApps=$(if($e.apps -is [string]){$e.apps}else{@($e.apps).Count});$o.appsTop=@($c.apps).Count;"
      r"$o.wgBinary=$e.wgBinary;$o.workerModule=$e.workerModule;$o.serviceWorkerModule=$e.serviceWorkerModule;$o.firewallBinary=$e.firewallBinary;"
      r"$o.hostEgress=($null -ne $e.hostEgress);$o.paceMbps=$e.paceMbps;$o.endpoint=$c.endpoint;$o.runner=$c.runner};"
      r"$h='C:\ProgramData\Enclave\host-services\hs2';$t=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'enclave-host-services-hs2' -ErrorAction SilentlyContinue;"
      r"$o.hs2=[ordered]@{task=$(if($t){[string]$t.State}else{'absent'});config=FileSha ($h+'\config\host-services.json');receipt=FileSha ($h+'\config\install-receipt.txt');"
      r"runner=FileSha 'C:\Program Files\Enclave\host-services\hs2\bin\host-services-runner.mjs';lock=(Test-Path -LiteralPath ($h+'\upgrades\active.lock'))};"
      r"$o.listen=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object{$_.LocalPort -in 18153,18154,18188,18189,18190,8091}|ForEach-Object{[string]$_.LocalAddress+':'+$_.LocalPort}|Sort-Object -Unique);"
      r"$o|ConvertTo-Json -Depth 6 -Compress")

FRONT = r'''set -u
P=/opt/enclave-network
echo "## release"; echo "current=$(readlink $P/current) previous=$(readlink $P/previous 2>/dev/null)"; ls -1 $P | tr '\n' ' '; echo
sha256sum $P/current/wg-provider.mjs /etc/enclave-network/provider.json /etc/systemd/system/enclave-network-provider.service 2>&1
echo "## unit"; systemctl show enclave-network-provider -p ActiveState -p MainPID -p NRestarts -p ExecStart -p DropInPaths -p ActiveEnterTimestamp --no-pager
echo "## config-sanitized"; node -e '
const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
const pick={keys:Object.keys(c).sort(),publicAddress:c.publicAddress,uplink:c.uplink,roles:c.roles,region:c.region,kind:c.kind,zone:c.zone,probeZone:c.probeZone,
 bootstrap:c.bootstrap,directories:c.directories,relay:c.relay,ports:c.ports,stateDir:c.stateDir,hostServices:c.hostServices??null,checkers:c.checkers,rpc:c.rpc};
console.log(JSON.stringify(pick));' /etc/enclave-network/provider.json
echo "## nft"; nft list tables | tr '\n' ' '; echo; nft list table inet enclave_net 2>/dev/null | sha256sum; nft list table inet enclave_net 2>/dev/null | grep -c 'dport 53'
echo "## conntrack"; command -v conntrack || echo absent
echo "## ufw53"; ufw status 2>/dev/null | grep -E '(^| )53([/ ]|$)' || echo none
echo "## listen53"; ss -Hlntup '( sport = :53 )' 2>/dev/null | awk '{print $1,$5,$7}' | sed 's/,fd=[0-9]*//g'
echo "## dns-units"; for u in enclave-dns-front enclave-route-dns enclave-public-directory; do systemctl show $u -p ActiveState -p ExecStart --no-pager | tr '\n' ' '; echo; done
systemctl show enclave-route-dns -p Environment --no-pager | tr ' ' '\n' | sed 's/^Environment=//' | grep -E '^(APP_ZONE|IP_ZONE|NS_NAME|NS_NAMES|APP_STATIC|DNS_BIND|DNS_PORT|DNS_API_PORT|DNS_READ_ONLY|DNS_RL_[A-Z_]*|ROUTE_MAP_URL)='
sha256sum /etc/dnsdist/dnsdist.conf 2>/dev/null
echo "## node"; node --version
echo "## providers"; curl -s -m 8 http://127.0.0.1:8188/v1/network/providers | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);for(const p of j.providers||[]){const r=p.record?.record||{};
console.log(JSON.stringify({providerId:r.providerId,publicAddress:r.publicAddress,region:r.region,roles:r.roles,keys:Object.keys(r).sort()}));}});'
'''
FRONT_MIN = r'''set -u
echo "current=$(readlink /opt/enclave-network/current)"; sha256sum /opt/enclave-network/current/wg-provider.mjs /etc/enclave-network/provider.json
systemctl show enclave-network-provider -p ActiveState -p NRestarts -p ActiveEnterTimestamp --no-pager | tr '\n' ' '; echo
node -e 'const c=JSON.parse(require("fs").readFileSync("/etc/enclave-network/provider.json","utf8"));console.log(JSON.stringify({hostServices:c.hostServices??null,roles:c.roles,publicAddress:c.publicAddress}))'
command -v conntrack || echo conntrack-absent
systemctl show enclave-route-dns -p Environment --no-pager | tr ' ' '\n' | sed 's/^Environment=//' | grep -E '^(NS_NAME|NS_NAMES|APP_STATIC)='
'''

def front(alias, script):
    r = subprocess.run(["timeout", "60", "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", alias, "bash", "-s"], input=script,
                       capture_output=True, text=True)
    return {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "rc": r.returncode, "stdout": r.stdout, "stderr": r.stderr[-500:]}

def main(which):
    if "minipc" in which:
        (OUT / "minipc.json").write_text(json.dumps({"A": m.ps(MA, 90), "B": m.ps(MB, 90)}, indent=1) + "\n")
    if "ca-east" in which:
        (OUT / "ca-east.json").write_text(json.dumps(front("ca-east", FRONT), indent=1) + "\n")
    for f in ("us-west", "eu-central", "ap-southeast"):
        if f in which: (OUT / f"{f}.json").write_text(json.dumps(front(f, FRONT_MIN), indent=1) + "\n")
    print("written:", sorted(p.name for p in OUT.iterdir()))

if __name__ == "__main__":
    main(sys.argv[1:] or ["minipc", "ca-east", "us-west", "eu-central", "ap-southeast"])
