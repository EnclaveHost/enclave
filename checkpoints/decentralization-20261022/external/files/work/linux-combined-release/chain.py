# read-only: which supervisor-closure files import a mode-120000 (symlink) path, KEPT commit vs combined scratch commit
import importlib.util,subprocess,sys,posixpath,json
S=sys.argv[1]; R=sys.argv[2]
spec=importlib.util.spec_from_file_location('o',R+'/metal/overlay-control-image.py');o=importlib.util.module_from_spec(spec);spec.loader.exec_module(o)
def run(commit):
    lt=subprocess.check_output(['git','--git-dir',S,'ls-tree','-r',commit],text=True)
    links={l.split('\t')[1] for l in lt.splitlines() if l.startswith('120000')}
    parent={}
    def read(rel):
        r=subprocess.run(['git','--git-dir',S,'show',commit+':'+rel],capture_output=True)
        if r.returncode: return None
        t=r.stdout.decode()
        if rel.endswith(('.js','.mjs','.cjs')):
            for sp in o.specifiers_of(t, rel.endswith('.bundle.mjs')):
                if sp.startswith(('./','../')):
                    parent.setdefault(posixpath.normpath(posixpath.join(posixpath.dirname(rel),sp)),rel)
        return t
    files,pk=o.supervisor_closure(read,o.SUPERVISOR_ROOTS+o.APP_FILES)
    hit=[f for f in files if f in links]
    for h in hit:
        c=[h]
        while c[-1] in parent and len(c)<30: c.append(parent[c[-1]])
        print(commit[:9],'SYMLINK-IN-CLOSURE',' <- '.join(c))
    print(commit[:9],'closure',len(files),'symlinks-in-closure',len(hit))
    return links
for c in sys.argv[3:]: run(c)
