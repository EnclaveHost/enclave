<#
  Stage 2 of the Enclave VBS dry run. Runs once, after the reboot that follows
  Hyper-V being enabled. Runs the probe, writes everything to the FAT32 results
  disk, shuts the VM down.

  Nothing here is Enclave-specific beyond invoking the probe; it exists so the
  whole test is unattended and the host can read the answer off a disk image.
#>
$ErrorActionPreference = 'Continue'

function Get-ResultsDrive {
    # The results disk is a small FAT32 volume labelled ENCRESULT.
    foreach ($v in (Get-Volume -ErrorAction SilentlyContinue)) {
        if ($v.FileSystemLabel -eq 'ENCRESULT' -and $v.DriveLetter) { return "$($v.DriveLetter):" }
    }
    # Fall back to any writable removable/fixed volume that is not C:
    foreach ($v in (Get-Volume -ErrorAction SilentlyContinue)) {
        if ($v.DriveLetter -and $v.DriveLetter -ne 'C' -and $v.FileSystemType -match 'FAT') { return "$($v.DriveLetter):" }
    }
    return 'C:'
}

$out = Get-ResultsDrive
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $out "vbs-dryrun-$stamp.txt"

Start-Transcript -Path $log -Force | Out-Null

Write-Host "=== Enclave VBS dry run ==="
Write-Host "results drive: $out"
Write-Host "OS: $((Get-CimInstance Win32_OperatingSystem).Caption) build $((Get-CimInstance Win32_OperatingSystem).BuildNumber)"

# Hyper-V may still be settling after the feature install + reboot.
for ($i = 0; $i -lt 30; $i++) {
    if (Get-Command Get-VMHost -ErrorAction SilentlyContinue) { break }
    Start-Sleep -Seconds 10
}

if (-not (Get-Command Get-VMHost -ErrorAction SilentlyContinue)) {
    Write-Host 'FAIL: Hyper-V PowerShell module never appeared. Feature install did not complete.'
} else {
    Write-Host "Hyper-V module present."
    try { Get-VMHost | Format-List * | Out-String | Write-Host } catch { Write-Host "Get-VMHost failed: $($_.Exception.Message)" }

    $probe = 'C:\enclave\Test-EnclaveHost.ps1'
    if (-not (Test-Path $probe)) {
        Write-Host "FAIL: probe not found at $probe"
    } else {
        Write-Host ''
        Write-Host '--- probe: VBS dry run ---'
        Push-Location $out
        try {
            & $probe -Attempt -IsolationType VBS
        } catch {
            Write-Host "probe threw: $($_.Exception.Message)"
            Write-Host $_.ScriptStackTrace
        }
        Pop-Location

        Write-Host ''
        Write-Host '--- probe: inspection-only SNP view (expected to fail on this host; recorded for contrast) ---'
        Push-Location $out
        try { & $probe -IsolationType SNP } catch { Write-Host "probe(SNP) threw: $($_.Exception.Message)" }
        Pop-Location
    }
}

Write-Host ''
Write-Host "=== done: $(Get-Date -Format o) ==="
Stop-Transcript | Out-Null

# Leave a marker the host can test for without parsing the transcript.
try { Set-Content -Path (Join-Path $out 'COMPLETE') -Value $stamp -Encoding ascii } catch { }

# PRIMARY result channel: COM1. The host captures it to a file with
# `-serial file:...`, so nothing has to be mounted or formatted afterwards, and
# it works even if the results disk never appeared.
try {
    $body = Get-Content -Path $log -Raw -ErrorAction Stop
    $port = New-Object System.IO.Ports.SerialPort 'COM1', 115200, 'None', 8, 'One'
    $port.WriteTimeout = 15000
    $port.Open()
    $port.WriteLine('===ENCLAVE-PROBE-BEGIN===')
    foreach ($line in ($body -split "`r?`n")) { $port.WriteLine($line) }
    $port.WriteLine('===ENCLAVE-PROBE-END===')
    Start-Sleep -Seconds 2
    $port.Close()
} catch {
    # If the serial write fails there is nowhere left to report it to; the
    # results disk and C:\enclave copy are the fallbacks.
    try { Copy-Item $log 'C:\enclave\' -Force -ErrorAction SilentlyContinue } catch { }
}

Start-Sleep -Seconds 5
shutdown /s /t 5 /c "enclave probe complete"
