import json,sys,os,collections,re
S=os.path.dirname(os.path.abspath(__file__))
d=json.load(open(S+'/triage.json'))
REC=re.compile(r'^(ops/|docs/|evidence/|.*\.(log|md|txt)$|.*/evidence/|.*/qualification/|.*/snapshots?/)')
def verdict(r):
    if r['missing']==0 or r['missing_nonmerge']==0: return 'in-main-by-commit'
    if r['lines']==0: return 'content-in-main'
    res=r['residual']; tot=sum(res.values())
    r['resid']=tot
    if tot<=max(3,0.03*r['lines']): return 'content-in-main'
    live=res.get('never-in-main',0)+res.get('differs-branch-newer',0)
    if live<=max(3,0.1*tot): return 'superseded'
    # records only?
    files=[f for k in('never-in-main','differs-branch-newer') for f,_ in r['resfiles'].get(k,[])]
    if files and all(REC.match(f) for f in files): return 'carries-records'
    return 'carries-code'
c=collections.Counter()
for r in d['tips']:
    r['v']=verdict(r); c[(r['line'],r['v'])]+=1
for k,v in sorted(c.items()): print(k,v)
json.dump(d,open(S+'/triage2.json','w'),indent=1)
sel=sys.argv[1:] 
for r in sorted(d['tips'],key=lambda r:(r['v'],r['date'])):
    if r['line'] not in sel and r['v'] not in sel: continue
    if r['v'] in('in-main-by-commit',): continue
    res=r.get('residual',{})
    print(f"{r['tip'][:9]} {r['date']} {r['line']} {r['v'][:14]:14} miss={r['missing']} ln={r['lines_in_main']}/{r['lines']} nev={res.get('never-in-main',0)} brnew={res.get('differs-branch-newer',0)} mainnew={res.get('differs-main-newer',0)} rm={res.get('removed-on-main',0)} {'OWN ' if r['owned'] else ''}{'WT ' if r['worktree'] else ''}{'' if r['is_stack_tip'] else 'sub '}{','.join(r['refs'])[:100]}")
