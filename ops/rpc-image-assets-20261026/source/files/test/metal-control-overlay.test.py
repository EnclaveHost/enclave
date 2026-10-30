import gzip, hashlib, importlib.util, io, json, re, stat, subprocess, tempfile, unittest
from pathlib import Path
REPO=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('overlay_control_image', REPO/'metal/overlay-control-image.py')
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
COMMIT=subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip()

class ControlOverlay(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.base=self.root/'base';self.base.mkdir()
    def tearDown(self):self.tmp.cleanup()
    def base_image(self,extra=(),prefix='./',drop=()):
        entries=[('app',0o40755,b'',2),('opt',0o40755,b'',2),('opt/metal',0o40755,b'',2),
          ('app/supervisor.js',0o100640,b'old supervisor',1),('opt/metal/gsup.mjs',0o100644,b'old gsup',1),
          ('opt/metal/agent.mjs',0o100644,b'old agent',1),('opt/metal/manifest.json',0o100644,b'{}',1),
          ('unchanged-link',0o120777,b'/absolute/target',1),('unchanged-file',0o100600,b'keep these exact bytes',1),
          *self.packages(drop),*extra]
        raw=b''
        for i,(name,mode,data,nlink) in enumerate(entries,1):
            raw+=mod.encode(prefix+name,[i,mode,123,456,nlink,1000,0,0,0,0,0,0,0],data)
        raw+=mod.encode('TRAILER!!!',[len(entries)+1,0,0,0,1,0,0,0,0,0,0,0,0])
        archive=gzip.compress(raw,mtime=0);(self.base/'initramfs.cpio.gz').write_bytes(archive)
        (self.base/'vmlinuz').write_bytes(b'test kernel');(self.base/'cmdline').write_text('test cmdline')
        (self.base/'manifest.json').write_text(json.dumps({'kernel':{'sha256':mod.sha(b'test kernel')},'initramfs':{'sha256':mod.sha(archive)},'expectedMeasurement':{'old':'invalidated'}}))
        return self.read(self.base) if not extra else None
    # the npm packages of the base image's supervisor (the closure at COMMIT names them; check_packages reads these)
    PACKAGES={'cors':{'version':'2.8.5'},'express':{'version':'4.21.2'},'jose':{'version':'5.9.6'},'ws':{'version':'8.18.0'},
              'viem':{'version':'2.21.0','exports':{'.':'./_esm/index.js','./accounts':'./_esm/accounts/index.js','./chains':'./_esm/chains/index.js','./utils':'./_esm/utils/index.js'}}}
    def packages(self,drop=()):
        out=[('app/node_modules',0o40755,b'',2)]
        for n,pj in self.PACKAGES.items():
            if n in drop:continue
            out+=[('app/node_modules/'+n,0o40755,b'',2),('app/node_modules/'+n+'/package.json',0o100644,json.dumps({'name':n,**pj}).encode(),1)]
        return out
    def read(self,folder):
        result={}
        with gzip.open(folder/'initramfs.cpio.gz','rb') as f:
            for key,name,fields,header in mod.entries(f):
                data=mod.exact(f,fields[6]);pad=mod.exact(f,-fields[6]%4)
                self.assertNotIn(key,result)
                result[key]=(fields,data,header+data+pad)
        return result
    def test_committed_closure_preserved_entries_and_repeatable_overlay(self):
        before=self.base_image()
        out=self.root/'out';m=mod.overlay(self.base,out,COMMIT,REPO);after=self.read(out)
        for key in ['unchanged-link','unchanged-file','app','opt','opt/metal']:
            self.assertEqual(before[key],after[key])
        self.assertEqual(after['app/supervisor.js'][0][1],0o100640)
        installed,packages=mod.app_files(COMMIT,REPO)
        self.assertTrue(set(mod.APP_FILES)<=set(installed))
        for src in installed:
            self.assertEqual(after['app/'+src][1],mod.committed(COMMIT,REPO,src))   # a git symlink: its target's bytes
        self.assertEqual([p['name'] for p in m['controlOverlay']['supervisorClosure']['packages']],sorted(packages))
        for src in mod.GUEST_FILES:
            self.assertEqual(after['opt/metal/'+src][1],mod.committed(COMMIT,REPO,'metal/guest/'+src))
        self.assertTrue(stat.S_ISDIR(after['app/windows/node'][0][1]))
        self.assertNotIn('expectedMeasurement',m)
        self.assertEqual(m['initramfs']['sha256'],mod.file_sha(out/'initramfs.cpio.gz'))
        self.assertEqual(m['controlOverlay']['commit'],COMMIT)
        second=self.root/'second';mod.overlay(self.base,second,COMMIT,REPO)
        self.assertEqual((out/'initramfs.cpio.gz').read_bytes(),(second/'initramfs.cpio.gz').read_bytes())
        upgraded=self.root/'upgraded';mod.overlay(out,upgraded,COMMIT,REPO)
        again=self.read(upgraded)
        self.assertEqual(after['app/windows/node/session-api-auth.mjs'][1],again['app/windows/node/session-api-auth.mjs'][1])
    def test_only_identical_unmodified_regular_duplicates_are_collapsed(self):
        self.base_image([('unchanged-file',0o100600,b'keep these exact bytes',1)])
        out=self.root/'out';m=mod.overlay(self.base,out,COMMIT,REPO);self.read(out)
        self.assertEqual(m['controlOverlay']['collapsedIdenticalDuplicates'],{'unchanged-file':1})
        self.base_image([('unchanged-file',0o100600,b'different bytes',1)])
        with self.assertRaisesRegex(ValueError,'duplicate cpio entry'):mod.overlay(self.base,self.root/'bad',COMMIT,REPO)
    def test_plain_names_also_support_repeated_overlay(self):
        self.base_image(prefix='');out=self.root/'out';mod.overlay(self.base,out,COMMIT,REPO);self.read(out)
        mod.overlay(out,self.root/'twice',COMMIT,REPO);self.read(self.root/'twice')
    def test_digest_mismatch_does_not_create_output(self):
        self.base_image();(self.base/'vmlinuz').write_bytes(b'wrong')
        with self.assertRaisesRegex(ValueError,'kernel hash mismatch'):mod.overlay(self.base,self.root/'out',COMMIT,REPO)
        self.assertFalse((self.root/'out').exists())
    def test_symlink_parent_and_duplicate_paths_rejected(self):
        for extra in [[('app/windows',0o120777,b'/tmp/elsewhere',1)],[('app/supervisor.js',0o100644,b'duplicate',1)]]:
            self.base_image(extra)
            with self.assertRaises(ValueError):mod.overlay(self.base,self.root/'out',COMMIT,REPO)
            self.assertFalse((self.root/'out').exists())
    def test_hardlinked_target_refused(self):
        self.base_image([('app/addressbook.js',0o100644,b'aliased',2)])
        with self.assertRaisesRegex(ValueError,'hardlinked replacement'):mod.overlay(self.base,self.root/'out',COMMIT,REPO)

    def test_a_package_the_closure_needs_must_be_in_the_base(self):
        _,packages=mod.app_files(COMMIT,REPO)
        self.assertTrue(packages)
        for name in packages:
            self.base_image([('marker',0o100644,b'x',1)],drop=(name,))
            with self.assertRaisesRegex(ValueError,'no '+name+' package'):mod.overlay(self.base,self.root/('out-'+name),COMMIT,REPO)
            self.assertFalse((self.root/('out-'+name)).exists())
    def test_closure_rules(self):
        files={'supervisor.js':"import a from './lib/a.mjs';\n// import x from './not-a-dependency.mjs'\n * from \"./neither\"\nimport {\n  b,\n} from \"./lib/b.mjs\";\nconst j=await import(new URL('./lib/c.mjs', import.meta.url));\nimport fs from 'node:fs';\nimport p from 'path';\nimport { privateKeyToAccount } from 'viem/accounts';",
               'addressbook.js':"export { x } from './lib/a.mjs';",
               'lib/a.mjs':"import y from '../lib/d.bundle.mjs';",'lib/b.mjs':"const data=new URL('./table.json', import.meta.url);",
               'lib/c.mjs':"import 'ws';",'lib/d.bundle.mjs':"var a=1;import(\"./never\");\nimport{z}from\"@scope/pkg/sub\";",'lib/table.json':'{}'}
        got,packages=mod.supervisor_closure(lambda r:files.get(r),mod.SUPERVISOR_ROOTS)
        self.assertEqual(got,sorted(files))
        self.assertEqual(packages,{'@scope/pkg':['./sub'],'viem':['./accounts'],'ws':['.']})
        with self.assertRaisesRegex(ValueError,'names lib/gone.mjs'):
            mod.supervisor_closure(lambda r:{**files,'lib/c.mjs':"import g from './gone.mjs';"}.get(r),mod.SUPERVISOR_ROOTS)
    def test_packages_and_subpath_exports_are_checked(self):
        pj=lambda d:(lambda n:json.dumps(d[n]).encode() if n in d else None)
        ok={'viem':{'version':'2','exports':{'.':'x','./accounts':'y','./utils':'z'}},'ws':{'version':'8'}}
        self.assertEqual(mod.check_packages({'viem':['.','./accounts','./utils'],'ws':['.']},pj(ok)),[{'name':'viem','version':'2'},{'name':'ws','version':'8'}])
        with self.assertRaisesRegex(ValueError,'exports no ./chains'):mod.check_packages({'viem':['./chains']},pj(ok))
        with self.assertRaisesRegex(ValueError,'no jose package'):mod.check_packages({'jose':['.']},pj(ok))
        self.assertTrue(mod.check_packages({'p':['./deep/x']},pj({'p':{'version':'1','exports':{'./*':'./*'}}})))
    def test_git_symlinks_install_their_target_bytes_like_build_image(self):
        # relay/net-guard.mjs -> ../net-guard.mjs entered the supervisor closure; the link text is not a module
        repo=self.root/'repo';repo.mkdir();git=lambda *a:subprocess.check_output(['git','-c','user.name=t','-c','user.email=t@t',*a],cwd=repo)
        git('init','-q');(repo/'relay').mkdir();(repo/'guard.mjs').write_text('export const ok = 1;\n')
        (repo/'relay/guard.mjs').symlink_to('../guard.mjs');(repo/'relay/chain.mjs').symlink_to('guard.mjs')
        (repo/'relay/out.mjs').symlink_to('../../outside.mjs');(repo/'relay/abs.mjs').symlink_to('/etc/hostname')
        (repo/'relay/loop.mjs').symlink_to('loop.mjs')
        (repo/'supervisor.js').write_text("import { ok } from './relay/chain.mjs';\n");(repo/'addressbook.js').write_text('')
        git('add','-A');git('commit','-qm','t');c=git('rev-parse','HEAD').decode().strip()
        self.assertEqual(git('show',c+':relay/guard.mjs'),b'../guard.mjs')
        for rel in ['relay/guard.mjs','relay/chain.mjs','guard.mjs']:
            self.assertEqual(mod.committed(c,repo,rel),b'export const ok = 1;\n')
        self.assertIsNone(mod.committed(c,repo,'relay/absent.mjs'))
        for rel,msg in [('relay/out.mjs','leaves the repository'),('relay/abs.mjs','leaves the repository'),('relay/loop.mjs','does not end')]:
            with self.assertRaisesRegex(ValueError,msg):mod.committed(c,repo,rel)
        files,_=mod.supervisor_closure(lambda r:(lambda d:d.decode() if d is not None else None)(mod.committed(c,repo,r)),mod.SUPERVISOR_ROOTS)
        self.assertEqual(files,['addressbook.js','relay/chain.mjs','supervisor.js'])
    # --control direct: the measured control image over a verified per-app base, keeping its kernel
    TEMPLATE='console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=${MODE} metal.isolation=snp-guest-per-app'
    def direct_base(self,cmdline=None,**manifest):
        self.base_image()
        line=self.TEMPLATE if cmdline is None else cmdline
        (self.base/'cmdline').write_text(line+'\n')
        m=json.loads((self.base/'manifest.json').read_text());m.update({'isolation':'snp-guest-per-app','cmdlineTemplate':line,**manifest})
        (self.base/'manifest.json').write_text(json.dumps(m))
        return self.read(self.base)
    def test_control_direct_installs_the_platform_api_trio_over_the_base_kernel(self):
        before=self.direct_base();base_m=json.loads((self.base/'manifest.json').read_text())
        out=self.root/'out';m=mod.overlay(self.base,out,COMMIT,REPO,'direct');after=self.read(out)
        pm=json.loads(mod.committed(COMMIT,REPO,mod.PLATFORM_API_BUNDLE+'.manifest.json'))
        bundle=mod.committed(COMMIT,REPO,mod.PLATFORM_API_BUNDLE)
        self.assertEqual(after['opt/metal/platform-api.bundle.mjs'][1],bundle);self.assertEqual(mod.sha(bundle),pm['sha256'])
        self.assertTrue(pm['sidecars'])
        for beside,s in pm['sidecars'].items():
            self.assertEqual(after['opt/metal/'+beside][1],mod.committed(COMMIT,REPO,s['source']))
            self.assertEqual(mod.sha(after['opt/metal/'+beside][1]),s['sha256'])
        self.assertNotIn('opt/metal/platform-api.bundle.mjs.manifest.json',after)     # read, recorded, not installed
        self.assertEqual(after['opt/metal/measured-control.mjs'][1],mod.committed(COMMIT,REPO,'metal/guest/measured-control.mjs'))
        self.assertEqual((out/'cmdline').read_text(),self.TEMPLATE+' metal.control=direct\n')
        self.assertEqual((m['control'],m['cmdlineTemplate']),('direct',self.TEMPLATE+' metal.control=direct'))
        self.assertEqual(m['platformApiBundle'],{'path':'/opt/metal/platform-api.bundle.mjs','sha256':pm['sha256'],'bytes':len(bundle),
            'inputs':len(pm['inputs']),'sidecars':{'/opt/metal/'+k:v['sha256'] for k,v in pm['sidecars'].items()}})
        self.assertEqual((out/'vmlinuz').read_bytes(),(self.base/'vmlinuz').read_bytes());self.assertEqual(m['kernel'],base_m['kernel'])
        # the hosted MCP adapter, as build-image.mjs installs it and measured-control.mjs launches it (MCP_BUNDLE), with its runtime files
        mm=json.loads(mod.committed(COMMIT,REPO,mod.MCP_BUNDLE+'.manifest.json'));mcp=mod.committed(COMMIT,REPO,mod.MCP_BUNDLE)
        self.assertEqual(after['opt/metal/mcp-server.bundle.mjs'][1],mcp);self.assertEqual(mod.sha(mcp),mm['sha256'])
        self.assertTrue(mm['runtimeFiles']);self.assertNotIn('opt/metal/mcp-server.bundle.mjs.manifest.json',after)
        for at,s in mm['runtimeFiles'].items():
            self.assertEqual(after[at][1],mod.committed(COMMIT,REPO,s['source']));self.assertEqual(mod.sha(after[at][1]),s['sha256'])
        self.assertEqual(m['mcpBundle'],{'path':'/opt/metal/mcp-server.bundle.mjs','sha256':mm['sha256'],'bytes':len(mcp),'inputs':len(mm['inputs']),
            'manifestSha256':mm['sha256'],'runtimeFiles':{'/'+k:v['sha256'] for k,v in mm['runtimeFiles'].items()}})
        launch=mod.committed(COMMIT,REPO,'metal/guest/measured-control.mjs').decode()
        self.assertIn("export const MCP_BUNDLE = '/opt/metal/mcp-server.bundle.mjs';",launch)
        self.assertIn("export const PLATFORM_API_BUNDLE = '/opt/metal/platform-api.bundle.mjs';",launch)
        # CLOSURE: every file either bundle resolves against its own URL at run time is in the image, at that path
        import posixpath,re
        for b in ['opt/metal/mcp-server.bundle.mjs','opt/metal/platform-api.bundle.mjs']:
            rels=re.findall(r"""new URL\(\s*["'](\.{1,2}/[^"']+)["']\s*,\s*import\.meta\.url\s*\)""",after[b][1].decode())
            self.assertTrue(rels,b)
            for rel in rels:self.assertIn(posixpath.normpath(posixpath.join(posixpath.dirname(b),rel)),after,b+' reads '+rel)
        inimage=json.loads(after['opt/metal/manifest.json'][1])
        self.assertEqual((inimage['control'],inimage['platformApiBundle'],inimage['mcpBundle'],inimage['controlOverlay']['control']),('direct',m['platformApiBundle'],m['mcpBundle'],'direct'))
        self.assertNotIn('expectedMeasurement',m)
        for key in ['unchanged-link','unchanged-file','app','opt','opt/metal']:self.assertEqual(before[key],after[key])
        self.assertTrue(stat.S_ISDIR(after['opt/metal/fixtures'][0][1]))
        second=self.root/'second';mod.overlay(self.base,second,COMMIT,REPO,'direct')
        self.assertEqual((out/'initramfs.cpio.gz').read_bytes(),(second/'initramfs.cpio.gz').read_bytes())
        # a direct image overlaid again keeps ONE control token; a plain overlay of it is refused (its bundle would go stale)
        again=self.root/'again';m2=mod.overlay(out,again,COMMIT,REPO,'direct');self.read(again)
        self.assertEqual(((again/'cmdline').read_text(),m2['cmdlineTemplate']),(self.TEMPLATE+' metal.control=direct\n',m['cmdlineTemplate']))
        with self.assertRaisesRegex(ValueError,'is a control image'):mod.overlay(out,self.root/'plain',COMMIT,REPO)
        self.assertFalse((self.root/'plain').exists())
    def test_plain_overlay_is_unchanged_by_the_control_option(self):
        self.direct_base();out=self.root/'out';m=mod.overlay(self.base,out,COMMIT,REPO);after=self.read(out)
        for k in ['control','platformApiBundle']:self.assertNotIn(k,m)
        self.assertEqual(m['cmdlineTemplate'],self.TEMPLATE);self.assertNotIn('control',m['controlOverlay'])
        self.assertNotIn('opt/metal/platform-api.bundle.mjs',after)
        self.assertEqual((out/'cmdline').read_bytes(),(self.base/'cmdline').read_bytes())
    def test_control_direct_refuses_a_base_it_cannot_measure_as_direct(self):
        cases=[(lambda:self.base_image(),'snp-guest-per-app base'),
               (lambda:self.direct_base(cmdlineTemplate='something else'),'not its manifest'),
               (lambda:self.direct_base(self.TEMPLATE+' metal.control=other'),'another control mode'),
               (lambda:self.direct_base(control='other'),'another control mode')]
        for i,(make,msg) in enumerate(cases):
            make()
            with self.assertRaisesRegex(ValueError,msg):mod.overlay(self.base,self.root/('out%d'%i),COMMIT,REPO,'direct')
            self.assertFalse((self.root/('out%d'%i)).exists())
        self.direct_base()
        with self.assertRaisesRegex(ValueError,'must be direct'):mod.overlay(self.base,self.root/'x',COMMIT,REPO,'indirect')
        self.assertFalse((self.root/'x').exists())
    def fixture_commit(self,bundle=b'export {};\n',sidecar=b'roots\n',manifest=None,gsup="import './measured-control.mjs';\n",mcp_manifest=None,pins=b'{}\n',no_mcp=False):
        repo=self.root/('repo%d'%len(list(self.root.glob('repo*'))));repo.mkdir()
        git=lambda *a:subprocess.check_output(['git','-c','user.name=t','-c','user.email=t@t',*a],cwd=repo)
        git('init','-q')
        def w(rel,data):
            p=repo/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data if isinstance(data,bytes) else data.encode())
        for rel in mod.SUPERVISOR_ROOTS+mod.APP_FILES:w(rel,'')
        for f in mod.GUEST_FILES+['measured-control.mjs']:w('metal/guest/'+f,'')
        w('metal/guest/gsup.mjs',gsup);w(mod.PLATFORM_API_BUNDLE,bundle);w('relay/fixtures/tpm-roots.pem',sidecar)
        w(mod.PLATFORM_API_BUNDLE+'.manifest.json',json.dumps(manifest if manifest is not None else {'sha256':mod.sha(bundle),'bytes':len(bundle),
            'inputs':{'metal/guest/platform-api-entry.mjs':'0'*64},'sidecars':{'fixtures/tpm-roots.pem':{'source':'relay/fixtures/tpm-roots.pem','sha256':mod.sha(sidecar)}}}))
        if not no_mcp:
            w(mod.MCP_BUNDLE,b'export {};\n');w('contracts/deployments/contract-pins-base.json',pins)
            w(mod.MCP_BUNDLE+'.manifest.json',json.dumps(mcp_manifest if mcp_manifest is not None else self.mcp_manifest()))
        git('add','-A');git('commit','-qm','t');return repo,git('rev-parse','HEAD').decode().strip()
    def mcp_manifest(self,**o):
        rf={'opt/metal/fixtures/tpm-roots.pem':{'source':'relay/fixtures/tpm-roots.pem','sha256':mod.sha(b'roots\n')},
            'opt/contracts/deployments/contract-pins-base.json':{'source':'contracts/deployments/contract-pins-base.json','sha256':mod.sha(b'{}\n')}}
        return {'sha256':mod.sha(b'export {};\n'),'bytes':11,'inputs':{'mcp/server.mjs':'0'*64},'runtimeFiles':rf,**o}
    def test_control_direct_checks_the_committed_bundle_manifest(self):
        self.direct_base()
        repo,c=self.fixture_commit();out=self.root/'ok';m=mod.overlay(self.base,out,c,repo,'direct');after=self.read(out)
        self.assertEqual((after['opt/metal/platform-api.bundle.mjs'][1],after['opt/metal/fixtures/tpm-roots.pem'][1]),(b'export {};\n',b'roots\n'))
        self.assertEqual(m['platformApiBundle']['inputs'],1)
        # the MCP adapter and its runtime files; the shared, identical fixtures/tpm-roots.pem is one entry
        self.assertEqual((after['opt/metal/mcp-server.bundle.mjs'][1],after['opt/contracts/deployments/contract-pins-base.json'][1]),(b'export {};\n',b'{}\n'))
        self.assertEqual(sorted(m['mcpBundle']['runtimeFiles']),['/opt/contracts/deployments/contract-pins-base.json','/opt/metal/fixtures/tpm-roots.pem'])
        for d in ['opt/contracts','opt/contracts/deployments']:self.assertTrue(stat.S_ISDIR(after[d][0][1]),d)
        good=lambda **o:{'sha256':mod.sha(b'export {};\n'),'bytes':11,'inputs':{},'sidecars':{'fixtures/tpm-roots.pem':{'source':'relay/fixtures/tpm-roots.pem','sha256':mod.sha(b'roots\n')}},**o}
        for i,(kw,msg) in enumerate([({'manifest':good(sha256='0'*64)},'does not match its manifest'),
                                     ({'manifest':good(bytes=12)},'does not match its manifest'),
                                     ({'sidecar':b'other roots\n','manifest':good()},'sidecar fixtures/tpm-roots.pem does not match'),
                                     ({'gsup':''},'runs no measured control'),
                                     ({'mcp_manifest':self.mcp_manifest(sha256='0'*64)},'hosted MCP guest bundle does not match its manifest'),
                                     ({'mcp_manifest':self.mcp_manifest(bytes=12)},'hosted MCP guest bundle does not match its manifest'),
                                     ({'pins':b'{"other":1}\n'},'MCP runtime file opt/contracts/deployments/contract-pins-base.json does not match'),
                                     ({'no_mcp':True},'has no metal/guest/mcp-server.bundle.mjs and manifest')]):
            repo,c=self.fixture_commit(**kw)
            with self.assertRaisesRegex(ValueError,msg):mod.overlay(self.base,self.root/('bad%d'%i),c,repo,'direct')
            self.assertFalse((self.root/('bad%d'%i)).exists())
        repo,c=self.fixture_commit()
        subprocess.check_output(['git','rm','-q',mod.PLATFORM_API_BUNDLE+'.manifest.json'],cwd=repo)
        subprocess.check_output(['git','-c','user.name=t','-c','user.email=t@t','commit','-qm','no manifest'],cwd=repo)
        with self.assertRaisesRegex(ValueError,'has no metal/guest/platform-api.bundle.mjs and manifest'):mod.overlay(self.base,self.root/'nom','HEAD',repo,'direct')
    def test_control_direct_refuses_sidecar_and_runtime_file_names_that_are_not_plain_or_collide(self):
        self.direct_base();roots={'source':'relay/fixtures/tpm-roots.pem','sha256':mod.sha(b'roots\n')}
        pa=lambda name:{'manifest':{'sha256':mod.sha(b'export {};\n'),'bytes':11,'inputs':{},'sidecars':{name:roots}}}
        cases=[(pa(n),'is not a normal relative path') for n in ['','.','..','../escape.pem','/abs.pem','a//b.pem','a/./b.pem','fixtures/../b.pem','fixtures/','a\\b.pem']]
        cases+=[(pa(n),'would replace /opt/metal/'+n) for n in ['platform-api.bundle.mjs','gsup.mjs','manifest.json','mcp-server.bundle.mjs']]
        rf=lambda at,src='relay/fixtures/tpm-roots.pem',h=mod.sha(b'roots\n'):{'mcp_manifest':self.mcp_manifest(runtimeFiles={at:{'source':src,'sha256':h}})}
        cases+=[(rf(at),'is not a normal relative path') for at in ['','opt/../etc/x','opt//x','/opt/x','opt/./x','opt/x/']]
        cases+=[(rf('app/x.pem'),'is not under opt/'),(rf('etc/passwd'),'is not under opt/')]
        cases+=[(rf(at),'would replace /'+at) for at in ['opt/metal/gsup.mjs','opt/metal/platform-api.bundle.mjs','opt/metal/mcp-server.bundle.mjs','opt/metal/manifest.json']]
        cases+=[(rf('opt/metal/fixtures/tpm-roots.pem',src='contracts/deployments/contract-pins-base.json',h=mod.sha(b'{}\n')),'would replace /opt/metal/fixtures/tpm-roots.pem')]
        for i,(kw,msg) in enumerate(cases):
            repo,c=self.fixture_commit(**kw)
            with self.assertRaisesRegex(ValueError,re.escape(msg)):mod.overlay(self.base,self.root/('n%d'%i),c,repo,'direct')
            self.assertFalse((self.root/('n%d'%i)).exists())
    def test_optional_guest_helpers_follow_the_commit(self):
        gsup=subprocess.check_output(['git','show',COMMIT+':metal/guest/gsup.mjs'],cwd=REPO).decode()
        files=mod.guest_files(COMMIT,REPO)
        for f in mod.OPTIONAL_GUEST_FILES:
            named=("'./"+f+"'") in gsup or any(("'./"+f+"'") in subprocess.check_output(['git','show',COMMIT+':metal/guest/'+g],cwd=REPO).decode() for g in files if g!=f)
            self.assertEqual(f in files,named,f)


