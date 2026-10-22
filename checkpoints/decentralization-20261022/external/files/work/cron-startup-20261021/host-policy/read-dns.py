#!/usr/bin/env python3
"""READ-ONLY: minipc's DNS client configuration (interface alias + server addresses only) and whether the five RPC host
names resolve right now through the system resolver (Resolve-DnsName: a name lookup, no request to any RPC). -> read-dns.json"""
import json, pathlib
src = pathlib.Path(__file__).with_name('read-live.py').read_text().split('D = r"C:')[0]
ns = {}; exec(src, ns); ps = ns['ps']
script = ("$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')};"
  "$o.servers=@(Get-DnsClientServerAddress -AddressFamily IPv4|Where-Object{$_.ServerAddresses.Count}|ForEach-Object{[ordered]@{if=$_.InterfaceAlias;servers=@($_.ServerAddresses)}});"
  "$o.resolve=@(foreach($h in @('base-rpc.publicnode.com','base.gateway.tenderly.co','base-public.nodies.app','base.drpc.org','mainnet.base.org')){$t0=Get-Date;"
  "try{$r=@(Resolve-DnsName -Name $h -Type A -DnsOnly -QuickTimeout -ErrorAction Stop|Where-Object{$_.IPAddress});[ordered]@{h=$h;ok=$true;n=$r.Count;ms=[int]((Get-Date)-$t0).TotalMilliseconds}}"
  "catch{[ordered]@{h=$h;ok=$false;err=($_.Exception.Message -replace '[^\\x20-\\x7E]','~').Substring(0,[Math]::Min(120,$_.Exception.Message.Length));ms=[int]((Get-Date)-$t0).TotalMilliseconds}}});"
  "$o|ConvertTo-Json -Depth 4 -Compress")
out = ps(script)
pathlib.Path(__file__).with_name("read-dns.json").write_text(json.dumps(out, indent=1) + "\n"); print(json.dumps(out, indent=1))
