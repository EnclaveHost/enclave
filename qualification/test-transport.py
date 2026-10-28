#!/usr/bin/env python3
"""Tiny hermetic archive-admission checks: no real image, credentials or network."""
import datetime, hashlib, io, json, os, shutil, subprocess, sys, tarfile, tempfile, time, unittest
from pathlib import Path

class ArchiveAdmission(unittest.TestCase):
    def run_case(self, mutation=None):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name); (root/'out').mkdir()
            shutil.copyfile(Path(__file__).with_name('unpack-input.py'),root/'unpack-input.py')
            content={n:b'fixed-'+n.encode() for n in ['initramfs.cpio.gz','vmlinuz','cmdline','manifest.json']}
            pins={n:{'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()} for n,b in content.items()}
            (root/'input-pins.json').write_text(json.dumps({'files':pins}))
            items=[]
            for n,b in content.items():
                item=tarfile.TarInfo(n); item.size=len(b); items.append((item,b))
            if mutation: mutation(items)
            with tarfile.open(root/'input.tar','w') as archive:
                for item,data in items: archive.addfile(item,io.BytesIO(data))
            r=subprocess.run([sys.executable,str(root/'unpack-input.py'),str(root/'input.tar'),str(root/'out')],capture_output=True)
            return r.returncode,sorted(p.name for p in (root/'out').iterdir())
    def test_valid(self): self.assertEqual(self.run_case()[0],0)
    def test_parent_escape(self):
        self.assertNotEqual(self.run_case(lambda xs:setattr(xs[0][0],'name','../escape'))[0],0)
    def test_absolute_path(self):
        self.assertNotEqual(self.run_case(lambda xs:setattr(xs[0][0],'name','/escape'))[0],0)
    def test_duplicate(self): self.assertNotEqual(self.run_case(lambda xs:xs.append(xs[0]))[0],0)
    def test_missing(self): self.assertNotEqual(self.run_case(lambda xs:xs.pop())[0],0)
    def test_hash_mismatch(self):
        self.assertNotEqual(self.run_case(lambda xs:xs.__setitem__(0,(xs[0][0],b'x'*len(xs[0][1]))))[0],0)
    def test_size_mismatch(self):
        def mutate(xs): xs[0][0].size-=1
        self.assertNotEqual(self.run_case(mutate)[0],0)
    def test_symlink(self):
        def mutate(xs): xs[0][0].type=tarfile.SYMTYPE; xs[0][0].linkname='/etc/shadow'
        self.assertNotEqual(self.run_case(mutate)[0],0)

class CleanupLifetime(unittest.TestCase):
    def run_case(self, scenario):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name); tag='reaper-input-20261028-123456abcdef'; local=root/tag; local.mkdir()
            (local/'identity.agekey').write_text('nonsecret test placeholder')
            now=int(time.time()); stamp=datetime.datetime.fromtimestamp(now-120,datetime.timezone.utc).isoformat()
            env='reaper-artifact-20261028-123456abcdef'; sha='a'*40
            state={'repository':'EnclaveHost/enclave','environment':env,'branch':'build/lease-reaper-artifact-20261028',
                   'sourceSha':sha,'tag':tag,'createdAt':now-180,'expiresAt':now-1,
                   'localTransportDirectory':str(local),'environmentId':None,'releaseId':None,'runId':None,
                   'environmentCreateIntent':{'at':now-120,'name':env,'sourceSha':sha,
                         'policy':{'protected_branches':False,'custom_branch_policies':True}},
                   'releaseCreateIntent':{'at':now-120,'tag':tag,'sourceSha':sha,'body':'exact owned intent',
                         'draft':False,'prerelease':True,'name':'Temporary encrypted reaper build input'}}
            environment={'id':7,'name':env,'created_at':stamp,'deployment_branch_policy':state['environmentCreateIntent']['policy']}
            release={'id':9,'tag_name':tag,'draft':False,'prerelease':True,'name':'Temporary encrypted reaper build input',
                     'target_commitish':sha,'body':'exact owned intent','created_at':stamp,'assets':[]}
            routes={'GET releases?per_page=100&page=1':{'value':[]}}
            scenario(state,routes,environment,release)
            statefile=root/'state.json'; statefile.write_text(json.dumps(state))
            fixture=root/'fixture.json'; fixture.write_text(json.dumps(routes))
            fake=root/'gh'
            fake.write_text('#!'+sys.executable+'\n'+'''import json,os,sys
from pathlib import Path
path=sys.argv[-1].removeprefix('repos/EnclaveHost/enclave/')
method=sys.argv[sys.argv.index('--method')+1]
key=method+' '+path
with open(os.environ['FAKE_GH_LOG'],'a') as f: f.write(key+'\\n')
r=json.loads(Path(os.environ['FAKE_GH_FIXTURE']).read_text()).get(key,{'error':'HTTP 404'})
if 'error' in r: print(r['error'],file=sys.stderr); raise SystemExit(1)
print(json.dumps(r.get('value',{})))
'''); fake.chmod(0o700)
            log=root/'calls'
            process=subprocess.run([sys.executable,str(Path(__file__).with_name('cleanup-transport.py')),str(statefile),'--expired'],
                env={**os.environ,'PATH':str(root)+os.pathsep+os.environ['PATH'],'FAKE_GH_FIXTURE':str(fixture),'FAKE_GH_LOG':str(log)},capture_output=True)
            return process.returncode,local.exists(),log.read_text() if log.exists() else '',json.loads(statefile.read_text())
    def test_expired_key_deleted_before_network_failure(self):
        def setup(s,r,e,a): r['GET environments/'+s['environment']]={'error':'HTTP 503 timeout'}
        rc,exists,calls,s=self.run_case(setup)
        self.assertNotEqual(rc,0); self.assertFalse(exists); self.assertIn('localKeyRetiredAt',s)
    def test_expired_key_deleted_on_run_cancel_retry(self):
        def setup(s,r,e,a):
            s['runId']=10
            r['GET actions/runs/10']={'value':{'head_sha':s['sourceSha'],'head_branch':s['branch'],'status':'in_progress'}}
            r['POST actions/runs/10/cancel']={'value':{}}
        rc,exists,calls,s=self.run_case(setup)
        self.assertNotEqual(rc,0); self.assertFalse(exists); self.assertIn('POST actions/runs/10/cancel',calls)
    def test_ambiguous_environment_creation_reconciled(self):
        def setup(s,r,e,a):
            p='environments/'+s['environment']
            r['GET '+p]={'value':e}; r['GET '+p+'/deployment-branch-policies']={'value':{'branch_policies':[]}}
            r['GET '+p+'/secrets']={'value':{'secrets':[]}}
            r['GET git/ref/heads/'+s['branch']]={'value':{'object':{'sha':s['sourceSha']}}}
            r['DELETE '+p]={'value':{}}
        rc,exists,calls,s=self.run_case(setup)
        self.assertEqual(rc,0); self.assertFalse(exists); self.assertEqual(s['environmentId'],7)
        self.assertIn('DELETE environments/'+s['environment']+'\n',calls)
    def test_ambiguous_release_creation_reconciled(self):
        def setup(s,r,e,a): r['GET releases?per_page=100&page=1']={'value':[a]}; r['DELETE releases/9']={'value':{}}
        rc,exists,calls,s=self.run_case(setup)
        self.assertEqual(rc,0); self.assertFalse(exists); self.assertEqual(s['releaseId'],9); self.assertIn('DELETE releases/9',calls)
    def test_unrelated_release_refused(self):
        def setup(s,r,e,a): a['body']='another intent'; r['GET releases?per_page=100&page=1']={'value':[a]}
        rc,exists,calls,s=self.run_case(setup)
        self.assertNotEqual(rc,0); self.assertFalse(exists); self.assertNotIn('DELETE releases/',calls)
    def test_regular_release_refused(self):
        def setup(s,r,e,a): a['prerelease']=False; r['GET releases?per_page=100&page=1']={'value':[a]}
        rc,exists,calls,s=self.run_case(setup)
        self.assertNotEqual(rc,0); self.assertFalse(exists); self.assertNotIn('DELETE releases/',calls)
    def test_replaced_environment_refused(self):
        def setup(s,r,e,a): s['environmentId']=99; r['GET environments/'+s['environment']]={'value':e}
        rc,exists,calls,s=self.run_case(setup)
        self.assertNotEqual(rc,0); self.assertFalse(exists); self.assertNotIn('DELETE ',calls)
    def test_unexpired_identity_untouched_without_remote_calls(self):
        def setup(s,r,e,a): s['expiresAt']=int(time.time())+60
        rc,exists,calls,s=self.run_case(setup)
        self.assertEqual(rc,0); self.assertTrue(exists); self.assertEqual(calls,'')

if __name__=='__main__': unittest.main()