import os, shutil
VERIFIER_INPUTS=os.environ.get('CHAIN_VERIFIER_INPUTS')
class ChainVerifierOverlay(ControlOverlay):
    """The local chain verifier's image inputs (metal/chain-verifier-image.json): JavaScript closure always, native files only
    from --chain-verifier-dir and only at their pinned digests, with executable/read-only modes."""
    def pins(self):return json.loads(mod.committed(COMMIT,REPO,mod.CHAIN_VERIFIER_PINS))
    def test_without_inputs_the_javascript_ships_and_the_native_runtime_is_recorded_absent(self):
        self.base_image();out=self.root/'out';m=mod.overlay(self.base,out,COMMIT,REPO);after=self.read(out)
        self.assertIn('opt/metal/chain-verifier.mjs',after)
        for f in ['rpc-runtime-main.mjs','rpc-runtime.mjs','runtime-lock.mjs','witness-gateway.mjs','gossip-head-source.mjs']:
            self.assertEqual(after['app/network/'+f][1],mod.committed(COMMIT,REPO,'network/'+f))
        self.assertFalse(any(k.startswith('opt/rpc-runtime') for k in after),'no IMAGE.json, no native file')
        self.assertEqual(m['controlOverlay']['chainVerifier']['installed'],False)
    @unittest.skipUnless(VERIFIER_INPUTS,'CHAIN_VERIFIER_INPUTS not set')
    def test_with_inputs_every_pinned_file_is_installed_with_its_mode_and_digest(self):
        self.base_image();out=self.root/'out';m=mod.overlay(self.base,out,COMMIT,REPO,chain_verifier_dir=VERIFIER_INPUTS);after=self.read(out)
        p=self.pins()
        for b in p['binaries'].values():
            f=after[b['path'].lstrip('/')];self.assertEqual(f[0][1],0o100555);self.assertEqual(mod.sha(f[1]),b['sha256']);self.assertEqual(f[0][2:4],[0,0])
        for n,d in p['glibcRuntime']['files'].items():
            f=after[(p['glibcRuntime']['dir']+'/'+n).lstrip('/')];self.assertEqual(mod.sha(f[1]),d)
            self.assertEqual(f[0][1],0o100555 if n.startswith('ld-linux') else 0o100444)
        self.assertEqual(after['opt/rpc-runtime/IMAGE.json'][1],mod.committed(COMMIT,REPO,mod.CHAIN_VERIFIER_PINS))
        self.assertTrue(stat.S_ISDIR(after['opt/rpc-runtime/glibc'][0][1]))
        rec=m['controlOverlay']['chainVerifier'];self.assertTrue(rec['installed']);self.assertEqual(rec['pinsSha256'],mod.sha(mod.committed(COMMIT,REPO,mod.CHAIN_VERIFIER_PINS)))
        self.assertEqual(len(rec['files']),len(p['binaries'])+len(p['glibcRuntime']['files'])+1)
    @unittest.skipUnless(VERIFIER_INPUTS,'CHAIN_VERIFIER_INPUTS not set')
    def test_a_native_file_that_is_not_the_pinned_one_refuses_and_writes_nothing(self):
        self.base_image();bad=self.root/'inputs';shutil.copytree(VERIFIER_INPUTS,bad)
        os.chmod(bad/'witness-check',0o644);(bad/'witness-check').write_bytes((bad/'witness-check').read_bytes()+b'x')
        out=self.root/'out'
        with self.assertRaisesRegex(ValueError,'not the pinned'):mod.overlay(self.base,out,COMMIT,REPO,chain_verifier_dir=str(bad))
        self.assertFalse(out.exists())
