package bootstrap

// AMD SEV-SNP evidence for history checkpoints (checkpoint.go; work/history-owner-tools-interface.txt section 6): a port
// of verifier/snp.mjs and the relay/snp-verify.mjs primitives it uses, check for check and in the same order, standard
// library only. Layout: AMD 56860 (SEV-SNP Firmware ABI) Table 27 ATTESTATION_REPORT, Tables 4/5 TCB_VERSION, Table 148
// signature; AMD 57230 VCEK extensions 1.3.6.1.4.1.3704.1.*. Only report versions 2..5 are judged (as the JS verifier);
// only VCEK-signed reports (AMD's public roots); the ASK must be on a FRESH ARK-signed CRL (policy "required"); the
// reported AND committed TCB must meet the floor; DEBUG and MIGRATE_MA off; VMPL0; an explicit measurement, HOST_DATA
// and REPORT_DATA. Anything else is a refusal: there is no "limited" verdict here.

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/asn1"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"time"
)

const (
	snpReportSize      = 0x4a0
	snpSigOffset       = 0x2a0
	snpJudgedMaxReport = 5
)

// amdArkSHA256: AMD's ARK per product line, pinned by the sha256 of its DER (relay/snp-verify.mjs AMD_ARK_SHA256, the
// relay's and the buyer verifier's pins). A variable only so tests can pin a synthetic root.
var amdArkSHA256 = map[string]string{
	"Milan": "69d063b45344d26a2e94e1f4210de49ef555308287d4c174445c95639a540bcd",
	"Genoa": "4c6598d19c18719c5dfd4a7d335f674e5bfe1d8f800cea2cf270c10d103db2f1",
	"Turin": "1f084161a44bb6d93778a904877d4819cafa5d05ef4193b2ded9dd9c73dd3f6a",
}

// GUIDs of the extended report's certificate table (AMD 56860 Table 23 / configfs-tsm auxblob).
const (
	guidVCEK = "63da758de6644564adc5f4b93be8accd"
	guidASK  = "4ab7b379bbac4fe4a02f05aef327c782"
	guidARK  = "c0b406a4a803495297433fb6014cd0ae"
)

var p384N, _ = new(big.Int).SetString("ffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973", 16)

type snpReport struct {
	raw                                     []byte
	version, vmpl, signatureAlgo, signerInf uint32
	policy                                  uint64
	reportData                              []byte // 64
	measurement                             []byte // 48
	hostData                                []byte // 32
	reportedTCB, committedTCB               []byte // 8 each
	cpuidFam, cpuidMod                      byte
	chipID                                  []byte // 64
}

func parseSNPReport(r []byte) (*snpReport, error) {
	if len(r) != snpReportSize {
		return nil, fmt.Errorf("report is %d bytes; the ABI fixes ATTESTATION_REPORT at %d", len(r), snpReportSize)
	}
	u32 := func(o int) uint32 { return binary.LittleEndian.Uint32(r[o:]) }
	p := &snpReport{raw: r, version: u32(0), policy: binary.LittleEndian.Uint64(r[8:]), vmpl: u32(0x30), signatureAlgo: u32(0x34),
		signerInf: u32(0x48), reportData: r[0x50:0x90], measurement: r[0x90:0xc0], hostData: r[0xc0:0xe0],
		reportedTCB: r[0x180:0x188], cpuidFam: r[0x188], cpuidMod: r[0x189], chipID: r[0x1a0:0x1e0], committedTCB: r[0x1e0:0x1e8]}
	if p.version < 2 {
		return nil, fmt.Errorf("report version %d < 2", p.version)
	}
	if p.version > snpJudgedMaxReport {
		return nil, fmt.Errorf("report version %d is outside the judged range 2..%d (its extended TCB fields are not implemented)", p.version, snpJudgedMaxReport)
	}
	if p.policy&(1<<17) == 0 {
		return nil, errors.New("guest policy reserved bit 17 is not 1")
	}
	if p.policy>>26 != 0 {
		return nil, errors.New("guest policy bits 63:26 are not zero")
	}
	if p.signatureAlgo != 1 {
		return nil, fmt.Errorf("signature algorithm %d is not ECDSA P-384 with SHA-384 (1)", p.signatureAlgo)
	}
	if p.signerInf>>5 != 0 {
		return nil, errors.New("signer_info bits 31:5 are not zero")
	}
	if key := (p.signerInf >> 2) & 7; key != 0 {
		return nil, fmt.Errorf("report signed by key type %d (1 = VLEK, 7 = none); only VCEK-signed reports chain to AMD's public roots", key)
	}
	mbz := func(lo, hi int, what string) error {
		for i := lo; i < hi; i++ {
			if r[i] != 0 {
				return fmt.Errorf("reserved bytes (%s) are not zero", what)
			}
		}
		return nil
	}
	after := 0x188
	if p.version >= 3 {
		after = 0x18b
	}
	for _, c := range []struct {
		lo, hi int
		what   string
	}{{0x4c, 0x50, "0x4c..0x50"}, {after, 0x1a0, "after CPUID"}, {0x1eb, 0x1ec, "0x1eb"}, {0x1ef, 0x1f0, "0x1ef"}, {0x208, snpSigOffset, "0x208..0x2a0"},
		{snpSigOffset + 0x30, snpSigOffset + 0x48, "signature R zero-extension"}, {snpSigOffset + 0x78, snpSigOffset + 0x90, "signature S zero-extension"},
		{snpSigOffset + 0x90, snpReportSize, "signature tail"}} {
		if e := mbz(c.lo, c.hi, c.what); e != nil {
			return nil, e
		}
	}
	return p, nil
}

