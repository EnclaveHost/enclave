import subprocess, sys, json, collections, re, os
R=os.environ.get('REPO','.')
S=os.path.dirname(os.path.abspath(__file__))
def git(*a, inp=None):
    return subprocess.run(['git','-C',R,*a],input=inp,capture_output=True,text=True,errors='replace').stdout
MAIN=git('rev-parse','origin/main').strip()
refs=[l.split(' ',1) for l in git('for-each-ref','--format=%(objectname) %(refname)','refs/heads','refs/remotes').split('\n') if l and 'origin/HEAD' not in l]
tips=collections.defaultdict(list)
for h,r in refs: tips[h].append(r.replace('refs/heads/','local:').replace('refs/remotes/origin/','origin:'))
norm=lambda s: re.sub(r'(?i)tinfoil|cloud provider','X',s)
def commits(revs, extra=()):
    out=git('log','--format=%H%x00%at%x00%P%x00%s',*extra,'--stdin',inp='\n'.join(revs))
    return [l.split('\0') for l in out.split('\n') if l]
mainc=commits([MAIN]); mainset={c[0] for c in mainc}
mainkey=collections.defaultdict(set)
for h,a,p,s in mainc: mainkey[a].add(norm(s)[:25])
maintree=set(git('ls-tree','-r','--name-only',MAIN).split('\n'))
# worktrees
wt={}
cur=None
for l in git('worktree','list','--porcelain').split('\n'):
    if l.startswith('worktree '): cur=l[9:]
    elif l.startswith('branch '): wt[l[7:].replace('refs/heads/','')]=cur
last={}
_t=None
for l in git('log','--format=@%ct','--name-only','--no-renames',MAIN).split('\n'):
    if l.startswith('@'): _t=int(l[1:])
    elif l:
        p=norm(l)
        if p not in last: last[p]=_t
_mainlines={}
def mainlines(path):
    if path not in _mainlines:
        if path in maintree:
            _mainlines[path]={norm(x.strip()) for x in git('show',f'{MAIN}:{path}').split('\n')}
        else: _mainlines[path]=None
    return _mainlines[path]
_cc={}
def commit_info(c):
    if c in _cc: return _cc[c]
    out=git('show','--format=','-U0','--no-renames','--no-color',c)
    files={}; cur=None
    for l in out.split('\n'):
        if l.startswith('+++ '):
            cur=l[6:] if l.startswith('+++ b/') else None
            if cur: files.setdefault(cur,[0,0])
        elif l.startswith('--- '):
            pass
        elif l.startswith('+') and cur:
            t=norm(l[1:].strip())
            if len(t)>=16:
                ml=mainlines(cur)
                files[cur][0]+=1
                if ml is not None and t in ml: files[cur][1]+=1
    _cc[c]=files
    return files
OWNED=[r'^kvm-box/purchased-shares-20261120$',r'^kvm-box/stream-flow-20261115$',r'^cli/connect$',r'^l2/',r'^gas-refill/',r'^design/vm-first-platform$',r'rpc',r'metal0']
res=[]
alltips=[h for h in tips if h not in mainset]
for t in alltips:
    names=tips[t]
    mb=git('merge-base',t,MAIN).strip()
    line='new' if mb else 'old'
    cs=commits([t,'^'+MAIN]) if mb else commits([t])
    miss=[c for c in cs if not (c[1] in mainkey and norm(c[3])[:25] in mainkey[c[1]])]
    nonmerge=[c for c in miss if len(c[2].split())<2]
    tot=pres=0; fstat=collections.defaultdict(lambda:[0,0,0])
    for c in nonmerge:
        for f,(a,p) in commit_info(c[0]).items():
            fstat[f][0]+=a; fstat[f][1]+=p; tot+=a; pres+=p; fstat[f][2]=max(fstat[f][2],int(c[1]))
    cat=collections.Counter(); catf=collections.defaultdict(list)
    for f,(a,p,tm) in fstat.items():
        r_=a-p
        if r_<=0: continue
        nf=norm(f)
        if f in maintree or nf in maintree: k='differs-main-newer' if last.get(nf,0)>tm else 'differs-branch-newer'
        elif nf in last: k='removed-on-main'
        else: k='never-in-main'
        cat[k]+=r_; catf[k].append((f,r_))
    absent=[f for f in fstat if f not in maintree]
    info=git('log','-1','--format=%ad%x00%an%x00%s','--date=short',t).strip().split('\0')
    bare=[n.split(':',1)[1] for n in names]
    owned=any(re.search(p,b) for p in OWNED for b in bare)
    res.append(dict(tip=t,refs=names,line=line,date=info[0],author=info[1],subject=info[2][:100],ahead=len(cs) if mb else None,total=len(cs),missing=len(miss),missing_nonmerge=len(nonmerge),lines=tot,lines_in_main=pres,files=len(fstat),files_absent_in_main=len(absent),owned=owned,worktree=[wt[b] for b in bare if b in wt],
      residual=dict(cat),resfiles={k:sorted(v,key=lambda x:-x[1])[:15] for k,v in catf.items()},resdirs={k:collections.Counter('/'.join(f.split('/')[:2]) for f,_ in v).most_common(6) for k,v in catf.items()},
      miss_subjects=[(c[0][:10],c[3][:90]) for c in miss[:25]]))
# stacks: tip contained in another unmerged tip
anc=git('for-each-ref','--format=%(objectname)','refs/heads','refs/remotes')
for r in res:
    out=git('for-each-ref','--contains',r['tip'],'--format=%(objectname) %(refname:short)','refs/heads','refs/remotes').split('\n')
    r['contained_in']=sorted({l.split(' ',1)[1] for l in out if l and l.split(' ')[0]!=r['tip'] and 'origin/HEAD' not in l})[:6]
    r['is_stack_tip']=not r['contained_in']
json.dump(dict(main=MAIN,tips=res),open(S+'/triage.json','w'),indent=1)
print(len(res))
