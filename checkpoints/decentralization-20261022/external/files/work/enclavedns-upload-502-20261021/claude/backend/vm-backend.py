import subprocess,hashlib,json,os,re,glob,collections,datetime
def sh(a): p=subprocess.run(a,text=True,capture_output=True); return (p.stdout or '')+(p.stderr or '')[:200]
r={}
b='/opt/enclave-indexd/indexd'
try:
    st=os.stat(b); r['binary']={'path':b,'sha256':hashlib.sha256(open(b,'rb').read()).hexdigest(),'bytes':st.st_size,'mtime':datetime.datetime.fromtimestamp(st.st_mtime,datetime.timezone.utc).isoformat(),'realpath':os.path.realpath(b)}
except Exception as e: r['binary']={'error':str(e)[:120]}
r['optListing']=sh(['ls','-la','/opt/enclave-indexd']).splitlines()[:12]
# config: ONLY the log subtree, values limited to booleans/levels/paths (no secrets live there; anything else masked)
try:
    import yaml
    cfg=yaml.safe_load(open('/etc/enclave-indexd/indexd.yml'))
    def safe(v):
        if isinstance(v,dict): return {k:safe(x) for k,x in v.items()}
        if isinstance(v,(bool,int)) or v is None: return v
        s=str(v); return s if re.fullmatch(r'(debug|info|warn|error|stdout|stderr|json|human|true|false|/[\w./-]+)',s,re.I) else '<masked>'
    r['configLogSubtree']=safe(cfg.get('log',{})); r['configTopKeys']=sorted(cfg.keys())
except Exception as e: r['configLogSubtree']={'error':str(e)[:120]}
files=[]
for pat in ['/var/lib/enclave-indexd/state/logs/*','/var/lib/enclave-indexd/state/**/*.log','/var/lib/enclave-indexd/state/*log*','/var/log/*indexd*','/var/log/caddy/*','/var/lib/caddy/**/*.log']:
    for f in glob.glob(pat,recursive=True):
        if not os.path.isfile(f): continue
        try: st=os.stat(f); files.append((f,st.st_size,datetime.datetime.fromtimestamp(st.st_mtime,datetime.timezone.utc).isoformat()))
        except: pass
r['logFiles']=sorted(set(files))[:30]
def norm(l):
    l=re.sub(r'[0-9a-fA-F]{16,}','<hex>',l); l=re.sub(r'\b(ed25519|h|sia):[A-Za-z0-9]+','<id>',l); l=re.sub(r'\d+(\.\d+)?','N',l)
    return l[:170]
agg={}
for src,lines in [('journal:enclave-indexd',sh(['journalctl','-u','enclave-indexd','--since','2026-10-21 18:00:00','-o','cat','--no-pager']).splitlines()),
                  ('journal:caddy',sh(['journalctl','-u','caddy','--since','2026-10-21 18:00:00','-o','cat','--no-pager']).splitlines())]+\
                 [('file:'+f,[x for x in open(f,errors='replace').read().splitlines() if re.search(r'2026-10-21T(18|19)',x)]) for f,_,_ in files if os.path.getsize(f)<512*1024*1024]:
    c=collections.Counter(); lv=collections.Counter()
    for l in lines:
        m=re.search(r'"?(level|lvl)"?\s*[:=]\s*"?(\w+)',l,re.I) or re.search(r'\b(DEBUG|INFO|WARN|ERROR|FATAL)\b',l)
        lv[(m.group(2) if m and m.lastindex==2 else (m.group(1) if m else '?')).lower()]+=1
        if re.search(r'(?i)error|fail|timeout|refus|eof|denied|insufficient|panic|reset',l): c[norm(l)]+=1
    agg[src]={'lines':len(lines),'levels':dict(lv),'topErrors':c.most_common(15)}
r['aggregates']=agg
print(json.dumps(r,indent=1))