func (p *snpReport) debug() bool     { return p.policy&(1<<19) != 0 }
func (p *snpReport) migrateMA() bool { return p.policy&(1<<18) != 0 }

// snpProduct: the product line from the report's CPUID (versions 3+); version 2 carries none and is refused here.
func snpProduct(p *snpReport) (string, error) {
	if p.version < 3 {
		return "", errors.New("report version 2 carries no CPUID: the product line is unknown")
	}
	f, m := p.cpuidFam, p.cpuidMod
	switch {
	case f == 0x19 && m < 0x10:
		return "Milan", nil
	case f == 0x19 && (m >= 0x10 && m < 0x20 || m >= 0xa0 && m < 0xb0):
		return "Genoa", nil
	case f == 0x1a && m < 0x20:
		return "Turin", nil
	}
	return "", fmt.Errorf("CPUID family 0x%x model 0x%x is not a known product line", f, m)
}

var tcbFields = map[string][]string{
	"Milan": {"bootloader", "tee", "snp", "microcode"},
	"Genoa": {"bootloader", "tee", "snp", "microcode"},
	"Turin": {"fmc", "bootloader", "tee", "snp", "microcode"},
}

func decodeTCB(product string, b []byte) map[string]int {
	if product == "Turin" {
		return map[string]int{"fmc": int(b[0]), "bootloader": int(b[1]), "tee": int(b[2]), "snp": int(b[3]), "microcode": int(b[7])}
	}
	return map[string]int{"bootloader": int(b[0]), "tee": int(b[1]), "snp": int(b[6]), "microcode": int(b[7])}
}

// certFromAuxblob: the entry for guid in an extended report's certificate table ({guid(16), offset(4), length(4)}*,
// zero-terminated).
func certFromAuxblob(aux []byte, guid string) []byte {
	if len(aux) > 64*1024 {
		return nil
	}
	for o := 0; o+24 <= len(aux); o += 24 {
		g := hex.EncodeToString(aux[o : o+16])
		if g == strings32zero {
			break
		}
		off, n := binary.LittleEndian.Uint32(aux[o+16:]), binary.LittleEndian.Uint32(aux[o+20:])
		if g == guid {
			if n == 0 || uint64(off)+uint64(n) > uint64(len(aux)) {
				return nil
			}
			return aux[off : off+n]
		}
	}
	return nil
}

const strings32zero = "00000000000000000000000000000000"

