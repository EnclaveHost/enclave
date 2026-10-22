"""Read-only check of the live place2 fixture. No indexer writes, stops or config changes."""
from pathlib import Path
import ast, datetime, hashlib, hmac, http.client, json, random, re, types, urllib.parse
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parent.parent
source = root / 'work/storage-hosted-placement/e2e/placement_e2e.py'
tree = ast.parse(source.read_text())
names = {'enc', 's3', 'list_keys'}
functions = [x for x in tree.body if isinstance(x, ast.FunctionDef) and x.name in names]
assert {x.name for x in functions} == names
scope = dict(hashlib=hashlib, hmac=hmac, datetime=datetime, http=http, urllib=urllib, ET=ET,
    AK='VALIDATIONAK', SK='validation-fixture-secret-not-a-real-credential', BUCKET='val',
    REGION='auto', NS='{http://s3.amazonaws.com/doc/2006-03-01/}')
exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), 'exec'), scope)
fixture = json.loads((root / 'work/storage-hosted-placement/e2e/runs/place2/results.json').read_text())
port = int(re.search(r'ENCLAVE_PORTS=http:8000=(\d+)', fixture['commands']['rebuild-r3']).group(1))
instance = types.SimpleNamespace(ep=('127.0.0.1', port))
s3 = scope['s3']
status, keys, _ = scope['list_keys'](instance, 'p/')
expected = {'p/small-a': ('Pp/small-a', 1024), 'p/small-b': ('Pp/small-b', 200000),
    'p/big': ('Pp/big', 12 * 1024**2), 'p/during-loss': ('Pduring-loss', 2 * 1024**2)}
checks = [{'name': 'LIST p/ returns exactly the four written keys',
    'ok': status == 200 and sorted(keys) == sorted(expected), 'status': status, 'keys': keys}]
for key, (tag, size) in sorted(expected.items()):
    want = hashlib.sha256(random.Random(tag).randbytes(size)).hexdigest()
    digest = hashlib.sha256()
    status, _, _ = s3(instance, 'GET', key, timeout=30, sink=digest)
    checks.append({'name': 'GET '+key+' has original body hash', 'ok': status == 200 and digest.hexdigest() == want,
                   'status': status, 'sha256': digest.hexdigest(), 'expectedSha256': want})
report = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'fixture': 'place2/rebuild-r3',
    'scope': 'Read-only logical listing and body integrity while the worker keeps its existing fixture running. Does not independently prove replica3 recovery with other replicas removed.',
    'testSourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'checks': checks}
(root / 'outputs/storage-indexd-review/placement-prefix-readback.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
raise SystemExit(0 if all(c['ok'] for c in checks) else 1)
