# build-repro.ps1 - build vbslike-host.exe TWICE from clean with deterministic flags and record what a pin needs (enclave-d1,
# v42). Run ON THE BOX from a lab copy: -Lab <dir> holding src\windows\vbslike\host (git archive of this crate). Touches only -Lab.
# Deterministic: /Brepro (content-derived timestamp + PDB GUID), /PDBALTPATH:%_PDB% (no build dir in the PE), --remap-path-prefix.
param([Parameter(Mandatory = $true)][string]$Lab)
$ErrorActionPreference = 'Continue'
$env:Path = "$env:USERPROFILE\.cargo\bin;" + $env:Path
function Rec([string]$m) { $l = (Get-Date).ToUniversalTime().ToString('HH:mm:ssZ') + ' ' + $m; Write-Output $l; Add-Content -Path "$Lab\BUILD.txt" -Value $l }
$crate = "$Lab\src\windows\vbslike\host"
Rec "source crate $crate"
Rec ("toolchain: " + ((rustc -vV 2>&1) -join ' | '))
Rec ("cargo: " + (cargo --version 2>&1))
Rec ("Cargo.lock sha256 " + (Get-FileHash "$crate\Cargo.lock" -Algorithm SHA256).Hash.ToLower())
$reg = "$env:USERPROFILE\.cargo\registry\src"
$flags = "--remap-path-prefix=$crate=/vbslike-host --remap-path-prefix=$reg=/cargo-registry -C link-arg=/Brepro -C link-arg=/PDBALTPATH:%_PDB%"
Rec "RUSTFLAGS: $flags"
$env:RUSTFLAGS = $flags
New-Item -ItemType Directory -Force -Path "$Lab\out" | Out-Null
foreach ($k in 1, 2) {
  if (Test-Path "$crate\target") { Remove-Item -Recurse -Force "$crate\target" }
  Push-Location $crate
  $o = cargo build --release --locked 2>&1 | Out-String
  $rc = $LASTEXITCODE
  Pop-Location
  Set-Content -Path "$Lab\out\build$k.log" -Value $o
  if ($rc -ne 0) { Rec "BUILD $k FAILED rc=$rc (see out\build$k.log)"; exit 1 }
  New-Item -ItemType Directory -Force -Path "$Lab\out\build$k" | Out-Null
  Copy-Item "$crate\target\release\vbslike-host.exe" "$Lab\out\build$k\vbslike-host.exe"
  if (Test-Path "$crate\target\release\vbslike_host.pdb") { Copy-Item "$crate\target\release\vbslike_host.pdb" "$Lab\out\build$k\vbslike_host.pdb" }
  $h = (Get-FileHash "$Lab\out\build$k\vbslike-host.exe" -Algorithm SHA256).Hash.ToLower()
  Rec ("build ${k}: vbslike-host.exe sha256 $h, " + (Get-Item "$Lab\out\build$k\vbslike-host.exe").Length + " bytes")
}
$a = [IO.File]::ReadAllBytes("$Lab\out\build1\vbslike-host.exe"); $b = [IO.File]::ReadAllBytes("$Lab\out\build2\vbslike-host.exe")
if ($a.Length -ne $b.Length) { Rec "DIFFER in length: $($a.Length) vs $($b.Length)" }
else {
  $diff = 0; $first = -1
  for ($i = 0; $i -lt $a.Length; $i++) { if ($a[$i] -ne $b[$i]) { $diff++; if ($first -lt 0) { $first = $i } } }
  if ($diff -eq 0) { Rec 'IDENTICAL: the two clean builds are byte-for-byte equal' } else { Rec "DIFFER: $diff byte(s), first at offset 0x$('{0:X}' -f $first)" }
}
# the PE debug directory's PDB path, as a string search (what /PDBALTPATH controls)
$s = [Text.Encoding]::ASCII.GetString($a)
$m = [regex]::Match($s, '[ -~]{0,200}\.pdb')
Rec ("embedded .pdb reference: " + $(if ($m.Success) { $m.Value.Trim() } else { '(none)' }))
Rec ("absolute build path present in exe: " + $s.Contains($crate) + "; registry path present: " + $s.Contains($reg))
# the Rust unit tests for the M4 change, same flags
Push-Location $crate
$t = cargo test --release --locked cert_name 2>&1 | Out-String
$trc = $LASTEXITCODE
Pop-Location
Set-Content -Path "$Lab\out\test.log" -Value $t
Rec ("cargo test cert_name rc=${trc}: " + (($t -split "`n") | Where-Object { $_ -match 'test result|test wmiserve|running \d+ test' } | ForEach-Object { $_.Trim() }) -join ' | ')
