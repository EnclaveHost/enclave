#!/usr/bin/env python3
"""rpc-integrated: derive helper/root-node-hold.py from root's frozen control-package driver 613b6f38 (exact bytes asserted).
Only the coordinator/config repair changes; the 19 payload files, manifest.json 5094dca0 and every other remote text stay verbatim.
Usage: python3 compose-driver.py   (needs helper/node-hold-cutover.ps1 and coordinator.json to exist; pins them)"""
import hashlib, pathlib
R = pathlib.Path(__file__).resolve().parent
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
s = (R / 'base/root-node-hold.py').read_text()
assert hashlib.sha256(s.encode()).hexdigest() == '613b6f3836345000b9915db7d320e8b4764efb20b9a79bcc13f28bef3892d965', 'base is not the frozen root driver'
CUT, COORD = sha(R / 'helper/node-hold-cutover.ps1'), sha(R / 'coordinator.json')
# root's existing restart receipt: hashed from the file itself, and its content asserted (never typed in by hand)
import json
RRP = R.parents[2] / 'root-control-final-20261022/control-package/helper/runs/restart-agent-result-20261022T022206Z.json'
rr = json.loads(RRP.read_text())['result']
assert (rr['agentScript'], rr['newPid'], rr['newStart'], rr['decision']) == ('cfb69370a00dea147340c64bbd712f118eb8cb825237ac79b3b053b586350801', 30716, '2026-10-22T02:22:18.2296250Z', 'restarted')
RR = sha(RRP)
def rep(a, b):
    global s
    assert s.count(a) == 1, ('anchor not unique/present', a[:90]); s = s.replace(a, b, 1)
rep('''  root-node-hold.py                                          read-only preflight -> runs/preflight-*.json''',
'''  RPC-INTEGRATED (work/claude-resumed-20261022/cutover-review/rpc-integrated; root-only, never run by its author): the SAME package
  plus ONE coordinator/config repair inside the cutover: run-node.cmd's hand-added 3-host BASE_RPCS override (line 12, 96 bytes,
  3366a005 -> 0fdc3699) is removed while the node is proven stopped, and privacy-config.json chain.rpc gets the same 5 URLs before the
  explicit privacy restart (no second restart by network-enroll). Changed here: the cutover pin, the lease budget (revert 555 ->
  915 s needed), the run-node.cmd ACL read/gate, runNodeNewSha / rollback runNode params, a stage receipt must hold THIS cutover,
  the privacy-agent proof may come from root's pinned existing restart receipt, and network-side actions are REFUSED (privacy-agent
  cfb69370 is already active: never re-applied or restarted for this package; its rollback stays with the frozen root package).

  root-node-hold.py                                          read-only preflight -> runs/preflight-*.json''')
rep('''HERE = pathlib.Path(__file__).resolve().parent; PKG = HERE.parent; W = PKG.parents[1]; OUT = HERE / "runs"''',
    '''HERE = pathlib.Path(__file__).resolve().parent; PKG = HERE.parent; OUT = HERE / "runs"
W = next(p for p in PKG.parents if (p / "nucbox-tls-20261021").is_dir())     # the work tree (this package may sit at any depth)''')
rep('''           "node-hold-cutover.ps1": (HERE / "node-hold-cutover.ps1", "943a5f0173a291c8ed2a3d160552dd5ab8633069cc331ba9c39b6806460e2093")}''',
    f'''           "node-hold-cutover.ps1": (HERE / "node-hold-cutover.ps1", "{CUT}")}}
COORD = (PKG / "coordinator.json", "{COORD}")         # the new cutover + budget (the manifest's composedFrom still names 943a/550)
RUN_NODE_NEW = "0fdc3699228c9d7a4c2e971d05804b49f978a56a4c1d9f7a06f3546f3ced09fd"   # run-node.cmd minus its line-12 override
# root's EXISTING proof that the running privacy agent was restarted onto cfb69370 (02:22:18Z, pid 30716): pinned, never re-created
ROOT_RESTART = [(None, "restart-agent-result-20261022T022206Z.json", "{RR}")]''')
rep('''LEASE = {"revertSec": 550, "marginSec": 180, "forwardMinSec": 180, "startNodeSec": 150}; LEASE_NEED = 910''',
    '''LEASE = {"revertSec": 555, "marginSec": 180, "forwardMinSec": 180, "startNodeSec": 150}; LEASE_NEED = 915   # rpc-integrated budget.json''')
