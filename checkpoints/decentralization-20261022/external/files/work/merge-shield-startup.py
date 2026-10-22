from pathlib import Path
import subprocess
root=Path('work/shield-lineage-integration')
def prod(p): return subprocess.check_output(['git','-C','work/enclave','show','refs/remotes/lineage/shield-production:'+p],text=True)
# Diffs inspected against the snapshot: preserve restored vTPM reporting; production additions supply bundle config,
# per-domain secret pipe, native commands and the existing Shield broker. Inference policy definitions remain current.
for p in ['isolation/m3/monitor/main.go','isolation/m3/domexec.c','isolation/contract/bundle.go']:
 (root/p).write_text(prod(p))
p='isolation/m2/front/main.go';s=(root/p).read_text();ps=prod(p)
s=s.replace('"enclave.host/isolation/m2/release"','"enclave.host/isolation/m2/release"\n\t"enclave.host/isolation/m2/shieldconfig"')
s=s.replace('type front struct {','type front struct {\n\tsecrets *shieldSecrets // legacy Shield release channel; independent builds never initialize relay pins')
s=s.replace('\tport := flag.Uint(', '\tshieldSecretsFD := flag.Int("shield-secrets-fd", 0, "private pipe to the measured secret-aware launcher")\n\tport := flag.Uint(',1)
start=ps.index('\tif *shieldSecretsFD != 0 {');end=ps.index('\ttl := tls.NewListener',start)
block=ps[start:end]
block=block.replace('\tif *shieldSecretsFD != 0 {','\tif *shieldSecretsFD != 0 {\n\t\tif directBootstrap {\n\t\t\tdie("independent Shield secret startup is not integrated; refusing legacy relay release")\n\t\t}')
s=s.replace('\ttl := tls.NewListener',block+'\ttl := tls.NewListener',1)
s=s.replace('\t\tfor deadline := time.Now().Add(120 * time.Second); ; time.Sleep(10 * time.Millisecond) {','\t\twait := 120 * time.Second\n\t\tif f.secrets != nil { wait = 300 * time.Second }\n\t\tfor deadline := time.Now().Add(wait); ; time.Sleep(10 * time.Millisecond) {',1)
s=s.replace('\tswitch r.URL.Path {','\tswitch r.URL.Path {\n\tcase shieldSecretsPath:\n\t\tf.serveShieldSecrets(w, r)\n\t\treturn',1)
(root/p).write_text(s)
# Production's measured-config tests are additive.
files=subprocess.check_output(['git','-C','work/enclave','diff','--name-only','--diff-filter=A','HEAD','refs/remotes/lineage/shield-production','--','isolation/contract'],text=True).splitlines()
for p in files:
 if p.endswith('_test.go') and not (root/p).exists(): (root/p).write_text(prod(p))
