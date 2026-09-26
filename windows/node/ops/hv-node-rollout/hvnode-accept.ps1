# hvnode-accept.ps1 - READ-ONLY acceptance of the running hv node + manager on the NucBox (ROLLOUT.md step 7, the box
# half; the relay/public half is hvnode-accept-remote.sh). Prints PASS / FAIL / INFO; exits 1 on any FAIL.
#   powershell -ExecutionPolicy Bypass -File hvnode-accept.ps1 -Commit <node commit, 8+ hex> [-DeploymentId 0x…] [-KillRecovery] [-OwnerRestart]
# A9 (with -DeploymentId) is the LIVE check of N1 on the NODE itself, through its loopback port (b4's F1: through the
# relay, B refuses these paths before the node ever sees them): no session -> 401, a stranger's OWN session minted on
# the node -> 404; with -OwnerRestart (it really restarts the app) the operator's own session -> 200.
# -KillRecovery (NOT read-only; enclave-d1's review, item 5) kills the agent's node.exe, then the manager's, by exact PID,
# and requires the run-*.cmd loop to bring each back: a new PID, and /availability or /health answering within 60 s.
param(
  [Parameter(Mandatory = $true)][string]$Commit,
  [string]$DeploymentId = '', [switch]$KillRecovery, [switch]$OwnerRestart,
  [string]$NodeExe = 'C:\Program Files\nodejs\node.exe',
  [string]$Root = 'C:\Users\claude\vbs-like\hvnode',
  [int]$ManagerPort = 8091, [int]$LocalPort = 9600,
  [string]$Operator = '0x389C3f030a209D04D026228D2D053fEB75DbadcA',
  [string]$RuntimeId = 'ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8'
)
$ErrorActionPreference = 'Stop'
$script:fails = 0
function Say([string]$k, [string]$m) { Write-Output ("{0,-4} {1}" -f $k, $m); if ($k -eq 'FAIL') { $script:fails++ } }
function Check([bool]$ok, [string]$m) { if ($ok) { Say 'PASS' $m } else { Say 'FAIL' $m } }
function Sha256Of([string]$p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() }
function GetJson([string]$url) { Invoke-RestMethod -Uri $url -TimeoutSec 15 -UseBasicParsing }
$c8 = $Commit.Substring(0, 8).ToLower()

# A1: the platform is as it was: Secure Boot on, the legacy task still Disabled (and still there)
try { Check ((Confirm-SecureBootUEFI) -eq $true) 'A1 Secure Boot is ON' } catch { Say 'FAIL' "A1 Secure Boot unreadable" }
$legacy = Get-ScheduledTask -TaskName 'EnclaveWindowsNode' -TaskPath '\' -ErrorAction SilentlyContinue
Check ($legacy -and $legacy.State -eq 'Disabled') 'A1 legacy task \EnclaveWindowsNode exists and is Disabled'