// checkAMDChain: VCEK -> ASK -> ARK, the ARK pinned by sha256 for the product, every subject as AMD issues it, every
// certificate valid now, ARK and ASK RSA-4096, the ARK self-signed, the ASK signed by it, the VCEK signed by the ASK.
func checkAMDChain(vcekDER, askDER, arkDER []byte, product string, now time.Time) (vcek, ask, ark *x509.Certificate, err error) {
	want, ok := amdArkSHA256[product]
	if !ok {
		return nil, nil, nil, fmt.Errorf("no pinned AMD root for product line %q (fail closed)", product)
	}
	if ark, err = x509.ParseCertificate(arkDER); err != nil {
		return nil, nil, nil, fmt.Errorf("ARK unparseable: %v", err)
	}
	if ask, err = x509.ParseCertificate(askDER); err != nil {
		return nil, nil, nil, fmt.Errorf("ASK unparseable: %v", err)
	}
	if vcek, err = x509.ParseCertificate(vcekDER); err != nil {
		return nil, nil, nil, fmt.Errorf("VCEK unparseable: %v", err)
	}
	if fp := sha256.Sum256(ark.Raw); hex.EncodeToString(fp[:]) != want {
		return nil, nil, nil, fmt.Errorf("the served ARK is not AMD's pinned %s root", product)
	}
	if ark.Subject.CommonName != "ARK-"+product || ask.Subject.CommonName != "SEV-"+product || vcek.Subject.CommonName != "SEV-VCEK" || vcek.Issuer.CommonName != "SEV-"+product {
		return nil, nil, nil, fmt.Errorf("AMD chain subjects are not ARK-%[1]s / SEV-%[1]s / SEV-VCEK", product)
	}
	for _, c := range []struct {
		c    *x509.Certificate
		what string
	}{{ark, "ARK"}, {ask, "ASK"}, {vcek, "VCEK"}} {
		if now.Before(c.c.NotBefore) || now.After(c.c.NotAfter) {
			return nil, nil, nil, fmt.Errorf("%s certificate is not valid at %s", c.what, now.UTC().Format(time.RFC3339))
		}
	}
	for _, c := range []*x509.Certificate{ark, ask} {
		if k, ok := c.PublicKey.(*rsa.PublicKey); !ok || k.N.BitLen() != 4096 {
			return nil, nil, nil, errors.New("ARK and ASK keys must be RSA-4096")
		}
	}
	if e := ark.CheckSignature(ark.SignatureAlgorithm, ark.RawTBSCertificate, ark.Signature); e != nil {
		return nil, nil, nil, errors.New("ARK is not self-signed")
	}
	if !bytes.Equal(ask.RawIssuer, ark.RawSubject) || ark.CheckSignature(ask.SignatureAlgorithm, ask.RawTBSCertificate, ask.Signature) != nil {
		return nil, nil, nil, errors.New("ASK is not signed by the ARK")
	}
	if !bytes.Equal(vcek.RawIssuer, ask.RawSubject) || ask.CheckSignature(vcek.SignatureAlgorithm, vcek.RawTBSCertificate, vcek.Signature) != nil {
		return nil, nil, nil, errors.New("VCEK is not signed by the ASK")
	}
	return vcek, ask, ark, nil
}

// checkAMDCRL: the ARK-signed CRL (RSASSA-PSS), issued by the pinned ARK, not from the future, NOT stale (policy
// "required": no stale-ok here), and the ASK's serial not revoked.
func checkAMDCRL(crlDER []byte, ask, ark *x509.Certificate, now time.Time) (*x509.RevocationList, error) {
	if len(crlDER) == 0 {
		return nil, errors.New("CRL: required but none was supplied")
	}
	crl, err := x509.ParseRevocationList(crlDER)
	if err != nil {
		return nil, fmt.Errorf("CRL unparseable: %v", err)
	}
	if crl.SignatureAlgorithm != x509.SHA384WithRSAPSS {
		return nil, fmt.Errorf("CRL signature algorithm %v is not RSASSA-PSS SHA-384", crl.SignatureAlgorithm)
	}
	if !bytes.Equal(crl.RawIssuer, ark.RawSubject) {
		return nil, errors.New("CRL issuer is not the pinned ARK")
	}
	if ark.CheckSignature(crl.SignatureAlgorithm, crl.RawTBSRevocationList, crl.Signature) != nil {
		return nil, errors.New("CRL signature does not verify with the pinned ARK")
	}
	if now.Before(crl.ThisUpdate) {
		return nil, errors.New("CRL thisUpdate is in the future")
	}
	if crl.NextUpdate.IsZero() || now.After(crl.NextUpdate) {
		return nil, fmt.Errorf("CRL is stale (nextUpdate %s)", crl.NextUpdate.UTC().Format(time.RFC3339))
	}
	for _, e := range crl.RevokedCertificateEntries {
		if e.SerialNumber.Cmp(ask.SerialNumber) == 0 {
			return nil, fmt.Errorf("the ASK (serial %x) is REVOKED", ask.SerialNumber)
		}
	}
	return crl, nil
}

