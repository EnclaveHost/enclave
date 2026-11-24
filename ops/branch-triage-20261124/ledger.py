import json,os,subprocess,collections,re,sys
S=os.path.dirname(os.path.abspath(__file__)); R=os.environ.get('REPO','.')
OUT=sys.argv[1]
def git(*a): return subprocess.run(['git','-C',R,*a],capture_output=True,text=True,errors='replace').stdout
d=json.load(open(S+'/triage2.json')); MAIN=d['main']
norm=lambda s: re.sub(r'(?i)tinfoil|cloud provider','X',s)
key2main={}
for l in git('log','--format=%H%x00%at%x00%s',MAIN).split('\n'):
    if l:
        h,a,s=l.split('\0'); key2main.setdefault((a,norm(s)[:25]),h)
inv={e['sha'] for e in json.load(open(R+'/ops/source-consolidation-20261030/branch-inventory.json'))}
tipkey={}
for r in d['tips']:
    a,s=git('log','-1','--format=%at%x00%s',r['tip']).strip().split('\0'); tipkey[r['tip']]=(a,norm(s)[:25])
newbykey={tipkey[r['tip']]:r for r in d['tips'] if r['line']=='new'}
NOTES={
 'isolation/front-console-guard':('landed','LANDED_MERGE','go test ./front -run TestTracedThread -count=200 -race: ok. Whole package: the same three TestRPCReady* failures with and without the merge (need an isolated root user namespace).'),
 'codex/native-session-upload-20261025':('not-landed-conflict','Three commits (CLI and site: catalog uploads and log reads under a session, no wallet fallback; a new `enclave upload`). Merge conflicts in cli/enclave.mjs in four places with independent mode and --chain-only; that file is in use by the cli/connect session. Needs its owner to port it; the relay must grant api.upload/api.logs to sessions for it to mean anything.','trial merge: conflict, not tested'),
 'codex/native-control-integration-20261025':('not-landed-owned-area','Two unmatched commits (per-image desktop SVN floor 702854589, measured control API qualification). Control image and relay admission: the RPC/metal0 control image sessions own that area. docs/operations/windows-release-2026.11.18.md already names 702854589 as not in the tree.','not tested'),
 'build/lease-reaper-artifact-20261028':('not-landed-unrelated-history','Root 9dd1e250b is a hash-verified snapshot of the production control source, not a descendant of main; it cannot be merged. Its qualification tooling (qualification/*, baseline-manifest.json) is not on main; ops/lease-reaper-reconcile-20261028 is. Control image area.','not tested'),
 'nucbox/domexec-app-port-floor':('not-landed-wip','Tip says "WIP (not for release)". 3898 of 4173 added lines are on main (the 2026-10-30 reconciliation); the remainder is in files main changed later.','not tested'),
 'nucbox/zimage-shield':('superseded','Tip reverts its own previous commit; the Z-Image and Shield public-web work was reconciled into main on 2026-10-30. Remainder is in files main changed later.','not tested'),
 'evidence/nan-n6-push-refused-20261030':('in-main','Main 232363e56 is the same commit as finally pushed (same author time and subject); this attempt carries a 3,760-line HANDOFF-at-terminal.md that the push check refused.','n/a'),
 'evidence/nan-n6-push-refused-r2-20261030':('in-main','As evidence/nan-n6-push-refused-20261030: main 232363e56.','n/a'),
 'evidence/nan-n6-push-refused-r3-20261030':('in-main','As evidence/nan-n6-push-refused-20261030: main 232363e56; PUSH-FAILURE.md differs by three lines.','n/a'),
 'codex/native-masked-desktop-20261024':('not-landed-active-stack','Source line of the KVM Box desktop image (see README). Two active kvm-box branches sit on it. By content main has it: see README.','not tested'),
 'decentralize/nan-retirement':('superseded','Lower part of the native-masked-desktop line; contained in it.','not tested'),
 'checkpoint/decentralization-20261022':('carries-records','Frozen exports (16,214 files, 3.2M lines). The 2026-10-30 record: "holds frozen exports, not the authority for current source". Not for main.','not tested'),
 'windows/custom-vbs-like-hyperv':('carries-records','Lab tooling kept off main on purpose (8e850d31e, per the 2026-10-30 record); its maintained launcher and fleet fixes were reconciled then.','not tested'),
 'connectivity/provider-mode':('candidate-preserved','The connectivity-v2 naming patch: changes contract selectors and needs a new contract (ops/source-consolidation-20261030/candidates/connectivity-v2-candidate.patch).','not tested'),
 'kvm-box/stream-flow-20261115':('owned-active','Source commit of the SVN22 desktop image (3b0679ad8): native-masked-desktop plus the front\'s three tunnel files as in main 3c4de3758. See README.','not tested'),
 'kvm-box/purchased-shares-20261120':('owned-active','Source commit of the SVN23 and SVN24 desktop candidates (3ee89bc16): the SVN22 source plus the purchased GPU share contract and worker lease as in main f56ff8912. See README.','not tested'),
 'cli/connect':('owned-active','The main checkout is on it.','not tested'),
 'mirror-images':('not-for-main','A one-off workflow that runs on its own branch push by design.','n/a'),
}
OWNED=[r'^kvm-box/purchased-shares-20261120$',r'^kvm-box/stream-flow-20261115$',r'^cli/connect$',r'^l2/',r'^gas-refill/',r'^design/vm-first-platform$',r'rpc']
rows=[]
for r in d['tips']:
    bare=[n.split(':',1)[1] for n in r['refs']]
    v=r['v']; note=''; test='not tested'; main_commit=None
    k=tipkey[r['tip']]
    if v=='in-main-by-commit':
        v='in-main'; main_commit=key2main.get(k); test='n/a'
        if not main_commit: note='every non-merge commit has an equivalent on main; the tip itself is a merge'
    twin=None
    if r['line']=='old' and k in newbykey:
        twin=sorted(newbykey[k]['refs'])[0].replace('origin:','origin/').replace('local:','')
    if v in('content-in-main',): test='n/a'
    if v=='superseded': note='remaining lines are in files main changed after the branch, or that main removed (heuristic, not reviewed by hand)'
    if v=='carries-code': v='carries-work'; note='has lines main lacks in files main never had or has not touched since; not landed: not reviewed or tested here'
    if v=='carries-records': note='what main lacks is evidence, records or documents only'
    owned=any(re.search(p,b) for p in OWNED for b in bare)
    for b in bare:
        if b in NOTES:
            v,note,test=NOTES[b]
    if owned and v not in('in-main',):
        note=('owned by an active session; read only here. '+note).strip(); v='owned-'+v if not v.startswith('owned') else v
    if bare and any(b=='isolation/front-console-guard' for b in bare) and r['line']=='old':
        v='in-main'; note='old-history copy of the landed branch'; test='n/a'
    res=r.get('residual',{})
    rows.append(dict(tip=r['tip'],refs=sorted(n.replace('origin:','origin/').replace('local:','') + ('' if n.startswith('origin:') else ' (local)') for n in r['refs']),history='shared' if r['line']=='new' else 'pre-rewrite',tip_date=r['date'],verdict=v,main_commit=main_commit,rewritten_twin=twin,ahead_of_main=r['ahead'],commits_without_equivalent_on_main=r['missing'],added_lines=r['lines'],added_lines_on_main=r['lines_in_main'],remaining={k_:res[k_] for k_ in sorted(res)},remaining_top_files=[f for k_ in ('never-in-main','differs-branch-newer') for f,_ in r.get('resfiles',{}).get(k_,[])[:4]],stack_tip=r['is_stack_tip'],in_20261030_inventory=r['tip'] in inv,has_worktree=bool(r['worktree']),note=note,test=test))
rows=[x for x in rows if x['refs']!=['consolidation/20261124 (local)']]
rows.sort(key=lambda x:(x['history'],x['verdict'],x['tip_date'],x['refs'][0]))
json.dump(dict(schema='enclave-branch-triage/1',main=MAIN,tips=len(rows),rows=rows),open(OUT,'w'),indent=1)
c=collections.Counter((x['history'],x['verdict']) for x in rows)
for k_,n in sorted(c.items()): print(k_,n)
print('distinct names', len({re.sub(r' \(local\)$','',n).replace('origin/','') for x in rows for n in x['refs']}))
c2=collections.Counter(x['verdict'] for x in rows); print(dict(c2))
print('stack tips carrying work, shared:',[x['refs'][0] for x in rows if x['history']=='shared' and x['verdict']=='carries-work' and x['stack_tip']])
print('pre-rewrite carrying work without twin:',[ (x['refs'][0],x['commits_without_equivalent_on_main'],x['remaining']) for x in rows if x['history']!='shared' and x['verdict'] in('carries-work','carries-records') and not x['rewritten_twin']])
