from pathlib import Path
import subprocess,json,sys,hashlib
p=Path(__file__).parent
candidate='--candidate' in sys.argv
release='1da344346ffe01df7695059bf4c27a5ef48ea6dc5cad11f6893683c71e5933f7' if candidate else 'af50d526be6deefcdd815968ff1dd2c04327f6c3b3f981c0aa90cc585b0effae'
measurement='f369af4d818204a0f9ddb87d5ecba9c077f7ab13a493447cc22cdf8d1e3575e22d910f7a6ebda2a063535f500bc247c4' if candidate else '66ba9f551f25158faf428b82a93dc073751b194c7b76b1e83ffad1ce9c0eae8d521b080d3a39603b1ab2272c67a69217'
client='/home/steven/Projects/enclave/.consolidation/2026-10-24/worktrees/enclave-padgov-init/isolation/m2/client.mjs'
a=['node',client,'https://eyesoff.ai','--measurement',measurement,'--app-sha','5bac47ac3b99d9999314ac3f5ee7c2749defdde98b2a52212302d05da13d58eb','--runtime','/home/steven/enclave-prod/release-'+release[:8]+'/template/rt/runtime.json','--vcek','/home/steven/.cache/enclave-isolation/m3-clean/vcek.der','--min-tcb','@/home/steven/.cache/enclave-isolation/m3-clean/min-tcb.json','--amd-chain','Turin=/home/steven/enclave-prod/iso-sdshield-1c3cdbb8/test/fixtures/amd/Turin-cert_chain.pem','--no-kds','--path','/models','--answer-within','60000','--host-data','0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c','--release',release]
label='candidate' if candidate else 'baseline'
(p/(label+'-attestation-argv.json')).write_text(json.dumps({'argv':a,'clientSha256':hashlib.sha256(Path(client).read_bytes()).hexdigest()},indent=2)+'\n')
with (p/(label+'-attestation.out')).open('x') as f:r=subprocess.run(a,stdout=f,stderr=subprocess.STDOUT,timeout=100)
print(label,'exit',r.returncode);raise SystemExit(r.returncode)
