from pathlib import Path
import subprocess
root=Path('work/shield-lineage-integration')
def prod(p): return subprocess.check_output(['git','-C','work/enclave','show','refs/remotes/lineage/shield-production:'+p],text=True)
def edit(p,fn):
 f=root/p; f.write_text(fn(f.read_text()))
p='isolation/m2/egress/dialer.go'
# Entire delta inspected: retains public-address guards and adds explicit per-app routes/host narrowing.
(root/p).write_text(prod(p))
p='isolation/m2/egress/policy.go'
s=(root/p).read_text().replace('"enclave.host/isolation/m2/release"','"enclave.host/isolation/m2/release"\n\t"enclave.host/isolation/m2/shieldconfig"')
s=s.replace('type Policy struct {','type Policy struct {\n\tPublicWeb bool // Shield measured config explicitly permits public TCP; never inferred from secrets')
ps=prod(p); helper=ps[ps.index('// ForShield is'):ps.index('// derive builds')].replace('deriveFrom(resolved, nil)','derivePolicy(resolved, nil, true)')
s=s.replace('// derive builds',helper+'// derive builds',1)
s=s.replace('func deriveOrigins(resolvedConfig string, pinned []Origin) (*Policy, error) {','func deriveOrigins(resolvedConfig string, pinned []Origin) (*Policy, error) {\n\treturn derivePolicy(resolvedConfig, pinned, false)\n}\n\n// Shield transport modes preserve its configured-origin behavior. SNP public-https\n// remains an explicit grant of arbitrary public DNS origins on port 443.\nfunc derivePolicy(resolvedConfig string, pinned []Origin, shield bool) (*Policy, error) {')
s=s.replace('if obj, ok := doc.(map[string]any); ok && obj["egress"] != nil {','obj, _ := doc.(map[string]any)\n\t\tmode, _ := obj["egress"].(string)\n\t\tif obj["egress"] != nil && !(shield && (mode == "public-https" || mode == "public-web")) {')
(root/p).write_text(s)
p='isolation/m2/egress/forward.go';s=(root/p).read_text()
s=s.replace('PublicListen string // test override; empty uses PublicSOCKSAddress','PublicListen string // test override; empty uses PublicSOCKSAddress\n\tDNSListen string // Shield public-web DNS stub; empty uses PublicDNSAddress')
s=s.replace('func (f *Forwarder) Start(ctx context.Context) error {','func (f *Forwarder) Start(ctx context.Context) error {\n\tif f.Policy == nil || (f.Policy.PublicHTTPS && f.Policy.PublicWeb) {\n\t\treturn errors.New("egress requires one unambiguous policy")\n\t}')
s=s.replace('\tgo func() { <-ctx.Done(); f.Close() }()','\tif f.Policy.PublicWeb {\n\t\tif err := f.startPublicWeb(ctx); err != nil {\n\t\t\tf.Close()\n\t\t\treturn err\n\t\t}\n\t}\n\tgo func() { <-ctx.Done(); f.Close() }()',1)
ps=prod(p); helper=ps[ps.index('func (f *Forwarder) track'):ps.index('// Addr is')];s=s.replace('// Addr is',helper+'// Addr is',1)
s=s.replace('\tf := strings.Fields(line)\n','\tf := strings.Fields(line)\n\tif len(f) == 3 && (f[0] == webProto || f[0] == dnsProto) {\n\t\ts.handleWeb(ctx, cid, g, br, f)\n\t\treturn\n\t}\n',1)
(root/p).write_text(s)
edit('isolation/m2/egress/web.go',lambda s:s.replace('\tPublicSOCKSAddress = "127.0.0.2:1080"\n','').replace('publicConnect','publicWebConnect'))
