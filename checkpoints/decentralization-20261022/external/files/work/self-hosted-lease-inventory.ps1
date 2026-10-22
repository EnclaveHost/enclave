$ErrorActionPreference='Stop'
$apps=Invoke-RestMethod -Uri http://127.0.0.1:9600/v1/deployments -TimeoutSec 15
$rows=if($apps.deployments){$apps.deployments}else{$apps}
$rows|ForEach-Object{
  [pscustomobject]@{
    id=$_.id
    name=$_.name
    status=$_.status
  }
}|ConvertTo-Json -Depth 3 -Compress
