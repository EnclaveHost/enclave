$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$listener=Get-NetTCPConnection -LocalPort 8091 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if(-not $listener){@{checkedAt=[DateTime]::UtcNow.ToString('o');port=8091;listening=$false}|ConvertTo-Json -Compress;exit 0}
$pr=Get-CimInstance Win32_Process -Filter ('ProcessId='+$listener.OwningProcess)
if(-not $pr -or -not $pr.ExecutablePath){throw '8091 process executable unavailable'}
$exe=[string]$pr.ExecutablePath
if([IO.Path]::GetFileName($exe) -ne 'node.exe'){throw '8091 process is not node.exe; refusing execution'}
$metadata=@()
$foundPaths=[regex]::Matches($pr.CommandLine,'(?:"([^"\r\n]+\.mjs)"|([^\s"]+\.mjs))')
foreach($item in $foundPaths){
 $f=if($item.Groups[1].Success){$item.Groups[1].Value}else{$item.Groups[2].Value}
 if(-not [IO.Path]::IsPathRooted($f) -or -not(Test-Path -LiteralPath $f -PathType Leaf)){continue}
 $metadata+=@{kind='process-entry';path=$f;sha256=(Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLowerInvariant()}
 $parent=Split-Path $f
 foreach($name in @('main.mjs','server.mjs','backend.mjs','source-manifest.json')){
  $q=Join-Path $parent $name
  if((Test-Path -LiteralPath $q -PathType Leaf) -and $q -ne $f){$metadata+=@{kind='adjacent-source-not-execution-proof';path=$q;sha256=(Get-FileHash -LiteralPath $q -Algorithm SHA256).Hash.ToLowerInvariant()}}
 }
 # Only an identified release bootstrap has this known fixed relative layout.
 if([IO.Path]::GetFileName($f) -eq 'bootstrap.mjs'){
  foreach($rel in @('control\windows\vbslike\manager\main.mjs','control\windows\vbslike\manager\server.mjs','control\windows\vbslike\manager\backend.mjs')){
   $q=Join-Path $parent $rel
   if(Test-Path -LiteralPath $q -PathType Leaf){$metadata+=@{kind='release-source-not-execution-proof';path=$q;sha256=(Get-FileHash -LiteralPath $q -Algorithm SHA256).Hash.ToLowerInvariant()}}
  }
 }
}
$hash=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
$js="const c=require('node:fs').constants;console.log(JSON.stringify({version:process.version,hasExlock:Object.prototype.hasOwnProperty.call(c,'UV_FS_O_EXLOCK'),exlock:Number.isInteger(c.UV_FS_O_EXLOCK)?c.UV_FS_O_EXLOCK:null}))"
$psi=New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName=$exe;$psi.Arguments='--input-type=commonjs -e "'+$js+'"'
$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
# Prevent inherited Node preload/options from executing unrelated code in this diagnostic child.
$psi.EnvironmentVariables.Remove('NODE_OPTIONS')
$child=New-Object System.Diagnostics.Process;$child.StartInfo=$psi
$null=$child.Start()
if(-not $child.WaitForExit(8000)){try{$child.Kill()}catch{};throw 'diagnostic Node child timed out'}
$out=$child.StandardOutput.ReadToEnd();$err=$child.StandardError.ReadToEnd()
if($child.ExitCode -ne 0 -or $out.Length -gt 4096 -or $err.Length -gt 4096){throw 'diagnostic Node child failed (output withheld)'}
$nodeInfo=$out|ConvertFrom-Json
@{checkedAt=[DateTime]::UtcNow.ToString('o');port=8091;listening=$true;pid=$listener.OwningProcess;created=$pr.CreationDate.ToUniversalTime().ToString('o');executable=$exe;executableSha256=$hash;node=$nodeInfo;modules=$metadata}|ConvertTo-Json -Depth 5 -Compress
