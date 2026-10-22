from pathlib import Path
r=Path('work/shield-lineage-integration/isolation/m2/front')
p=r/'main.go';s=p.read_text().replace('"enclave.host/isolation/m2/domtls"','"enclave.host/isolation/m2/domtls"\n"enclave.host/isolation/m2/egress"').replace('type front struct {','type front struct {\n shieldFwd *egress.Forwarder // direct Shield egress lives until the domain exits');p.write_text(s)
p=r/'shield_direct_custody.go';s=p.read_text().replace('\tkeep = true','\tf.shieldFwd = fwd\n\tkeep = true').replace('"io"','"io"\n"strings"').replace('self, err := f.selfTest(wx)','if !strings.HasPrefix(wx, "wx=clean ") {return nil, errors.New("Shield custody requires a fresh clean runtime scan")}\n self, err := f.selfTest(wx)');p.write_text(s)
p=r/'shield_direct_off.go';s=p.read_text().replace('"io"','"io"\n"errors"').replace('func (f *front) shieldDirectOwner(context.Context, io.WriteCloser, *shieldEgress) error { return nil }','func (f *front) shieldDirectOwner(_ context.Context, pipe io.WriteCloser, _ *shieldEgress) error {\n if directBootstrap && pipe != nil {pipe.Close(); return errors.New("this direct build does not support Shield secret startup")}\n return nil\n}');p.write_text(s)
p=r/'custody_test.go';s=p.read_text().replace('type custodyWorldV2 struct {','type custodyWorldV2 struct {\n shieldOwner string // optional Shield evidence fixture; report bytes stand in for a monitor, never hardware proof')
s=s.replace('Format, Abi, TransportKey, Report string','Format, Abi, TransportKey, Report, Tier, AppSha256 string\n Nonce *string')
start='\t\trep, _ := base64.StdEncoding.DecodeString(req.Evidence.Report)\n'
addition='''        evidenceOK := len(rep) >= 0xe0 && bytes.Equal(rep[0x50:0x70], bind[:]) && bytes.Equal(rep[0x70:0x90], w.appSha) && bytes.Equal(rep[0xc0:0xe0], w.id[:]) && req.Evidence.Format == contract.FormatSNP
        if w.shieldOwner != "" {
          input, e := custody.ShieldReleaseInput(bind, w.shieldOwner)
          evidenceOK = e == nil && len(rep)==64 && bytes.Equal(rep[:32], input[:]) && bytes.Equal(rep[32:], w.appSha) && req.Evidence.Format == contract.FormatHyperV && req.Evidence.Tier == contract.TierHyperV && req.Evidence.AppSha256 == hex.EncodeToString(w.appSha) && req.Evidence.Nonce == nil
        }
'''
# exact later occurrence only; use location within custodianV2
idx=s.index(start,s.index('func (w *custodyWorldV2) custodianV2'))+len(start);s=s[:idx]+addition+s[idx:]
old='''len(rep) < 0xe0 || !bytes.Equal(rep[0x50:0x70], bind[:]) || !bytes.Equal(rep[0x70:0x90], w.appSha) ||
			!bytes.Equal(rep[0xc0:0xe0], w.id[:]) || req.Evidence.Format != contract.FormatSNP || req.Evidence.Abi != contract.ABI2 ||'''
assert old in s;s=s.replace(old,'!evidenceOK || req.Evidence.Abi != contract.ABI2 ||',1)
p.write_text(s)