func verifySNPSignature(p *snpReport, vcek *x509.Certificate) error {
	pub, ok := vcek.PublicKey.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P384() {
		return errors.New("VCEK public key is not EC P-384")
	}
	rev := func(b []byte) []byte {
		o := make([]byte, len(b))
		for i := range b {
			o[i] = b[len(b)-1-i]
		}
		return o
	}
	sig := p.raw[snpSigOffset:]
	r, s := new(big.Int).SetBytes(rev(sig[0:48])), new(big.Int).SetBytes(rev(sig[0x48:0x48+48]))
	if r.Sign() == 0 || r.Cmp(p384N) >= 0 || s.Sign() == 0 || s.Cmp(p384N) >= 0 {
		return errors.New("signature r or s is out of range for P-384")
	}
	h := sha512.Sum384(p.raw[:snpSigOffset])
	if !ecdsa.Verify(pub, h[:], r, s) {
		return errors.New("VCEK signature over the report is invalid")
	}
	return nil
}

var (
	oidAMD    = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 3704, 1}
	splSuffix = map[string]int{"bootloader": 1, "tee": 2, "snp": 3, "microcode": 8, "fmc": 9}
)

func amdExt(c *x509.Certificate, sub ...int) []byte {
	want := append(append(asn1.ObjectIdentifier{}, oidAMD...), sub...)
	for _, e := range c.Extensions {
		if e.Id.Equal(want) {
			return e.Value
		}
	}
	return nil
}

// vcekMatchesReport: a VCEK is issued for ONE chip at ONE TCB; its extensions must name the report's chip and REPORTED
// TCB exactly. Missing extensions are a mismatch.
func vcekMatchesReport(vcek *x509.Certificate, product string, p *snpReport) error {
	want := decodeTCB(product, p.reportedTCB)
	for _, f := range tcbFields[product] {
		raw := amdExt(vcek, 3, splSuffix[f])
		if raw == nil {
			return fmt.Errorf("VCEK has no %s SPL extension", f)
		}
		var v int
		if rest, e := asn1.Unmarshal(raw, &v); e != nil || len(rest) != 0 || v != want[f] {
			return fmt.Errorf("VCEK %s SPL does not match the report's reported TCB %d", f, want[f])
		}
	}
	hwLen := 64
	if product == "Turin" {
		hwLen = 8
	}
	hw := amdExt(vcek, 4)
	if hw == nil {
		return errors.New("VCEK has no hardware-ID extension")
	}
	if len(hw) != hwLen {
		var inner []byte
		if rest, e := asn1.Unmarshal(hw, &inner); e == nil && len(rest) == 0 {
			hw = inner
		}
	}
	if len(hw) != hwLen || !bytes.Equal(hw, p.chipID[:hwLen]) {
		return errors.New("VCEK hardware ID does not match the report's CHIP_ID")
	}
	return nil
}

// snpPolicy: everything a checkpoint's evidence must satisfy, explicit (no defaults that relax a check).
type snpPolicy struct {
	Product      string         // the product line the evidence must be from (the verifying guest's own)
	MinTCB       map[string]int // every field of tcbFields[Product]; applied to the reported AND committed TCB
	Measurements [][]byte       // allowed launch measurements (48 bytes each); empty refuses
	HostData     []byte         // 32 bytes, non-zero: the deployment id
	ReportData   []byte         // 64 bytes: the statement binding
	Now          time.Time
}

// verifySNPEvidence: report + its certificate table + an ARK-signed CRL under pol. nil only when every check passed.
func verifySNPEvidence(report, auxblob, crlDER []byte, pol snpPolicy) error {
	_, err := checkSNPEvidence(report, auxblob, crlDER, pol)
	return err
}