# reuse ControlOverlay's fixtures without running its tests a second time
for _n in [n for n in vars(ControlOverlay) if n.startswith('test_')]:
    setattr(ChainVerifierOverlay, _n, None)

READER_INPUTS=os.environ.get('DERIVED_READER_INPUTS')
class DerivedReaderOverlay(ControlOverlay):
    """The lease writer's derived reader assets (metal/derived-reader-image.json): control images only, every native input from
    --derived-reader-dir at its pinned digest, the commit's own reviewed config, read-only modes under /opt/enclave, and nothing
    private (state/journal) in the image."""
    def committed_pins(self):return json.loads(mod.committed(COMMIT,REPO,mod.DERIVED_READER_PINS))
    def fixture(self,mutate_pins=None,mutate_cfg=None):
        d=self.root/'reader-inputs';d.mkdir(exist_ok=True)
        names=['derivation_harness_lease_v3','helios','checkpoint.json','ld-linux-x86-64.so.2','libc.so.6','libm.so.6','libgcc_s.so.1']
        dig={}
        for n in names:(d/n).write_bytes(('fixture '+n).encode());dig[n]=mod.sha((d/n).read_bytes())
        pins=json.loads(json.dumps(self.committed_pins()))
        pins['binaries']['native']['sha256'],pins['binaries']['l1']['sha256']=dig['derivation_harness_lease_v3'],dig['helios']
        pins['files']['checkpoint']['sha256']=dig['checkpoint.json']
        pins['glibcRuntime']['files']={n:dig[n] for n in names[3:]}
        cfg=json.loads(mod.committed(COMMIT,REPO,pins['config']['source']))
        cfg['native']['sha256'],cfg['l1']['binary']['sha256']=dig['derivation_harness_lease_v3'],dig['helios']
        if mutate_cfg:mutate_cfg(cfg)
        cb=(json.dumps(cfg,indent=2)+'\n').encode();pins['config']['sha256']=mod.sha(cb)
        if mutate_pins:mutate_pins(pins)
        return (json.dumps(pins,indent=1)+'\n').encode(),cb,d
    def test_committed_record_and_config_agree_and_hold_no_private_data(self):
        p=self.committed_pins();cb=mod.committed(COMMIT,REPO,p['config']['source']);cfg=json.loads(cb)
        self.assertEqual(mod.sha(cb),p['config']['sha256'])
        self.assertEqual((p['binaries']['native']['sha256'],p['binaries']['l1']['sha256'],p['files']['checkpoint']['sha256']),
            ('49f4d7e3e70e48f7374b0e12b3d300978062cce19cbd75552065f918173a76fa','cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0',
             '2e8502e68864abb49a230a69612bd7c98c94775d8dd81f956a0185d53652ac33'))
        self.assertTrue(cfg['stateDir'].startswith('/run/measured-control/platform-api/') and cfg['initializeState'] is False)
        self.assertNotIn(p['private']['stateDir'],[v['path'] for v in [*p['binaries'].values(),*p['files'].values()]])
        self.assertEqual(p['relayEnv']['ENCLAVE_DERIVED_READER_CONFIG'],p['config']['path'])
        self.assertTrue(p['relayEnv']['ENCLAVE_DERIVED_ANCHOR_JOURNAL'].startswith(p['private']['stateDir']+'/'))
        # the reviewed source pins (KVM's committed reader and the RPC runtime) are what the image record pins
        src=lambda f:mod.committed(COMMIT,REPO,f).decode()
        self.assertIn(p['binaries']['native']['sha256'],src('network/derived-reader/native.mjs'))
        l1=src('network/derived-reader/l1-runtime.mjs')
        self.assertIn(p['binaries']['l1']['sha256'],l1);self.assertIn(p['files']['checkpoint']['sha256'],l1)
        rt=src('network/rpc-runtime.mjs');self.assertIn(p['glibcRuntime']['build'],rt)
        for n,dg in p['glibcRuntime']['files'].items():self.assertIn(dg,rt)
        pb,cb2,d=self.fixture();files,modes,rec=mod.derived_reader_install(pb,cb2,d);self.assertEqual(len(rec['files']),2+1+4+1+1)
    def test_installer_places_pinned_files_read_only_under_opt_enclave(self):
        pb,cb,d=self.fixture();files,modes,rec=mod.derived_reader_install(pb,cb,d);p=json.loads(pb)
        self.assertEqual(modes['opt/enclave/bin/derivation_harness_lease_v3'],0o100555);self.assertEqual(modes['opt/enclave/bin/helios'],0o100555)
        self.assertEqual(modes['opt/enclave/policy/checkpoint.json'],0o100444);self.assertEqual(modes['opt/enclave/glibc/ld-linux-x86-64.so.2'],0o100555)
        self.assertEqual(modes['opt/enclave/glibc/libc.so.6'],0o100444)
        self.assertEqual(files['opt/enclave/policy/derived-reader-v3.json'],cb);self.assertEqual(modes['opt/enclave/policy/derived-reader-v3.json'],0o100444)
        self.assertEqual(files['opt/enclave/DERIVED-READER-IMAGE.json'],pb)
        self.assertTrue(all(k.startswith('opt/enclave/') for k in files))
        self.assertFalse(any(k.startswith(p['private']['stateDir'].lstrip('/')) for k in files),'no state or journal in the image')
    def test_installer_refusals(self):
        cases=[(dict(),'not the pinned',lambda d:(d/'helios').write_bytes(b'other bytes')),
               (dict(mutate_pins=lambda p:p['binaries']['native'].update(path='/usr/local/bin/x')),'disagree',None),
               (dict(mutate_pins=lambda p:(p['binaries']['native'].update(path='/opt/enclave/bin/../../etc/x'))),'disagree',None),
               (dict(mutate_pins=lambda p:p['config'].update(sha256='0'*64)),'does not match its pin',None),
               (dict(mutate_cfg=lambda c:c.update(stateDir='/opt/enclave/state')),'disagree',None),
               (dict(mutate_cfg=lambda c:c.update(initializeState=True),mutate_pins=None),'never auto-initialized',None),
               (dict(mutate_cfg=lambda c:c['l1'].update(apiToken='x')),'secret-shaped',None),
               (dict(mutate_cfg=lambda c:c['native'].update(sha256='1'*64)),'disagree',None),
               (dict(mutate_pins=lambda p:p.update(hostPassThrough='/home')),'reviewed enclave-derived-reader-image/v1 shape',None),
               # consistent pins AND config that still break a rule: a path outside /opt/enclave, state outside the RAM fs
               (dict(mutate_pins=lambda p:p['binaries']['native'].update(path='/usr/local/bin/x'),
                     mutate_cfg=lambda c:c['native'].update(path='/usr/local/bin/x')),'must live under /opt/enclave',None),
               (dict(mutate_pins=lambda p:p['private'].update(stateDir='/opt/enclave/state'),
                     mutate_cfg=lambda c:c.update(stateDir='/opt/enclave/state')),'guest RAM directory',None)]
        for kw,needle,after in cases:
            pb,cb,d=self.fixture(**kw)
            if after:after(d)
            with self.assertRaisesRegex(ValueError,needle,msg=str(kw)):mod.derived_reader_install(pb,cb,d)
        pb,cb,d=self.fixture();(d/'checkpoint.json').unlink()
        with self.assertRaises(OSError):mod.derived_reader_install(pb,cb,d)
    def test_control_image_without_inputs_records_absent_and_plain_images_refuse_the_flag(self):
        self.direct_base();out=self.root/'out';m=mod.overlay(self.base,out,COMMIT,REPO,'direct');after=self.read(out)
        self.assertFalse(any(k.startswith('opt/enclave') for k in after))
        self.assertEqual(m['controlOverlay']['derivedReader']['installed'],False)
        self.base_image();out2=self.root/'out2'
        with self.assertRaisesRegex(ValueError,'control images'):mod.overlay(self.base,out2,COMMIT,REPO,derived_reader_dir=str(self.root))
        self.assertFalse(out2.exists())
    @unittest.skipUnless(READER_INPUTS,'DERIVED_READER_INPUTS not set')
    def test_with_real_inputs_every_pinned_file_is_installed_in_the_control_image(self):
        self.direct_base();out=self.root/'out';m=mod.overlay(self.base,out,COMMIT,REPO,'direct',derived_reader_dir=READER_INPUTS);after=self.read(out)
        p=self.committed_pins()
        for v in [*p['binaries'].values(),p['files']['checkpoint']]:
            self.assertEqual(mod.sha(after[v['path'].lstrip('/')][1]),v['sha256'])
        self.assertEqual(after['opt/enclave/bin/derivation_harness_lease_v3'][0][1],0o100555);self.assertEqual(after['opt/enclave/bin/helios'][0][2:4],[0,0])
        self.assertEqual(after['opt/enclave/policy/derived-reader-v3.json'][1],mod.committed(COMMIT,REPO,p['config']['source']))
        self.assertEqual(after['opt/enclave/DERIVED-READER-IMAGE.json'][1],mod.committed(COMMIT,REPO,mod.DERIVED_READER_PINS))
        rec=m['controlOverlay']['derivedReader'];self.assertTrue(rec['installed']);self.assertEqual(len(rec['files']),2+1+4+1+1)
    @unittest.skipUnless(READER_INPUTS,'DERIVED_READER_INPUTS not set')
    def test_with_real_inputs_a_changed_native_file_refuses_and_writes_nothing(self):
        self.direct_base();bad=self.root/'inputs';shutil.copytree(READER_INPUTS,bad)
        os.chmod(bad/'derivation_harness_lease_v3',0o644);(bad/'derivation_harness_lease_v3').write_bytes((bad/'derivation_harness_lease_v3').read_bytes()+b'x')
        out=self.root/'out'
        with self.assertRaisesRegex(ValueError,'not the pinned'):mod.overlay(self.base,out,COMMIT,REPO,'direct',derived_reader_dir=str(bad))
        self.assertFalse(out.exists())
for _n in [n for n in vars(ControlOverlay) if n.startswith('test_')]:
    setattr(DerivedReaderOverlay, _n, None)

if __name__=='__main__':unittest.main()
