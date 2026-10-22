from pathlib import Path
r=Path('work/shield-lineage-integration/isolation/m2')
p=r/'egress/policy.go';s=p.read_text();mark='// derive builds the allowlist'
helper='''// FromShieldBootstrap derives Shield egress from the same verified owner package used
// for custody. Public-web is selected by committed bytes, never by secret substitution.
func FromShieldBootstrap(auth *bootstrap.Authorization, secrets map[string]string) (*Policy, error) {
 text, err := auth.ConfigText()
 if err != nil { return nil, err }
 mode, err := auth.SecretsMode()
 if err != nil { return nil, err }
 if mode == "public" && len(secrets) != 0 { return nil, errors.New("public startup cannot receive secret values") }
 resolved, err := appconfig.Resolve(text, secrets)
 if err != nil { return nil, err }
 p, err := derivePolicy(resolved, nil, true)
 if err != nil { return nil, err }
 p.PublicWeb = shieldconfig.PublicWebMode(text)
 return p, nil
}

''';s=s.replace(mark,helper+mark,1);p.write_text(s)
p=r/'front/shield_egress.go';s=p.read_text().replace('"enclave.host/isolation/contract"','"enclave.host/isolation/contract"\n"enclave.host/isolation/m2/bootstrap"')
mark='\t// The monitor marked the domain public-web'
s=s.replace(mark,'\treturn e.startPolicy(pol)\n}\n\nfunc (e *shieldEgress) startDirect(auth *bootstrap.Authorization, secrets map[string]string) (*egress.Forwarder, error) {\n\tcfg, err := readMeasuredConfig(e.config, e.configUID)\n\tif err != nil { return nil, egressStepError{"config"} }\n\tcommitted, err := auth.ConfigText()\n\tif err != nil || cfg != committed { return nil, egressStepError{"owner config binding"} }\n\tpol, err := egress.FromShieldBootstrap(auth, secrets)\n\tif err != nil { return nil, egressStepError{"allowlist"} }\n\treturn e.startPolicy(pol)\n}\n\nfunc (e *shieldEgress) startPolicy(pol *egress.Policy) (*egress.Forwarder, error) {\n\tvar err error\n'+mark,1);p.write_text(s)
p=r/'front/shield_direct.go';s=p.read_text().replace('"enclave.host/isolation/m2/egress"','"enclave.host/isolation/m2/egress"\n"enclave.host/isolation/m2/release"')
s=s.replace('authorize func(ctx context.Context, roots *x509.CertPool, id [32]byte, raw []byte, loaded bootstrap.Identity) (shieldAuthority, error)','authorize func(ctx context.Context, roots *x509.CertPool, id [32]byte, raw []byte, loaded bootstrap.Identity) (shieldAuthority, error)\n prepare func(context.Context, shieldAuthority, [32]byte, *x509.CertPool) (*ownerStartup, error)')
s=s.replace('func (f *front) shieldDirectOwner(ctx context.Context) error {','func (f *front) shieldDirectOwner(ctx context.Context, pipe io.WriteCloser, egConfig *shieldEgress) error {\n if pipe != nil { defer pipe.Close() }')
s=s.replace('egressPort, _, packagePort := directPorts()','egressPort, custodyPort, packagePort := directPorts()')
s=s.replace('return f.shieldOwner(ctx, shieldDeps{packages: dial(packagePort), egress: eg, roots: bootstrap.MeasuredRoots,','return f.shieldOwner(ctx, shieldDeps{packages: dial(packagePort), egress: eg, roots: bootstrap.MeasuredRoots,\n prepare: func(ctx context.Context, a shieldAuthority, id [32]byte, roots *x509.CertPool) (*ownerStartup, error) {\n auth, ok := a.(*bootstrap.Authorization)\n if !ok { return nil, errors.New("Shield startup requires verified bootstrap authority") }\n p := &provisioner{egress: eg, custodyAuth: dial(custodyPort), roots: roots, logf: func(format string, args ...any) { fmt.Printf(format+"\\n", args...) }}\n return f.prepareShieldDirect(ctx, auth, id, pipe, egConfig, p)\n },')
old='''if mode != "public" {
		return fmt.Errorf("its package keeps secrets in %s, which is not released to an Enclave Shield partition yet: the app is not run without its values", mode)
	}
	if f.names, err = f.startOwnerNames(&ownerStartup{auth: auth}, d.egress, roots); err != nil {'''
new='''startup := &ownerStartup{auth: auth}
 if d.prepare != nil {
  startup, err = d.prepare(ctx, auth, id, roots)
  if err != nil { return err }
 } else if mode != "public" {
  return fmt.Errorf("its package keeps secrets in %s, but no custody startup channel was configured", mode)
 }
 if f.names, err = f.startOwnerNames(startup, d.egress, roots); err != nil {'''
assert old in s;s=s.replace(old,new)
# release imported by separate new file, not this one.
s=s.replace('\n"enclave.host/isolation/m2/release"','')
p.write_text(s)
p=r/'front/shield_direct_off.go';s=p.read_text().replace('import "context"','import ("context"; "io")').replace('shieldDirectOwner(context.Context) error','shieldDirectOwner(context.Context, io.WriteCloser, *shieldEgress) error');p.write_text(s)
p=r/'front/main.go';s=p.read_text()
a=s.index('\t// An Enclave Shield partition');b=s.index('\ttl := tls.NewListener',a)
old=s[a:b]
# Keep legacy domain watching; configure secret pipe first, select compile-time startup below.
block=''' var shieldPipe io.WriteCloser
 var shieldEG *shieldEgress
 if *shieldSecretsFD != 0 {
  if *shieldSecretsFD != 7 || f.monitor == "" || f.rt == nil { die("invalid Shield secret channel") }
  shieldPipe = os.NewFile(uintptr(*shieldSecretsFD), "shield-secret-pipe")
  egressPort := uint32(EgressPort)
  if directBootstrap { egressPort, _, _ = directPorts() }
  shieldEG = &shieldEgress{config: "/app.config", configUID: 0, hosts: "/etc/hosts", port: 443,
   upstream: func() (net.Conn, error) { return vsock.Dial(vsock.CIDHost, egressPort) },
   audit: func(want []netip.AddrPort) error { return auditListeners("/proc/net", want) },
   logf: func(format string, a ...any) { fmt.Printf(format+"\\n", a...) },
   publicWebMarker: shieldconfig.PublicWebMarker}
  if !directBootstrap { f.secrets, err = newShieldSecrets(shieldPipe, "/secret.id", shieldEG); must(err) }
 }
 // The direct Shield build obtains custody itself, through the owner-committed package.
 // Other builds retain their existing startup path; no runtime request changes this choice.
 if *initFD == 0 && f.monitor != "" && hdErr != nil {
  if err := f.shieldDirectOwner(context.Background(), shieldPipe, shieldEG); err != nil { die("shield startup: %v", err) }
 }
 if !directBootstrap && *initFD > 0 && f.certs.name != "" && len(hd) == 32 && !isZero(hd) {
  go f.certs.watchDomains(context.Background(), "0x"+hex.EncodeToString(hd))
 }
'''
s=s[:a]+block+s[b:]
# main already uses io for other functions, confirm compiler below.
p.write_text(s)
