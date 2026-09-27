# Test only the pure identity predicate, without executing capture or host reads.
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $PSScriptRoot 'hvnode-reboot-capture.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$fn = $ast.Find({ param($n)
  $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'TestVmIdentity'
}, $true)
if (-not $fn) { throw 'identity predicate missing' }
. ([scriptblock]::Create($fn.Extent.Text))
$vm = @{ vmId = 'b6dbae7e-0db4-4aa8-9e51-05946d651abd'; name = 'enclave-app-hveb3ce9a43faf3a-9c3d10f1' }
$record = @{ id = 'hveb3ce9a43faf3aaca9759ad8813fd0ea'; launcherVmId = $vm.vmId; vmName = $vm.name }
if (-not (TestVmIdentity $vm $record)) { throw 'real shortened launcher name must match by GUID' }
foreach ($badId in @('', 'not-a-guid', '00000000-0000-0000-0000-000000000000', '11111111-2222-3333-4444-555555555555')) {
  $record.launcherVmId = $badId
  if (TestVmIdentity $vm $record) { throw "accepted missing/malformed/different GUID: $badId" }
}
$record.launcherVmId = $vm.vmId
$record.vmName = 'enclave-app-another'
if (TestVmIdentity $vm $record) { throw 'accepted inconsistent VM name' }
$record.vmName = $vm.name; $vm.vmId = $null
if (TestVmIdentity $vm $record) { throw 'accepted missing Hyper-V GUID' }
Write-Output 'PASS: shortened name accepted; missing, malformed, zero and mismatched IDs and inconsistent name refused'
