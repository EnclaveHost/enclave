#!/usr/bin/env bash
# read-only: owner + ACEs of the staging root chain and the backup parent chain on minipc (G3 fact)
cd /home/steven/Documents/Codex/2026-10-18/wo/work/host-service-transport-20261021/public-canary-resume/a5-authority/final/tunnel-install
date -u +%FT%TZ
timeout 120 python3 -c "
import importlib.util,json
s=importlib.util.spec_from_file_location('t','tunnel_install.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
r=m.ps(r'''\$S=[Security.Principal.SecurityIdentifier];\$o=[ordered]@{};foreach(\$q in 'C:\','C:\ProgramData','C:\ProgramData\Enclave','C:\ProgramData\Enclave\staging','C:\ProgramData\Enclave\backup'){if(-not (Test-Path -LiteralPath \$q)){\$o[\$q]='absent';continue};\$a=Get-Acl -LiteralPath \$q;\$o[\$q]=[ordered]@{owner=\$a.GetOwner(\$S).Value;reparse=[bool]((Get-Item -LiteralPath \$q -Force).Attributes -band 1024);protected=\$a.AreAccessRulesProtected;aces=@(\$a.GetAccessRules(\$true,\$true,\$S)|%{\$_.AccessControlType.ToString()+' '+\$_.IdentityReference.Value+' 0x'+([int]\$_.FileSystemRights).ToString('X8')+' prop='+[int]\$_.PropagationFlags+' inh='+[int]\$_.InheritanceFlags+' inherited='+\$_.IsInherited})}}''')
print(json.dumps(r,indent=1)); m.rec('ancestor-acl-facts',r)"
date -u +%FT%TZ
