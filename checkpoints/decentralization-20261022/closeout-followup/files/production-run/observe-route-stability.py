"""Read-only aggregate of native network logs. No config, keys or raw logs leave the host."""
import importlib.util,json,pathlib
root=pathlib.Path(__file__).resolve().parents[3]
s=importlib.util.spec_from_file_location('transport',root/'work/nucbox-tls-20261021/root-activate-reviewed.py')
t=importlib.util.module_from_spec(s);s.loader.exec_module(t)
p=r'''[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
$path='C:\ProgramData\Enclave\logs\network.log'
$mtime=(Get-Item $path).LastWriteTimeUtc
$lines=@(Get-Content $path -Tail 12000|ForEach-Object {[string]::Concat('',$_)})
$day=$mtime.Date;$previous=$mtime.TimeOfDay;$cut=[datetime]::Parse('2026-10-23T01:19:00Z').ToUniversalTime()
$n=0;$off=0;$back=0;$wallet=0;$quorum=0;$first=$null;$last=$null;$earliest=$null;$rollovers=0
for($i=$lines.Count-1;$i -ge 0;$i--){
 $line=$lines[$i]
 if($line -notmatch '^(\d{2}:\d{2}:\d{2}) '){continue}
 $tod=[timespan]::Parse($Matches[1])
 if($tod -gt $previous){$day=$day.AddDays(-1);$rollovers++}
 $at=$day.Add($tod);$previous=$tod;$earliest=$at
 if($at -lt $cut){continue}
 $n++;$first=$at;if($null -eq $last){$last=$at}
 if($line.Contains('egress OFF')){$off++}
 if($line.Contains('egress back')){$back++}
 if($line.Contains('wallet admission withheld')){$wallet++}
 if($line.Contains('chain quorum unavailable')){$quorum++}
}
[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o');from=$cut.ToString('o');fileLastWriteUtc=$mtime.ToString('o');linesRead=$lines.Count;recentLines=$n;coveredStart=($earliest -le $cut);earliestInTail=$earliest;firstRecent=$first;lastRecent=$last;clockRollovers=$rollovers;egressOff=$off;egressBack=$back;walletWithheld=$wallet;chainQuorumUnavailable=$quorum}|ConvertTo-Json -Compress'''
x=t.ps(p,40)
x['method']='Dates reconstructed backwards from file LastWriteTimeUtc and time-only log lines, decrementing date at midnight. Counts cover this file tail only; clock changes or missing/rotated logs limit inference. Zero matching lines is NOT evidence of stability.'
x['usable']=bool(x.get('coveredStart') and x.get('recentLines',0)>0 and 'error' not in x)
(root/'outputs/decentralization-audit/windows-route-stability-20261023.json').write_text(json.dumps(x,indent=2)+'\n')
print(json.dumps(x))
