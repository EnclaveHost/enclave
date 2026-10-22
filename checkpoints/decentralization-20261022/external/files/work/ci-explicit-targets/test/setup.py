import json, os, pathlib, subprocess, tempfile, unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'tree/scripts/ci-setup.sh'
STUB = r'''#!/usr/bin/python3
import sys, os, json, pathlib
name=pathlib.Path(sys.argv[0]).name; args=sys.argv[1:]
with open(os.environ['CALLS'],'a') as f:f.write(json.dumps([name,args])+'\n')
if name=='ssh-keygen':
 if '-F' in args:
  host=args[args.index('-F')+1]
  sys.exit(0 if host in pathlib.Path(args[args.index('-f')+1]).read_text().split() else 1)
 p=pathlib.Path(args[args.index('-f')+1]);p.write_text('TEST-ONLY-NOT-A-KEY');pathlib.Path(str(p)+'.pub').write_text('ssh-ed25519 AAAA enclave-test\n')
elif name=='ssh':
 target=args[-2]
 if target==os.environ.get('UNREACHABLE'):sys.exit(255)
 if args[-1]!='true':
  key=sys.stdin.read()
  assert key.startswith('ssh-ed25519 AAAA ')
  assert 'enclave-test' not in args[-1], 'public key interpolated into remote command'
  if target==os.environ.get('INSTALL_FAIL'):sys.exit(23)
elif name=='gh':
 if args[:2]==['api','user']:
  print('123' if args[-1]=='.id' else 'enclave-admin')
 elif args[:2]==['secret','set']:
  assert sys.stdin.read()=='TEST-ONLY-NOT-A-KEY'
 elif '--input' in args:
  body=json.load(sys.stdin);assert body=={'reviewers':[{'type':'User','id':123}]}
 elif args[:3]==['variable','set','DEPLOY_KNOWN_HOSTS']:
  assert sys.stdin.read().strip()=='api.example dns.example'
'''

class SetupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=ROOT)
        self.p = pathlib.Path(self.tmp.name); b = self.p/'bin'; b.mkdir()
        for name in ('gh', 'ssh', 'ssh-keygen'):
            f = b/name; f.write_text(STUB); f.chmod(0o755)
        self.known = self.p/'known'; self.known.write_text('api.example dns.example\n')
        self.env = {k:v for k,v in os.environ.items() if not k.startswith(('RELAY_', 'KEYFILE', 'DEPLOY_', 'SITE_', 'EXTRA_RELAY_', 'REPO_SLUG', 'CONTRACTS_NETWORK'))}
        self.env.update(PATH=str(b)+':/usr/bin:/bin', CALLS=str(self.p/'calls'),
            RELAY_DEPLOY_ROLES='api,dns', RELAY_API_TARGET='root@api.example',
            RELAY_API_DIR='/opt/enclave-api', RELAY_DNS_TARGET='root@dns.example',
            RELAY_DNS_DIR='/opt/enclave-dns', KEYFILE=str(self.p/'key'),
            DEPLOY_KNOWN_HOSTS_FILE=str(self.known))
    def tearDown(self): self.tmp.cleanup()
    def run_script(self, *args):
        return subprocess.run(['bash', str(SCRIPT), *args], env=self.env,
                              capture_output=True, text=True, timeout=10)
    def calls(self):
        p=self.p/'calls';return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []
    def test_missing_and_malicious_targets_have_no_external_effect(self):
        for value in ['', '-oProxyCommand=bad', 'root@api.example;bad']:
            self.env['RELAY_API_TARGET']=value
            r=self.run_script()
            self.assertNotEqual(r.returncode,0,r.stdout+r.stderr)
            self.assertEqual(self.calls(),[])
            self.assertFalse((self.p/'key').exists())
    def test_validation_only_checks_verified_keys(self):
        r=self.run_script('--check-config')
        self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertTrue(all(name=='ssh-keygen' and '-F' in args for name,args in self.calls()))
        self.assertFalse((self.p/'key').exists())
    def test_missing_host_key_refuses_before_any_connection(self):
        self.known.write_text('api.example\n');r=self.run_script()
        self.assertNotEqual(r.returncode,0)
        self.assertIn('verified host key missing',r.stderr)
        self.assertFalse(any(name in ['ssh','gh'] for name,args in self.calls()))
    def test_unreachable_second_host_prevents_key_and_github_changes(self):
        self.env['UNREACHABLE']='root@dns.example';r=self.run_script()
        self.assertNotEqual(r.returncode,0)
        self.assertFalse((self.p/'key').exists())
        self.assertFalse(any(name=='gh' for name,args in self.calls()))
    def test_success_configures_selected_roles_and_retains_admin_gate(self):
        r=self.run_script()
        self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        calls=self.calls()
        variables={args[2]:args[-1] for name,args in calls if name=='gh' and args[:2]==['variable','set'] and '-b' in args}
        self.assertEqual(variables['RELAY_API_TARGET'],'root@api.example')
        self.assertEqual(variables['RELAY_DNS_DIR'],'/opt/enclave-dns')
        self.assertNotIn('SITE_SSH_HOST',variables)
        self.assertNotIn('RELAY_SSH_HOST',variables)
        self.assertTrue(any(name=='gh' and 'repos/EnclaveHost/enclave/environments/contract-deploy' in args for name,args in calls))
        ssh_calls=[args for name,args in calls if name=='ssh']
        self.assertEqual({args[-2] for args in ssh_calls},{'root@api.example','root@dns.example'})
        self.assertTrue(all('StrictHostKeyChecking=yes' in args for args in ssh_calls))
    def test_key_install_failure_does_not_publish_partial_github_configuration(self):
        self.env['INSTALL_FAIL']='root@dns.example';r=self.run_script()
        self.assertNotEqual(r.returncode,0)
        self.assertIn('earlier selected hosts may already have the key',r.stderr)
        self.assertFalse(any(name=='gh' and args[:2] in [['variable','set'],['secret','set']] for name,args in self.calls()))

if __name__=='__main__':unittest.main(verbosity=2)
