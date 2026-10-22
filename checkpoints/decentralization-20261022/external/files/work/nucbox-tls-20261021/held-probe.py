# READ-ONLY, scoped: why are nucbox apps "held" after the 12:13:07Z manager restart? Primitive fields only.
#   - node /v1/host/state: every deployment row on this host (id prefix, status, short reason, isolation / isolationHeld)
#   - manager /vms: every record (id, name prefix, status, recovered, unattributed, launching, vmState, short reason)
#   - Hyper-V: enclave-app VMs (name, state, uptime, the deployment id named in Notes, the Notes prefix only)
#   - node.log since the restart: restart-recovery / retire / held lines (last 40, truncated)
import subprocess, base64, pathlib, json
ps = r'''$ErrorActionPreference='Continue';$ProgressPreference='SilentlyContinue'; $o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')}
function trim($s,$n){ $s=[string]$s; $s=($s -replace '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]',''); if($s.Length -gt $n){$s.Substring(0,$n)+'…'}else{$s} }
try{ $s=Invoke-RestMethod -TimeoutSec 8 'http://127.0.0.1:9600/v1/host/state'
  $o.deployments=@($s.deployments | ForEach-Object { [ordered]@{id=(trim $_.id 10); status=[string]$_.status; isolation=(trim ([string]$_.isolation.instance) 36); isolationId=(trim ([string]$_.isolationId) 36); held=(trim ([string]$_.isolationHeld) 36); walletHeld=$_.walletHeld; reason=(trim $_.reason 230)} }) }catch{ $o.hostError=trim $_.Exception.Message 200 }
try{ $v=Invoke-RestMethod -TimeoutSec 8 'http://127.0.0.1:8091/vms'
  $o.vms=@($v.vms | ForEach-Object { [ordered]@{id=[string]$_.id; name=(trim $_.name 10); status=[string]$_.status; recovered=$_.recovered; unattributed=$_.unattributed; launching=$_.launching; vmState=[string]$_.vmState; vmName=[string]$_.vmName; reason=(trim $_.reason 160)} }) }catch{ $o.mgrError=trim $_.Exception.Message 200 }
try{ $h=Invoke-RestMethod -TimeoutSec 8 'http://127.0.0.1:8091/health'; $o.inventory=$h.inventory }catch{}
$o.hyperv=@(Get-VM | Where-Object { $_.Name -like 'enclave-app-*' } | ForEach-Object { $n=[string]$_.Notes; $dep=([regex]::Match($n,'0x[0-9a-f]{64}')).Value; [ordered]@{name=$_.Name; state=[string]$_.State; uptime=[string]$_.Uptime; deployment=(trim $dep 10); notesPrefix=(trim $n 24)} })
$nl=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\node.log' -Tail 2500)
$o.nodeLines=@($nl | Where-Object { $_ -match 'restart recovery|retired|held|giving up|spawned|forced|claim-hint|unblocking' -and $_ -notmatch 'isolation adopted' } | Select-Object -Last 40 | ForEach-Object { trim $_ 250 })
'RESULT '+($o | ConvertTo-Json -Depth 5 -Compress)
'''
r = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'minipc', 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand',
                    base64.b64encode(ps.encode('utf-16le')).decode()], capture_output=True, timeout=150)
here = pathlib.Path(__file__).parent
t = r.stdout.decode('utf-8', 'replace'); i = t.find('RESULT ')
if i >= 0: (here / 'held-probe.json').write_text(json.dumps(json.loads(t[i + 7:].strip().splitlines()[0]), indent=1))
else: (here / 'held-probe.err').write_bytes(r.stdout + r.stderr)
print('SSH_EXIT', r.returncode, 'ok' if i >= 0 else 'no result'); raise SystemExit(r.returncode)
