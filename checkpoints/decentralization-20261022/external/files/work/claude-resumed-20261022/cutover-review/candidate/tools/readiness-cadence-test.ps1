# Simulated-clock check of the NATIVE readiness poll (not a Windows measurement). Inputs from read-only evidence:
# listener query ~10.5 s (native-cutover-ops inspect.json 10499 ms / 9714 ms), host-state query ~0.5 s (468 ms),
# agent lease pass: immediate tick after boot, then every 30 s (host.mjs TICK_MS). LeaseReady demands completedAt < 5 s old.
param([string]$Source, [double]$ListenerSec = 10.5, [int]$Expect = -1)
$ErrorActionPreference = 'Stop'; $tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Source), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'parse errors' }
foreach ($name in 'Lim','ReadinessNumber','LeaseReady','AgentUp','StartNode','PollRoom','OwnsAgentPort','IsoMs','Iso') {
  $f = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true))
  if ($f.Count -eq 1) { . ([scriptblock]::Create($f[0].Extent.Text)) } elseif ($name -notin 'PollRoom','OwnsAgentPort') { throw "function $name missing" } }
$script:Fwd = $false; $TR = ''; $BoundSec = 100000
$PRM = [pscustomobject]@{ expectedIds = @('a','b'); runner = 'r'; lease = [pscustomobject]@{ marginSec = 180 } }
$epoch0 = [datetime]::new(2026,10,22,0,0,0,[DateTimeKind]::Utc)
function Get-Date { $script:clock }
function Start-Sleep { param([int]$Seconds = 0, [int]$Milliseconds = 0) $script:clock = $script:clock.AddMilliseconds($Seconds * 1000 + $Milliseconds) }
function Left { 100000 }
function NowMs { [DateTimeOffset]::new($script:clock).ToUnixTimeMilliseconds() }
function NowS { [DateTimeOffset]::new($script:clock).ToUnixTimeSeconds() }
function Ms($t) { [DateTimeOffset]::new($t).ToUnixTimeMilliseconds() }
function NodeTask($a, $l) { }
function NodeProcs($l) { [ordered]@{ cmd = @(@{ pid = 10; start = 'x' }); agent = @([ordered]@{ pid = 11; parent = 10; start = $script:agentStart.ToString('o') }) } }
function Listeners($port, $l) { $script:clock = $script:clock.AddSeconds([math]::Min($ListenerSec, $l)); if ($ListenerSec -gt $l) { throw 'query deadline' }; @([pscustomobject]@{ OwningProcess = 11 }) }
function HostState($l) {
  $script:clock = $script:clock.AddMilliseconds(500)
  # passes: first starts at boot (agent start + 20 s), then every 30 s; each pass takes 3 s
  $since = ($script:clock - $script:agentStart).TotalSeconds - 20; $c = $null; $s = $null; $inFlight = $false
  if ($since -ge 0) { $k = [math]::Floor($since / 30); $st = $script:agentStart.AddSeconds(20 + 30 * $k)
    if (($script:clock - $st).TotalSeconds -lt 3) { $inFlight = $true; if ($k -gt 0) { $st = $st.AddSeconds(-30); $c = $st.AddSeconds(3) } else { $st = $null } } else { $c = $st.AddSeconds(3) } ; $s = $st }
  $until = (NowS) + 1700
  $r = $(if ($s -and $c) { [pscustomobject]@{ sequence = 1; startedAt = (Ms $s); completedAt = (Ms $c); inFlight = $inFlight
         deployments = @('a','b' | ForEach-Object { [pscustomobject]@{ id = $_; sequence = 1; status = 'ready'; observedAt = (Ms $s); checkedAt = (Ms $c); leaseUntil = $until; runner = 'r' } }) } } else { $null })
  [pscustomobject]@{ deployments = @('a','b' | ForEach-Object { [pscustomobject]@{ id = $_; status = 'running'; leaseUntil = $until } }); leaseReadiness = $r } }
$ok = 0; $offsets = 0..59
foreach ($o in $offsets) {
  # $o = sub-second phase (0.5 s steps) between the coordinator's poll loop and the agent's tick schedule
  $script:agentStart = $epoch0; $script:clock = $epoch0.AddMilliseconds(500 * $o)
  if (StartNode 150) { $ok++ } }
$res = [ordered]@{ listenerSec = $ListenerSec; phases = $offsets.Count; readyWithin150 = $ok; parseErrors = $errors.Count }
$res | ConvertTo-Json -Compress
if ($Expect -ge 0 -and $ok -lt $Expect) { exit 3 }