rep('''ACLS = U + r"$pd='C:\\ProgramData\\Enclave';[ordered]@{cfgAcl=(Get-Acl -LiteralPath ($pd+'\\network\\privacy-config.json')).Sddl;localAcl=(Get-Acl -LiteralPath ($pd+'\\node-config.local.cmd')).Sddl}|ConvertTo-Json -Compress"''',
    '''ACLS = U + r"$pd='C:\\ProgramData\\Enclave';[ordered]@{cfgAcl=(Get-Acl -LiteralPath ($pd+'\\network\\privacy-config.json')).Sddl;localAcl=(Get-Acl -LiteralPath ($pd+'\\node-config.local.cmd')).Sddl;runNodeAcl=(Get-Acl -LiteralPath ($pd+'\\run-node.cmd')).Sddl}|ConvertTo-Json -Compress"''')
rep('''    bad = [str(p) for p, h in [T, MANIFEST] + list(SCRIPTS.values()) if sha(p) != h]''',
    '''    bad = [str(p) for p, h in [T, MANIFEST, COORD] + list(SCRIPTS.values()) if sha(p) != h]''')
rep('''    acls = m.ps(ACLS, 60); cfgs = {**cfgs, **{k: acls.get(k) for k in ("cfgAcl", "localAcl")}}''',
    '''    acls = m.ps(ACLS, 60); cfgs = {**cfgs, **{k: acls.get(k) for k in ("cfgAcl", "localAcl", "runNodeAcl")}}''')
rep('''    for k in ("cfgAcl", "localAcl"):     # an auto-inherited DACL''', '''    for k in ("cfgAcl", "localAcl", "runNodeAcl"):     # an auto-inherited DACL''')
rep('''    o = a.parse_args(argv); verify_local(); ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())''',
    '''    o = a.parse_args(argv); verify_local(); ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    if o.restart_agent or o.apply == "network" or o.rollback == "network":
        raise SystemExit("rpc-integrated: network-side actions are not part of this package (privacy-agent cfb69370 is already active and must not be "
                         "re-applied or restarted for it); a network rollback uses the frozen root package and the stage that applied it")''')
rep('''    if st and st.get("manifestSha") != MANIFEST_SHA: raise SystemExit("--stage-receipt: staged with another manifest")''',
    '''    if st and st.get("manifestSha") != MANIFEST_SHA: raise SystemExit("--stage-receipt: staged with another manifest")
    # the cutover runs ONLY from a stage that holds THIS package's cutover bytes (an older stage holds 943a5f01); a control rollback
    # must use the stage that applied the group (its swap backups live there), so it is not restricted
    if st and (o.apply or o.cutover or o.rollback_cutover) and (st.get("verify") or {}).get(st["stage"] + "\\\\node-hold-cutover.ps1") != SCRIPTS["node-hold-cutover.ps1"][1]:
        raise SystemExit("--stage-receipt: that stage does not hold this package's cutover " + SCRIPTS["node-hold-cutover.ps1"][1][:8] + ": stage anew with --stage")''')
rep('''        ra = [json.loads(p.read_text()).get("result", {}) for p in sorted(OUT.glob("restart-agent-result-*.json"))]''',
    '''        ra = [json.loads(p.read_text()).get("result", {}) for p in sorted(OUT.glob("restart-agent-result-*.json"))]
        for _, name, h in ROOT_RESTART:          # root's existing receipt: used only if it is exactly the pinned bytes
            p = W / "root-control-final-20261022/control-package/helper/runs" / name
            if p.exists() and sha(p) != h: refuse.append(f"the pinned root restart receipt {name} changed")
            elif p.exists(): ra.append(json.loads(p.read_text()).get("result", {}))''')
rep('''              "localSha": i.get("local"), "cfgSha": i.get("cfg"), "lease": dict(LEASE),''',
    '''              "localSha": i.get("local"), "cfgSha": i.get("cfg"), "lease": dict(LEASE), "runNodeNewSha": RUN_NODE_NEW,''')
rep('''        if not bk: raise SystemExit("the cutover journal has no backups step: nothing to restore")''',
    '''        if not bk: raise SystemExit("the cutover journal has no backups step: nothing to restore")
        if not bk.get("runNodeBackup"): raise SystemExit("the cutover journal has no run-node.cmd backup: it was not run by this package")
        rn = next((l for l in lines if l.get("step") == "run-node"), {})''')
rep('''                            "cfg": {"before": r0["params"]["cfgSha"], "after": cf.get("after", ""), "backup": bk["cfgBackup"]}}''',
    '''                            "cfg": {"before": r0["params"]["cfgSha"], "after": cf.get("after", ""), "backup": bk["cfgBackup"]},
                            "runNode": {"before": r0["params"]["runNodeSha"], "after": rn.get("after", ""), "backup": bk["runNodeBackup"]}}''')
(R / 'helper/root-node-hold.py').write_text(s)
print('rpc-integrated driver', hashlib.sha256(s.encode()).hexdigest(), 'pins cutover', CUT[:8], 'coordinator', COORD[:8])
