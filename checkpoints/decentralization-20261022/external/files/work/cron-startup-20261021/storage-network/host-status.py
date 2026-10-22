# READ-ONLY: the privacy agent's own status snapshot (network\state\status.json; manager.status()) for cron + sia-s3 only,
# plus fleet-wide ready counts and DISTINCT error/degraded strings. No addresses, keys or tokens are output.
import importlib.util, json, pathlib
p = pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/work/nucbox-tls-20261021/root-activate-reviewed.py')
s = importlib.util.spec_from_file_location('transport', p); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
r = m.ps(r"""$f=@(Get-ChildItem -LiteralPath 'C:\ProgramData\Enclave\network\state' -File -Filter 'status*.json'|Sort-Object LastWriteTime -Descending);$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o');files=@($f|ForEach-Object {$_.Name})};
if($f){$j=Get-Content -Raw -LiteralPath $f[0].FullName|ConvertFrom-Json;$st=$j;if($j.PSObject.Properties.Name -contains 'status'){$st=$j.status};if($j.PSObject.Properties.Name -contains 'value'){$st=$j.value};
 $o.updatedAt=$st.updatedAt;$apps=@($st.apps);$o.appCount=$apps.Count;$o.readyCount=@($apps|Where-Object {$_.ready}).Count;
 $o.errors=@($apps|Where-Object {$_.error}|ForEach-Object {[string]$_.error}|Sort-Object -Unique);$o.degraded=@($apps|Where-Object {$_.degraded}|ForEach-Object {[string]$_.degraded}|Sort-Object -Unique);
 $o.apps=@($apps|Where-Object {$_.deploymentId -like '0x38f368d6*' -or $_.deploymentId -like '0xef514ed3*'}|ForEach-Object {[ordered]@{id=([string]$_.deploymentId).Substring(0,10);ready=$_.ready;error=$_.error;degraded=$_.degraded;ingress=$_.ingress;egress=$_.egress;leaseUntil=$_.leaseUntil;proofUntil=$_.proofUntil;
   circuits=@($_.circuits|ForEach-Object {[ordered]@{kind=$_.kind;healthy=$_.healthy;ingress=$_.ingress;egress=$_.egress;exit=$(if($_.exit){([string]$_.exit.providerId).Substring(0,8)+'/'+$_.exit.region}else{$null});guard=$(if($_.guard){([string]$_.guard.providerId).Substring(0,8)+'/'+$_.guard.region}else{$null})}})}})}
$o|ConvertTo-Json -Depth 6 -Compress""", secs=80)
pathlib.Path(__file__).with_suffix('.json').write_text(json.dumps(r, indent=1) + '\n'); print(json.dumps(r, indent=1))