// snpWindow: when the evidence's collateral holds: the latest NotBefore/thisUpdate to the earliest NotAfter/nextUpdate
// of the VCEK, ASK, ARK and the CRL. A consumer re-judges it at the chain's own time before using the evidence.
type snpWindow struct{ from, until time.Time }

func (w snpWindow) holds(t time.Time) bool { return !t.Before(w.from) && !t.After(w.until) }

// checkSNPEvidence: verifySNPEvidence, and the window its collateral was valid in.
func checkSNPEvidence(report, auxblob, crlDER []byte, pol snpPolicy) (snpWindow, error) {
	var win snpWindow
	p, err := parseSNPReport(report)
	if err != nil {
		return win, fmt.Errorf("report shape: %v", err)
	}
	product, err := snpProduct(p)
	if err != nil {
		return win, fmt.Errorf("product line: %v", err)
	}
	if product != pol.Product {
		return win, fmt.Errorf("product line: the report is from %s, the policy requires %s", product, pol.Product)
	}
	if p.debug() {
		return win, errors.New("guest policy allows DEBUG: the host can read guest memory")
	}
	if p.migrateMA() {
		return win, errors.New("guest policy allows MIGRATE_MA")
	}
	if p.vmpl != 0 {
		return win, fmt.Errorf("report is from VMPL%d, policy expects VMPL0", p.vmpl)
	}
	vcekDER, askDER, arkDER := certFromAuxblob(auxblob, guidVCEK), certFromAuxblob(auxblob, guidASK), certFromAuxblob(auxblob, guidARK)
	if vcekDER == nil || askDER == nil || arkDER == nil {
		return win, errors.New("collateral: the certificate table lacks the VCEK, ASK or ARK")
	}
	vcek, ask, ark, err := checkAMDChain(vcekDER, askDER, arkDER, product, pol.Now)
	if err != nil {
		return win, fmt.Errorf("chain: %v", err)
	}
	crl, err := checkAMDCRL(crlDER, ask, ark, pol.Now)
	if err != nil {
		return win, err
	}
	if err = verifySNPSignature(p, vcek); err != nil {
		return win, fmt.Errorf("signature: %v", err)
	}
	if err = vcekMatchesReport(vcek, product, p); err != nil {
		return win, fmt.Errorf("vcek identity: %v", err)
	}
	fields := tcbFields[product]
	if len(pol.MinTCB) != len(fields) {
		return win, errors.New("tcb policy: the floor must name every TCB field of the product line")
	}
	for _, which := range []struct {
		b    []byte
		what string
	}{{p.reportedTCB, "reported"}, {p.committedTCB, "committed"}} {
		got := decodeTCB(product, which.b)
		for _, f := range fields {
			floor, ok := pol.MinTCB[f]
			if !ok {
				return win, fmt.Errorf("tcb policy: no floor for %s", f)
			}
			if got[f] < floor {
				return win, fmt.Errorf("tcb policy: %s TCB %s %d < %d", which.what, f, got[f], floor)
			}
		}
	}
	allowed := false
	for _, m := range pol.Measurements {
		if len(m) == 48 && bytes.Equal(m, p.measurement) {
			allowed = true
		}
	}
	if !allowed {
		return win, errors.New("measurement: the launch measurement is not an allowed one")
	}
	if len(pol.ReportData) != 64 || !bytes.Equal(p.reportData, pol.ReportData) {
		return win, errors.New("binding: REPORT_DATA is not this statement's binding")
	}
	if len(pol.HostData) != 32 || allZero(pol.HostData) || !bytes.Equal(p.hostData, pol.HostData) {
		return win, errors.New("host data: HOST_DATA is not the expected deployment")
	}
	win = snpWindow{crl.ThisUpdate, crl.NextUpdate}
	for _, c := range []*x509.Certificate{vcek, ask, ark} {
		if c.NotBefore.After(win.from) {
			win.from = c.NotBefore
		}
		if c.NotAfter.Before(win.until) {
			win.until = c.NotAfter
		}
	}
	return win, nil
}

func allZero(b []byte) bool {
	for _, x := range b {
		if x != 0 {
			return false
		}
	}
	return true
}
