# platform-carrier persistence check (READ-ONLY): the variable NAMES (never values) each launcher file assigns, in order, so root can
# move the hand-edited run-node.cmd settings into node-config.local.cmd before any installer regeneration (update-host.ps1 ->
# install-host.ps1 rewrites run-node.cmd and node-config.cmd; node-config.local.cmd is never written)
NAMES = U + (r"$pd='PDX';$o=[ordered]@{what='names'};foreach($f in 'run-node.cmd','node-config.cmd','node-config.local.cmd'){$p=$pd+'\'+$f;"
    r"$o[$f]=$(try{[ordered]@{sha=FileSha $p;names=@([regex]::Matches([IO.File]::ReadAllText($p),'(?im)^\s*set\s+\x22?([A-Za-z0-9_]+)=')|%{$_.Groups[1].Value});"
    r"calls=@([regex]::Matches([IO.File]::ReadAllText($p),'(?im)^\s*call\s+\x22?[^\x22\r\n]*\\([A-Za-z0-9_.-]+\.cmd)')|%{$_.Groups[1].Value})}}catch{'unreadable'})};$o|ConvertTo-Json -Compress -Depth 4").replace("PDX", PD)
def names_report(r):
    """names only in run-node.cmd (lost on regeneration unless moved) and the last writer of each name in launch order"""
    if not isinstance(r, dict) or "error" in r: return {"error": "unreadable"}
    rn, nc, lo = ((r.get(f) or {}).get("names") or [] for f in ("run-node.cmd", "node-config.cmd", "node-config.local.cmd"))
    return {"onlyInRunNode": sorted(set(rn) - set(nc) - set(lo)), "inRunNodeAndLocal": sorted(set(rn) & set(lo)), "local": sorted(set(lo)),
            "platformPolicyNames": sorted(n for n in set(rn) | set(nc) | set(lo) if n.startswith("ENCLAVE_PLATFORM_HOST_POLICY"))}
