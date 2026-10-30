# READ-ONLY canary for the Windows node (minipc): any TCP connection from the node's node.exe processes to the public Base RPC
# providers in actual use, sampled for -Seconds. Changes nothing. Exit 0 none seen, 1 seen, 3 no node process.
param([int]$Seconds = 300, [string[]]$ExtraHosts = @())
$hosts = @('base-rpc.publicnode.com','base.drpc.org','mainnet.base.org','base-mainnet.public.blastapi.io','1rpc.io') + $ExtraHosts
$ips = @{}; foreach ($h in $hosts) { try { foreach ($a in [System.Net.Dns]::GetHostAddresses($h)) { $ips[$a.IPAddressToString] = $h } } catch {} }
$procs = Get-Process -Name node -ErrorAction SilentlyContinue
if (-not $procs) { Write-Output "no node process: canary NOT RUN"; exit 3 }
$hits = 0; $end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  foreach ($c in Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $procs.Id -contains $_.OwningProcess }) {
    if ($ips.ContainsKey($c.RemoteAddress)) { Write-Output "HIT $(Get-Date -Format o) pid=$($c.OwningProcess) -> $($ips[$c.RemoteAddress]) $($c.State)"; $hits++ } }
  Start-Sleep -Seconds 2 }
Write-Output "## windows node: $hits provider connection sample(s) in $Seconds s"
if ($hits -eq 0) { exit 0 } else { exit 1 }
