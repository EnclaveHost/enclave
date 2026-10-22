# 12-prepare-relay-dir.ps1 - CREATE-ONLY: the relay's private data directory, SYSTEM + Administrators only (inheritance
# removed), made EMPTY before root copies the moved key and send record into it. Nothing else is created or changed.
#   powershell -NoProfile -ExecutionPolicy Bypass -File <stage>\12-prepare-relay-dir.ps1
# Exit 0 made (or already exactly that, and empty) | 2 refused: it exists with other permissions or with files in it.
param([string]$Stage = $PSScriptRoot)
. (Join-Path $Stage 'common.ps1')
if (Test-Path -LiteralPath $RelayData) {
  $files = @(Get-ChildItem -LiteralPath $RelayData -Force)
  if ((RelayDirAclOk) -and $files.Count -eq 0) { Say "$RelayData already exists, SYSTEM + Administrators only, empty: nothing to do"; exit 0 }
  Say "refused: $RelayData exists ($($files.Count) entr$(if ($files.Count -eq 1) { 'y' } else { 'ies' }), permissions ok: $(RelayDirAclOk)); nothing was changed"; exit 2
}
New-Item -ItemType Directory -Path $RelayData | Out-Null
& icacls.exe $RelayData /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (RelayDirAclOk)) { Say "error: $RelayData could not be restricted; remove the EMPTY directory and retry"; exit 1 }
Say "made $RelayData (SYSTEM + Administrators only, empty). Root now copies relay.key and relay-send.json into it, create-only"
exit 0
