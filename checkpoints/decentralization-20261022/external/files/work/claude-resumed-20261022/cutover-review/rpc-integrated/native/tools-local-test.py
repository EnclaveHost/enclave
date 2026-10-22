"""Local assembly test of native-rpc-test.ps1 on Linux pwsh 7 (-LocalMock: Get-Acl/Set-Acl mocked, a SYNTHETIC launcher, local node).
NOT Windows evidence: the native run proves the real launcher plan, SDDL, NTFS ACL round trip and node.exe argv."""
import hashlib, json, os, pathlib, shutil, subprocess, sys, tempfile
N = pathlib.Path(__file__).resolve().parent; PWSH = os.environ['PWSH']
sys.path.insert(0, str(N.parent / 'tools')); import importlib.util
spec = importlib.util.spec_from_file_location('fx', N.parent / 'tools/cutover-mock-test.py'); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
harness = '''param([string]$Fixture, [string]$Stage, [string]$RunNode, [string]$Node, [string]$Old, [string]$New)
function global:Get-Acl { param($LiteralPath) $a = [pscustomobject]@{ Sddl = 'O:BAG:SYD:AI(A;ID;FA;;;BA)(A;ID;FA;;;SY)' }; $a }
function global:Set-Acl { param($LiteralPath, $AclObject) }
& $Fixture -Stage $Stage -RunNodePath $RunNode -NodeExe $Node -LocalMock -ExpectOld $Old -ExpectNew $New; exit $LASTEXITCODE'''
res = {}
for name, launcher in (('synthetic-live-shape', m.RUN_NODE_OLD), ('already-repaired', m.RUN_NODE_NEW)):
    d = pathlib.Path(tempfile.mkdtemp(prefix='rpc-native-local-'))
    try:
        stage = d / 'stage'; stage.mkdir(); shutil.copy2(N / 'cutover.ps1', stage / 'cutover.ps1'); (d / 'run-node.cmd').write_bytes(launcher); (d / 'h.ps1').write_text(harness)
        c = subprocess.run([PWSH, '-NoProfile', '-File', str(d / 'h.ps1'), '-Fixture', str(N / 'native-rpc-test.ps1'), '-Stage', str(stage), '-RunNode', str(d / 'run-node.cmd'),
                            '-Node', shutil.which('node'), '-Old', hashlib.sha256(m.RUN_NODE_OLD).hexdigest(), '-New', hashlib.sha256(m.RUN_NODE_NEW).hexdigest()], capture_output=True, text=True, timeout=120)
        o = json.loads([l for l in c.stdout.splitlines() if l.startswith('{')][-1]); res[name] = {'rc': c.returncode, **{k: o.get(k) for k in ('pass', 'liveOk', 'casOk', 'renderOk', 'gupdOk', 'gupd', 'error')}, 'plan': o.get('live', {}).get('plan'), 'stageCas': o.get('stageCas'), 'render': o.get('render')}
        assert (launcher == m.RUN_NODE_OLD) == (pathlib.Path(d / 'run-node.cmd').read_bytes() == m.RUN_NODE_OLD), 'the live launcher is never written'
    finally: shutil.rmtree(d, ignore_errors=True)
print(json.dumps(res))
a, b = res['synthetic-live-shape'], res['already-repaired']
assert a['rc'] == 0 and a['pass'] and a['liveOk'] and a['casOk'] and a['renderOk'] and a['gupd']['passed'] == a['gupd']['total'] == 15, a
assert b['rc'] == 3 and not b['pass'] and not b['liveOk'] and b['casOk'] and b['renderOk'] and not b['plan']['ok'], 'negative control: a launcher without the override fails the live plan'
print('LOCAL FIXTURE OK (2 cases)')