# A2: the two tasks run, from the installed files
foreach ($t in 'EnclaveHvManager', 'EnclaveHvNode') {
  $x = Get-ScheduledTask -TaskName $t -TaskPath '\' -ErrorAction SilentlyContinue
  Check ($x -and $x.State -eq 'Running') "A2 task \$t is Running ($(if ($x) { $x.State } else { 'absent' }))"
}
# matched by the ABSOLUTE script paths run-*.cmd use: never by a bare name (a tray, a lab manager also run node.exe)
$agentPath = "$Root\$c8\windows\node\agent.mjs"
function AgentProcs { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*$agentPath*" }) }
function MgrProcs { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*$Root\manager-*\control\windows\vbslike\manager\main.mjs*" }) }
$nodeProc = AgentProcs; $mgrProc = MgrProcs
Check ($nodeProc.Count -eq 1) "A2 exactly one node agent process ($($nodeProc.Count))"
Check ($mgrProc.Count -eq 1) "A2 exactly one manager process ($($mgrProc.Count))"
$runNode = Get-Content -Raw (Join-Path $Root 'run-node.cmd')
Check ($runNode -like "*\hvnode\$c8\windows\node*") "A2 run-node.cmd runs the tree $c8"

# A3: the manager: preflight passed, the backend, the runtime the node names
try {
  $h = GetJson "http://127.0.0.1:$ManagerPort/health"
  Check ($h.canStart -eq $true) "A3 manager /health canStart=true"
  Check ("$($h.backend)" -eq 'hyperv-partition-per-app') "A3 manager backend $($h.backend)"
  Check ("$($h.catalog.runtimeId)" -eq $RuntimeId) "A3 manager catalog.runtimeId = the node's ENCLAVE_ISOLATION_RUNTIME_ID ($("$($h.catalog.runtimeId)".Substring(0, [Math]::Min(8, "$($h.catalog.runtimeId)".Length))))"
  Check ($h.boundary.hostExcluded -ne $true) ("A3 manager boundary.hostExcluded={0} (never claimed: T0-hv, monitor-signed)" -f $h.boundary.hostExcluded)
} catch { Say 'FAIL' "A3 manager /health: $($_.Exception.Message)" }

# A4: the node (loopback surface): the hv role, engine retired, owner-only, registered, gas
try {
  $a = GetJson "http://127.0.0.1:$LocalPort/availability"
  Check ("$($a.role)" -eq 'windows-hv-node') "A4 node role $($a.role)"
  Check ($null -eq $a.teeCpu) 'A4 node teeCpu is null (no TEE claim)'
  Check ("$($a.claimScope)" -eq 'owner-only') "A4 claimScope $($a.claimScope)"
  Check ("$($a.operator)".ToLower() -eq $Operator.ToLower()) "A4 operator $($a.operator)"
  Check ($a.registered -eq $true) 'A4 registered on chain'
  $owners = @($a.owners | ForEach-Object { "$_".ToLower() })
  Check ($owners -contains $Operator.ToLower()) ("A4 owners served: {0} (the operator, plus each valid delegation)" -f ($owners -join ', '))
  Check ([int]$a.gasRenewalsLeft -gt 200) "A4 gasRenewalsLeft $($a.gasRenewalsLeft) (> 200; GAS.md)"
  Check ("$($a.tier)" -eq 'hv-node') "A4 relay verdict tier $($a.tier) (the attach was accepted)"
  # P2 is on main (013deb51): a missing availability.isolation is a FAIL now (b4's F4)
  Check ("$($a.isolation)" -eq 'hyperv-partition-per-app') "A4 advertises isolation $($a.isolation) (test 1's deploy --isolation needs it)"
  $v = GetJson "http://127.0.0.1:$LocalPort/v1/health"
  Check ("$($v.engine)" -eq 'retired') "A4 engine $($v.engine)"
} catch { Say 'FAIL' "A4 node loopback: $($_.Exception.Message)" }

# A5: the logs: the attach, and no legacy engine
$log = Join-Path $Root 'logs\node.log'
if (Test-Path $log) {
  $tail = Get-Content $log -Tail 400
  Check (@($tail | Select-String -SimpleMatch 'ee-host').Count -eq 0) 'A5 node.log never starts ee-host'
  Say 'INFO' ("A5 node.log attach lines: " + (@($tail | Select-String -Pattern 'attest|attach|hv-node' | Select-Object -Last 3 | ForEach-Object { $_.Line.Substring(0, [Math]::Min(140, $_.Line.Length)) }) -join ' | '))
} else { Say 'FAIL' "A5 no $log" }

# A6: M3 is applied (permanent), as recorded
$virt = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization'
Check (((Get-ItemProperty -Path $virt -Name AllowFirmwareLoadFromFile -ErrorAction SilentlyContinue).AllowFirmwareLoadFromFile) -eq 1) 'A6 AllowFirmwareLoadFromFile = 1'
Check (Test-Path (Join-Path $virt 'GuestCommunicationServices\00002329-facb-11e6-bd58-64006a7986d3')) 'A6 hv_sock 9001 GUID registered'
# ONE M3 path (enclave-87): enclave-53's host-prereq.ps1, run through d1's m3-run.ps1; its record, for the REAL root
$rec = 'C:\Users\claude\vbs-like\host-prereq\prior-state.json'
if (Test-Path $rec) { $rr = [string](Get-Content -Raw $rec | ConvertFrom-Json).regRoot
  Check ($rr -like 'HKLM:*') "A6 host-prereq's prior-state record is for $rr (host-prereq.ps1 -Rollback restores it)" }
else { Say 'FAIL' "A6 no host-prereq record at $rec" }

# A7 (with -DeploymentId): the test deployment runs as a partition, and the manager's view is T0-hv, host not excluded
if ($DeploymentId) {
  try {
    $vms = (GetJson "http://127.0.0.1:$ManagerPort/vms").vms
    $mine = @($vms | Where-Object { "$($_.name)".ToLower() -eq $DeploymentId.ToLower() })
    Check ($mine.Count -eq 1) "A7 the manager holds one VM for $($DeploymentId.Substring(0,10))"
    if ($mine.Count -eq 1) {
      Check ("$($mine[0].status)" -eq 'running') "A7 its status $($mine[0].status)"
      Check ("$($mine[0].tier)" -match '^(?i)t0-hv$') "A7 its tier $($mine[0].tier)"
      Check ($mine[0].hostExcluded -ne $true) 'A7 hostExcluded is not claimed'
      Say 'INFO' ("A7 transportKeySha256 {0} (hvnode-accept-remote.sh compares the public TLS key with it)" -f $mine[0].transportKeySha256)
    }
  } catch { Say 'FAIL' "A7 manager /vms: $($_.Exception.Message)" }
}
# A9 (with -DeploymentId): N1 on the NODE, through its loopback port. The session is minted ON the node (SIWE nonce +
# login), by a throwaway wallet that lives only in the check script, or, with -OwnerRestart, by the operator key read in
# the script from state\operator.key (never printed). The script runs from the node tree, so `viem` resolves.
if ($DeploymentId) {
  $n1 = Join-Path $Root "$c8\windows\node\n1check-$([guid]::NewGuid().ToString('N')).mjs"
  Set-Content -Path $n1 -Encoding ASCII -Value @'
import fs from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
const [base, id, keyFile] = process.argv.slice(2);
const req = async (method, p, body, token) => {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  return [r.status, await r.json().catch(() => ({}))];
};
async function session(acct) {
  const [ns, n] = await req("GET", `/v1/auth/nonce?address=${acct.address}`);
  if (ns !== 200 || !n.message) return null;
  const [ls, l] = await req("POST", "/v1/auth/login", { message: n.message, signature: await acct.signMessage({ message: n.message }) });
  return ls === 200 && l.token ? l.token : null;
}
const out = [];
out.push(`none=${(await req("POST", `/v1/deployments/${id}/restart`, {}))[0]}`);
const st = await session(privateKeyToAccount(generatePrivateKey()));
out.push(`stranger=${st ? (await req("POST", `/v1/deployments/${id}/restart`, {}, st))[0] : "nosession"}`);
if (keyFile) {
  let k = fs.readFileSync(keyFile, "utf8").trim(); if (!k.startsWith("0x")) k = "0x" + k;
  const ot = await session(privateKeyToAccount(k)); k = null;
  out.push(`owner=${ot ? (await req("POST", `/v1/deployments/${id}/restart`, {}, ot))[0] : "nosession"}`);
}
console.log(out.join(" "));
'@
  try {
    $keyArg = $(if ($OwnerRestart) { Join-Path $Root 'state\operator.key' } else { '' })
    $e = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $res = [string](& $NodeExe $n1 "http://127.0.0.1:$LocalPort" $DeploymentId.ToLower() $keyArg 2>&1) } finally { $ErrorActionPreference = $e }
  } finally { Remove-Item -Force $n1 -ErrorAction SilentlyContinue }
  Say 'INFO' "A9 node loopback N1 check: $res"
  Check ($res -match '(^| )none=401( |$)') 'A9 a restart with NO session is 401 on the node (N1)'
  Check ($res -match '(^| )stranger=404( |$)') "A9 a stranger's own session is 404 on the node (not the owner)"
  if ($OwnerRestart) { Check ($res -match '(^| )owner=200( |$)') "A9 the operator's own session restarts its own deployment (200)" }
}

# A8 (-KillRecovery): each loop brings its process back
function Recover([string]$what, [scriptblock]$procs, [string]$url) {
  $p = @(& $procs)
  if ($p.Count -ne 1) { Say 'FAIL' "A8 ${what}: $($p.Count) processes before the kill (need exactly one)"; return }
  $old = $p[0].ProcessId
  Stop-Process -Id $old -Force
  $deadline = (Get-Date).AddSeconds(60); $ok = $false
  while ((Get-Date) -lt $deadline -and -not $ok) {
    Start-Sleep -Seconds 3
    $n = @(& $procs)
    if ($n.Count -eq 1 -and $n[0].ProcessId -ne $old) { try { $null = GetJson $url; $ok = $true } catch { } }
  }
  Check $ok "A8 $what killed (pid $old) and back within 60 s through its run loop"
}
if ($KillRecovery) {
  Recover 'node agent' ${function:AgentProcs} "http://127.0.0.1:$LocalPort/availability"
  Recover 'manager' ${function:MgrProcs} "http://127.0.0.1:$ManagerPort/health"
}
if ($script:fails -gt 0) { Write-Output "ACCEPT (box): $($script:fails) FAIL(s)"; exit 1 }
Write-Output 'ACCEPT (box): all PASS'
