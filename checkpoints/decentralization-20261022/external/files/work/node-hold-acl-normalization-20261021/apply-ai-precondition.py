#!/usr/bin/env python3
"""FAIL-CLOSED PRECONDITION (native ACL fixture 22:28Z): the two config files the cutover rewrites (privacy-config.json,
node-config.local.cmd) must carry an AUTO-INHERITED DACL (SDDL D:...AI..., e.g. D:AI / D:PAI). That is the form proven on
minipc to round-trip the helper's exact-SDDL ProtectedTemp/CasWrite check. A DACL without AI (e.g. D:(...ID...) under a parent
whose DACL lacks AI) is re-written by Set-Acl as D:AI, so the exact check throws mid-cutover (R0). This makes it REFUSE at the
preflight and at the cutover's own pins, BEFORE the node is stopped. ProtectedTemp/CasWrite stay byte-identical; the exact
SDDL comparison is NOT relaxed.
usage: apply-ai-precondition.py <dir with node-hold-cutover.ps1 + root-node-hold.py>   (single-match anchors; refuses otherwise)"""
import hashlib, pathlib, sys
d = pathlib.Path(sys.argv[1])
def rep(p, old, new, name):
    s = p.read_text(); n = s.count(old)
    if n != 1: raise SystemExit(f"{p.name}:{name}: expected 1 anchor, found {n}")
    p.write_text(s.replace(old, new))
ps1, py = d / "node-hold-cutover.ps1", d / "root-node-hold.py"
old_pin = hashlib.sha256(ps1.read_bytes()).hexdigest()
rep(ps1, """  $nw = Writers $NET; $o.networkDirWriters = $nw.writers
""", """  $nw = Writers $NET; $o.networkDirWriters = $nw.writers
  # both files this run rewrites must carry an AUTO-INHERITED DACL (D:AI / D:PAI): the form native-proven to round-trip
  # ProtectedTemp/CasWrite's exact-SDDL check (fixture 22:28Z). Any other form REFUSES here, before the node is stopped.
  foreach ($p in $CFG, $LOCAL) { $df = [regex]::Match([string](Get-Acl -LiteralPath $p).Sddl, 'D:([A-Z]*)\\(').Groups[1].Value
    if ($df -notmatch 'AI') { $why += "$(Split-Path -Leaf $p) has a DACL that is not auto-inherited (D:$df): the exact ACL round-trip would refuse; root fixes that ACL first" } }
""", "cutover-pins")
# a SEPARATE small read-only text (CFGS is near the 7900 transport cap in 9d's controller): the two DACLs, SDDL only
rep(py, """FIL = U + r\"""", """ACLS = U + r"$pd='C:\\ProgramData\\Enclave';[ordered]@{cfgAcl=(Get-Acl -LiteralPath ($pd+'\\network\\privacy-config.json')).Sddl;localAcl=(Get-Acl -LiteralPath ($pd+'\\node-config.local.cmd')).Sddl}|ConvertTo-Json -Compress"   # security descriptors only, never bytes
FIL = U + r\"""", "acl-text")
rep(py, """    idn = m.ps(IDN, 120); cfgs = m.ps(CFGS, 90)
""", """    idn = m.ps(IDN, 120); cfgs = m.ps(CFGS, 90)
    acls = m.ps(ACLS, 60); cfgs = {**cfgs, **{k: acls.get(k) for k in ("cfgAcl", "localAcl")}}   # missing -> refused (unreadable)
""", "preflight-read")
rep(py, """    if [w for w in (i.get("netWriters")""", """    for k in ("cfgAcl", "localAcl"):     # an auto-inherited DACL (D:AI / D:PAI): the form the exact ACL round-trip is proven for
        mm = re.search(r"D:([A-Z]*)\\(", str(i.get(k) or ""))
        if not mm or "AI" not in mm.group(1): r.append(f"{k}: the DACL is not auto-inherited ({(mm.group(0)[:-1] if mm else 'unreadable')}); the exact ACL round-trip would refuse - root fixes that ACL first")
    if [w for w in (i.get("netWriters")""", "preflight-refusal")
new_pin = hashlib.sha256(ps1.read_bytes()).hexdigest()
rep(py, f'(HERE / "node-hold-cutover.ps1", "{old_pin}")', f'(HERE / "node-hold-cutover.ps1", "{new_pin}")', "re-pin the cutover script")
for p in (ps1, py): print(p.name, hashlib.sha256(p.read_bytes()).hexdigest())
