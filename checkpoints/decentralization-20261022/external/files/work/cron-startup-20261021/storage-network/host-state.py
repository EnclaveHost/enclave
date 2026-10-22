# READ-ONLY: node/manager state for cron + its storage app, egress-route PRESENCE (booleans/field names, never values),
# and the storage VM console's egress/error lines (tail 400, last 20, redacted). Transport: root-state.py's import.
import importlib.util, json, pathlib, re
p = pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/work/nucbox-tls-20261021/root-activate-reviewed.py')
s = importlib.util.spec_from_file_location('transport', p); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
r = m.ps(r"""$ids=@('0x38f368d67995676e0bbe48ebbc1d18a643bb314942374b44e1e52239a1cd215c','0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238');
$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')};
$s=Invoke-RestMethod -TimeoutSec 15 'http://127.0.0.1:9600/v1/host/state';$o.deployments=@($s.deployments|Where-Object {$ids -contains $_.id}|Select-Object id,status,reason);
$v=Invoke-RestMethod -TimeoutSec 15 'http://127.0.0.1:8091/vms';$o.vms=@($v.vms|Where-Object {$ids -contains $_.name}|Select-Object id,name,status,recovered,reason);
$er='C:\ProgramData\Enclave\network\state\egress-routes.json';if(Test-Path -LiteralPath $er){$j=Get-Content -Raw -LiteralPath $er|ConvertFrom-Json;$o.egressFileUtc=(Get-Item -LiteralPath $er).LastWriteTimeUtc.ToString('o');
 $o.egress=@(foreach($id in $ids){$k=$id.Substring(2,8);$hit=@($j.PSObject.Properties|Where-Object {$_.Name -like ('*'+$k+'*')});[ordered]@{app=$k;topLevelHit=$hit.Count;textHit=([regex]::Matches((Get-Content -Raw -LiteralPath $er),$k)).Count}})}
$sv=@($v.vms|Where-Object {$_.name -eq $ids[1]})|Select-Object -First 1;
if($sv){$pre=([string]$sv.id).Substring(0,16);$f=@(Get-ChildItem -LiteralPath 'C:\ProgramData\Enclave\logs\partitions' -File|Where-Object {$_.Name -like ('*'+$pre+'*')}|Sort-Object LastWriteTime -Descending|Select-Object -First 1);
 if($f){$o.storageConsole=$f[0].Name;$o.storageLines=@(Get-Content -LiteralPath $f[0].FullName -Tail 400|Select-String -Pattern 'egress|refused|timeout|error|fail|upstream|backend|renterd|sia|unavailable'|Select-Object -Last 20|ForEach-Object {$_.Line})}}
$o|ConvertTo-Json -Depth 5 -Compress""", secs=100)
red = [(re.compile(r'\b(?:0x)?[0-9a-fA-F]{40,}\b'), lambda x: x.group(0)[:10] + '…'), (re.compile(r'\b[A-Za-z0-9+/_-]{40,}={0,2}\b'), lambda x: x.group(0)[:6] + '…<redacted>'),
       (re.compile(r'(?i)((?:key|secret|token|password|authorization|signature)["\'=: ]+)\S{6,}'), r'\1<redacted>')]
def rd(x):
    for a, b in red: x = a.sub(b, x)
    return x[:300]
if isinstance(r, dict): r['storageLines'] = [rd(x) for x in (r.get('storageLines') or [])]
pathlib.Path(__file__).with_suffix('.json').write_text(json.dumps(r, indent=1) + '\n'); print(json.dumps(r, indent=1))
