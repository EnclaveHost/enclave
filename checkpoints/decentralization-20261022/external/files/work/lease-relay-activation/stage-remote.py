import sys,hashlib,tarfile,io,json,pathlib,os
blob=sys.stdin.buffer.read(1000000)
want="032c08ea19b854bf4edf8736df57c3b43ae69cbfb50e4468e2700026dd3bd682"
assert hashlib.sha256(blob).hexdigest()==want
stage=pathlib.Path("/var/tmp/enclave-lease-stage-"+want[:16]);stage.mkdir(mode=0o700)
expected={"lease-relay.mjs","lease-relay-check.mjs","build-manifest.json","deployment.json","relay.env","enclave-lease-relay.service","staging-manifest.json"}
with tarfile.open(fileobj=io.BytesIO(blob)) as tar:
 members=tar.getmembers();assert {m.name for m in members}==expected;assert len(members)==len(expected)
 for m in members:
  assert m.isfile() and m.name in expected
  b=tar.extractfile(m).read();fd=os.open(stage/m.name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600 if m.name=="relay.env" else 0o644)
  with os.fdopen(fd,"wb") as f:f.write(b)
manifest=json.loads((stage/"staging-manifest.json").read_text())
for n,h in manifest["files"].items():assert hashlib.sha256((stage/n).read_bytes()).hexdigest()==h
print(json.dumps({"status":"staged and hashes verified; no installation, service start, or funding","directory":str(stage),"archiveSha256":want,"files":len(expected)}))
