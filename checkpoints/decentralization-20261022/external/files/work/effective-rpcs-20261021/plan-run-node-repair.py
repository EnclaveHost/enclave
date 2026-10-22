#!/usr/bin/env python3
"""READ-ONLY plan for the run-node.cmd BASE_RPCS repair, computed IN MEMORY on minipc (nothing is written):
  - CAS: run-node.cmd must be sha 3366a005…;
  - exactly ONE line (allowing surrounding blanks/tabs) equal to  set "BASE_RPCS=<publicnode>,<drpc>,<mainnet>"  (the 3-host
    override), at line 12, CRLF-terminated, and the NEXT line is the agent.mjs launch;
  - exactly ONE 5-host line  set "BASE_RPCS=<publicnode>,<tenderly>,<nodies>,<drpc>,<mainnet>"  at line 5;
  - remove ONLY that 3-host line (its bytes and its CRLF), byte-exact (Latin-1 round trip, no re-encoding);
  - report: old/new sha256, removed byte count, the new file's line count, and which BASE_RPCS assignment is now the last
    one before the launch line (host names only).
Returns only hashes, counts, line numbers and host names. -> repair-plan.json"""
import base64, importlib.util, json, pathlib, sys
here = pathlib.Path(__file__).resolve().parent
s = importlib.util.spec_from_file_location('r', here / 'read-rpc-assignments.py'); R = importlib.util.module_from_spec(s); s.loader.exec_module(R)
OLD = "3366a005f8530903c83a334053280f41ed904df09133e92505c44f558acb6686"
K = r"""$f='C:\ProgramData\Enclave\run-node.cmd';$E=[Text.Encoding]::GetEncoding(28591);$b=[IO.File]::ReadAllBytes($f);$t=$E.GetString($b);
$H=[Security.Cryptography.SHA256]::Create();function S($x){(($H.ComputeHash($x)|ForEach-Object{$_.ToString('x2')}) -join '')}
$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o');oldSha=(S $b);casOk=((S $b) -eq 'OLDSHA');bytes=$b.Length};
$p3='(?m)^[ \t]*set "BASE_RPCS=https://base-rpc\.publicnode\.com,https://base\.drpc\.org,https://mainnet\.base\.org"[ \t]*\r\n';
$p5='(?m)^[ \t]*set "BASE_RPCS=https://base-rpc\.publicnode\.com,https://base\.gateway\.tenderly\.co,https://base-public\.nodies\.app,https://base\.drpc\.org,https://mainnet\.base\.org"[ \t]*\r\n';
$m3=[regex]::Matches($t,$p3);$m5=[regex]::Matches($t,$p5);$o.match3=$m3.Count;$o.match5=$m5.Count;
function LineOf($i){([regex]::Matches($t.Substring(0,$i),"`n")).Count+1}
if($m3.Count -eq 1 -and $m5.Count -eq 1){$i=$m3[0].Index;$o.line3=LineOf $i;$o.line5=LineOf $m5[0].Index;$rest=$t.Substring($i+$m3[0].Length);$nx=($rest -split "`r`n",2)[0];$o.nextIsLaunch=($nx -match 'agent\.mjs');
$n=$t.Remove($i,$m3[0].Length);$nb=$E.GetBytes($n);$o.removedBytes=$m3[0].Length;$o.newBytes=$nb.Length;$o.newSha=(S $nb);$o.newLines=($n -split "`r`n").Count;
$L=$n -split "`r`n";$li=-1;for($k=0;$k -lt $L.Count;$k++){if($L[$k] -match 'agent\.mjs'){$li=$k;break}};$last=$null;for($k=0;$k -lt $li;$k++){if($L[$k] -match '^(?i)\s*set\s+"?BASE_RPCS='){$last=$k}};
$o.newLaunchLine=$li+1;$o.newLastAssignLine=$(if($null -ne $last){$last+1}else{0});$o.newEffectiveHosts=$(if($null -ne $last){@([regex]::Matches($L[$last],'https://([A-Za-z0-9.-]+)')|ForEach-Object{$_.Groups[1].Value})}else{@()});
$o.planOk=($o.casOk -and $o.line3 -eq 12 -and $o.line5 -eq 5 -and $o.nextIsLaunch -and $o.newEffectiveHosts.Count -eq 5)}else{$o.planOk=$false};
$j=$o|ConvertTo-Json -Depth 5 -Compress;@{payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))}|ConvertTo-Json -Compress""".replace("OLDSHA", OLD)
if __name__ == "__main__":
    if "--size" in sys.argv:
        print(len(base64.b64encode((R.m.HEAD.replace("SECS", "90") + R.flat(K)).encode("utf-16-le")))); sys.exit(0)
    r = R.run(K)
    (here / 'repair-plan.json').write_text(json.dumps(r, indent=1) + '\n'); print(json.dumps(r, indent=1))
    sys.exit(0 if r.get('planOk') else 1)
