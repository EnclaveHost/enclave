from pathlib import Path
import importlib.util,hashlib,json,subprocess,sys
ROOT=Path(__file__).resolve().parent
assert hashlib.sha256((ROOT/'statement-stream.mjs').read_bytes()).hexdigest()=='a04ae9fd2599d74ff51e6b0a1402b7e102a64614429b76bf44ee7d13ec33accf'
SOURCE=ROOT/'assemble-r2.py'
assert hashlib.sha256(SOURCE.read_bytes()).hexdigest()=='2adce4311bdc45f32f79a6025deb5bd9f69261f7e9226309783cd3c00e59e99f'
spec=importlib.util.spec_from_file_location('prepared_assembly',SOURCE)
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
def statement(out,version=a.VERSION,channel='stable'):
    a.need(a.sha_file(a.VERIFIER)==a.VERIFIER_SHA,'verifier changed')
    st=out/f'release-{version}.statement.json'
    subprocess.run(['node',str(ROOT/'statement-stream.mjs'),str(a.VERIFIER),channel,version,str(out/f'enclave-host-{version}.zip'),str(out/f'EnclaveSetup-{version}.exe'),str(out/f'manifest-{version}.json'),str(st)],check=True,timeout=120)
    return json.loads(st.read_text())
assert a.sha_file(a.INVENTORY)=='c6ec79c5e0f55ef257df35fff74c8b6e080ebaf3922d781868b4b449f5fd1d48'
a.statement=statement
sys.exit(a.main(sys.argv[1:]))
