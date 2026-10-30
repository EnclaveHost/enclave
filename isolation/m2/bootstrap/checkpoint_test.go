package bootstrap

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"strings"
	"sync"
	"testing"
	"time"
)

// A synthetic AMD-shaped Genoa chain (the real pins are swapped for its root in these tests only): ARK and ASK RSA-4096
// with RSA-PSS SHA-384, a P-384 VCEK carrying AMD's SPL and hardware-ID extensions, an ARK-signed CRL, and reports
// laid out and signed as the PSP does (AMD 56860 Table 27). Generated once: RSA-4096 keys are slow.
type synthAMD struct {
	ark, ask         *x509.Certificate
	arkKey, askKey   *rsa.PrivateKey
	vcek             *x509.Certificate
	vcekKey          *ecdsa.PrivateKey
	chip             []byte
	tcb              [8]byte // bootloader, tee, 0, 0, 0, 0, snp, microcode
	notBefore, notAt time.Time
}

var (
	synthOnce sync.Once
	synth     *synthAMD
)

func pssSign(key *rsa.PrivateKey) crypto.Signer { return key }

func newSynthAMD(t testing.TB) *synthAMD {
	synthOnce.Do(func() { synth = makeSynthAMD(time.Now().Add(-24*time.Hour), time.Now().Add(365*24*time.Hour)) })
	sum := sha256.Sum256(synth.ark.Raw)
	old := amdArkSHA256["Genoa"]
	amdArkSHA256["Genoa"] = hex.EncodeToString(sum[:])
	t.Cleanup(func() { amdArkSHA256["Genoa"] = old })
	return synth
}

// makeSynthAMD: a fresh synthetic chain whose certificates hold from notBefore to notAt.
func makeSynthAMD(notBefore, notAt time.Time) *synthAMD {
	var s *synthAMD
	func() {
		s = &synthAMD{chip: bytes.Repeat([]byte{0xc7}, 64), tcb: [8]byte{10, 0, 0, 0, 0, 0, 23, 84}, notBefore: notBefore, notAt: notAt}
		var err error
		if s.arkKey, err = rsa.GenerateKey(rand.Reader, 4096); err != nil {
			panic(err)
		}
		if s.askKey, err = rsa.GenerateKey(rand.Reader, 4096); err != nil {
			panic(err)
		}
		if s.vcekKey, err = ecdsa.GenerateKey(elliptic.P384(), rand.Reader); err != nil {
			panic(err)
		}
		ca := func(cn string, serial int64) *x509.Certificate {
			return &x509.Certificate{SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: cn}, NotBefore: s.notBefore, NotAfter: s.notAt,
				IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign, SignatureAlgorithm: x509.SHA384WithRSAPSS}
		}
		arkT := ca("ARK-Genoa", 1)
		der, err := x509.CreateCertificate(rand.Reader, arkT, arkT, &s.arkKey.PublicKey, s.arkKey)
		if err != nil {
			panic(err)
		}
		s.ark, _ = x509.ParseCertificate(der)
		askT := ca("SEV-Genoa", 2)
		der, _ = x509.CreateCertificate(rand.Reader, askT, s.ark, &s.askKey.PublicKey, s.arkKey)
		s.ask, _ = x509.ParseCertificate(der)
		s.vcek = s.issueVCEK(s.vcekKey, s.tcb, s.chip, s.notAt)
	}()
	return s
}

func intExt(sub []int, v int) pkix.Extension {
	b, _ := asn1.Marshal(v)
	return pkix.Extension{Id: append(append(asn1.ObjectIdentifier{}, oidAMD...), sub...), Value: b}
}

func (s *synthAMD) issueVCEK(key *ecdsa.PrivateKey, tcb [8]byte, chip []byte, notAfter time.Time) *x509.Certificate {
	hw, _ := asn1.Marshal(chip)
	ext := []pkix.Extension{intExt([]int{3, 1}, int(tcb[0])), intExt([]int{3, 2}, int(tcb[1])), intExt([]int{3, 3}, int(tcb[6])), intExt([]int{3, 8}, int(tcb[7])),
		{Id: append(append(asn1.ObjectIdentifier{}, oidAMD...), 4), Value: hw}}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(3), Subject: pkix.Name{CommonName: "SEV-VCEK"}, NotBefore: s.notBefore, NotAfter: notAfter,
		ExtraExtensions: ext, SignatureAlgorithm: x509.SHA384WithRSAPSS}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, s.ask, &key.PublicKey, s.askKey)
	if err != nil {
		panic(err)
	}
	c, _ := x509.ParseCertificate(der)
	return c
}

func (s *synthAMD) crl(t testing.TB, revoke []*big.Int, this, next time.Time, signer *rsa.PrivateKey) []byte {
	var entries []x509.RevocationListEntry
	for _, n := range revoke {
		entries = append(entries, x509.RevocationListEntry{SerialNumber: n, RevocationTime: this})
	}
	der, err := x509.CreateRevocationList(rand.Reader, &x509.RevocationList{Number: big.NewInt(1), ThisUpdate: this, NextUpdate: next,
		RevokedCertificateEntries: entries, SignatureAlgorithm: x509.SHA384WithRSAPSS}, s.ark, signer)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

// auxblob: the extended report's certificate table for vcek, ask and ark.
func auxblob(vcek, ask, ark []byte) []byte {
	ents := []struct {
		guid string
		der  []byte
	}{{guidVCEK, vcek}, {guidASK, ask}, {guidARK, ark}}
	off := uint32(24 * (len(ents) + 1))
	var tab, data []byte
	for _, e := range ents {
		g, _ := hex.DecodeString(e.guid)
		var w [8]byte
		binary.LittleEndian.PutUint32(w[:4], off+uint32(len(data)))
		binary.LittleEndian.PutUint32(w[4:], uint32(len(e.der)))
		tab = append(append(tab, g...), w[:]...)
		data = append(data, e.der...)
	}
	return append(append(tab, make([]byte, 24)...), data...)
}

type reportFields struct {
	version            uint32
	policy             uint64
	vmpl, signer       uint32
	reportData         [64]byte
	measurement        [48]byte
	hostData           [32]byte
	reported, committd [8]byte
	fam, mod           byte
	chip               []byte
}

func (s *synthAMD) fields(rd [64]byte, measurement [48]byte, host [32]byte) reportFields {
	return reportFields{version: 5, policy: 1<<17 | 1<<16, reportData: rd, measurement: measurement, hostData: host, reported: s.tcb, committd: s.tcb, fam: 0x19, mod: 0x11, chip: s.chip}
}

func (s *synthAMD) report(f reportFields, key *ecdsa.PrivateKey) []byte {
	r := make([]byte, snpReportSize)
	binary.LittleEndian.PutUint32(r[0:], f.version)
	binary.LittleEndian.PutUint64(r[8:], f.policy)
	binary.LittleEndian.PutUint32(r[0x30:], f.vmpl)
	binary.LittleEndian.PutUint32(r[0x34:], 1)
	binary.LittleEndian.PutUint32(r[0x48:], f.signer)
	copy(r[0x50:], f.reportData[:])
	copy(r[0x90:], f.measurement[:])
	copy(r[0xc0:], f.hostData[:])
	copy(r[0x180:], f.reported[:])
	r[0x188], r[0x189] = f.fam, f.mod
	copy(r[0x1a0:], f.chip)
	copy(r[0x1e0:], f.committd[:])
	h := sha512.Sum384(r[:snpSigOffset])
	rr, ss, err := ecdsa.Sign(rand.Reader, key, h[:])
	if err != nil {
		panic(err)
	}
	le := func(n *big.Int) []byte {
		b := n.FillBytes(make([]byte, 48))
		for i, j := 0, len(b)-1; i < j; i, j = i+1, j-1 {
			b[i], b[j] = b[j], b[i]
		}
		return b
	}
	copy(r[snpSigOffset:], le(rr))
	copy(r[snpSigOffset+0x48:], le(ss))
	return r
}

func (s *synthAMD) freshCRL(t testing.TB) []byte {
	return s.crl(t, nil, time.Now().Add(-time.Hour), time.Now().Add(24*time.Hour), s.arkKey)
}

func (s *synthAMD) policy(rd [64]byte, m [48]byte, host [32]byte) snpPolicy {
	return snpPolicy{Product: "Genoa", MinTCB: decodeTCB("Genoa", s.tcb[:]), Measurements: [][]byte{m[:]}, HostData: host[:], ReportData: rd[:], Now: time.Now()}
}

func TestSNPEvidenceAcceptsGenuineAndRefusesEveryBrokenCheck(t *testing.T) {
	s := newSynthAMD(t)
	var rd [64]byte
	copy(rd[:], bytes.Repeat([]byte{0x5e}, 32))
	m, host := [48]byte{1, 2, 3}, [32]byte{0x11, 0x22}
	aux, crl := auxblob(s.vcek.Raw, s.ask.Raw, s.ark.Raw), s.freshCRL(t)
	good := s.fields(rd, m, host)
	if e := verifySNPEvidence(s.report(good, s.vcekKey), aux, crl, s.policy(rd, m, host)); e != nil {
		t.Fatalf("genuine evidence refused: %v", e)
	}
	otherKey, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	mut := func(f func(*reportFields)) []byte { g := good; f(&g); return s.report(g, s.vcekKey) }
	tamper := s.report(good, s.vcekKey)
	tamper[0x91] ^= 1
	lowTCB := s.policy(rd, m, host)
	lowTCB.MinTCB = map[string]int{"bootloader": 10, "tee": 0, "snp": 24, "microcode": 84}
	cases := []struct {
		name, want       string
		report, aux, crl []byte
		pol              *snpPolicy
	}{
		{"debug allowed", "DEBUG", mut(func(f *reportFields) { f.policy |= 1 << 19 }), aux, crl, nil},
		{"MIGRATE_MA allowed", "MIGRATE_MA", mut(func(f *reportFields) { f.policy |= 1 << 18 }), aux, crl, nil},
		{"VMPL1", "VMPL1", mut(func(f *reportFields) { f.vmpl = 1 }), aux, crl, nil},
		{"report version 6", "judged range", mut(func(f *reportFields) { f.version = 6 }), aux, crl, nil},
		{"report version 2 (no CPUID)", "product line", mut(func(f *reportFields) { f.version = 2; f.fam, f.mod = 0, 0 }), aux, crl, nil},
		{"VLEK signer", "VLEK", mut(func(f *reportFields) { f.signer = 1 << 2 }), aux, crl, nil},
		{"Milan CPUID", "product line", mut(func(f *reportFields) { f.mod = 0x01 }), aux, crl, nil},
		{"tampered byte", "signature", tamper, aux, crl, nil},
		{"signed by another key", "signature", s.report(good, otherKey), aux, crl, nil},
		{"VCEK of another TCB", "vcek identity", mut(func(f *reportFields) { f.reported[6], f.committd[6] = 24, 24 }), aux, crl, nil},
		{"VCEK of another chip", "vcek identity", mut(func(f *reportFields) { f.chip = bytes.Repeat([]byte{0xc8}, 64) }), aux, crl, nil},
		{"TCB below the floor", "tcb policy", s.report(good, s.vcekKey), aux, crl, &lowTCB},
		{"committed TCB below the floor", "committed", mut(func(f *reportFields) { f.committd[6] = 22 }), aux, crl, nil},
		{"another measurement", "measurement", mut(func(f *reportFields) { f.measurement[0] = 9 }), aux, crl, nil},
		{"another statement", "binding", mut(func(f *reportFields) { f.reportData[0] ^= 1 }), aux, crl, nil},
		{"another deployment", "host data", mut(func(f *reportFields) { f.hostData[0] = 0x12 }), aux, crl, nil},
		{"no ASK in the table", "collateral", s.report(good, s.vcekKey), auxblob(s.vcek.Raw, nil, s.ark.Raw), crl, nil},
		{"an unpinned root", "pinned", s.report(good, s.vcekKey), auxblob(s.vcek.Raw, s.ask.Raw, s.ask.Raw), crl, nil},
		{"no CRL", "CRL", s.report(good, s.vcekKey), aux, nil, nil},
		{"stale CRL", "stale", s.report(good, s.vcekKey), aux, s.crl(t, nil, time.Now().Add(-48*time.Hour), time.Now().Add(-time.Hour), s.arkKey), nil},
		{"ASK revoked", "REVOKED", s.report(good, s.vcekKey), aux, s.crl(t, []*big.Int{s.ask.SerialNumber}, time.Now().Add(-time.Hour), time.Now().Add(24*time.Hour), s.arkKey), nil},
		{"CRL signature broken", "CRL", s.report(good, s.vcekKey), aux, func() []byte {
			c := s.freshCRL(t)
			c[len(c)-5] ^= 1 // inside the signature
			return c
		}(), nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pol := s.policy(rd, m, host)
			if c.pol != nil {
				pol = *c.pol
			}
			e := verifySNPEvidence(c.report, c.aux, c.crl, pol)
			if e == nil || !strings.Contains(e.Error(), c.want) {
				t.Fatalf("want a refusal mentioning %q, got %v", c.want, e)
			}
		})
	}
	// an expired VCEK
	expired := s.issueVCEK(s.vcekKey, s.tcb, s.chip, time.Now().Add(-time.Minute))
	if e := verifySNPEvidence(s.report(good, s.vcekKey), auxblob(expired.Raw, s.ask.Raw, s.ark.Raw), crl, s.policy(rd, m, host)); e == nil || !strings.Contains(e.Error(), "not valid") {
		t.Fatalf("an expired VCEK: %v", e)
	}
	// the real pins refuse the synthetic root
	amdArkSHA256["Genoa"] = "4c6598d19c18719c5dfd4a7d335f674e5bfe1d8f800cea2cf270c10d103db2f1"
	if e := verifySNPEvidence(s.report(good, s.vcekKey), aux, crl, s.policy(rd, m, host)); e == nil || !strings.Contains(e.Error(), "pinned") {
		t.Fatalf("the real AMD pin accepted a synthetic root: %v", e)
	}
}

// A checkpoint from one guest's verified coverage, adopted by another guest of the same build for the same deployment.
func TestCheckpointRoundTripAndEveryBinding(t *testing.T) {
	s := newSynthAMD(t)
	from := leaseFromBlock
	leaseFromBlock = 1
	defer func() { leaseFromBlock = from }()
	id := [32]byte{0x0d, 0xe9}
	idHex := "0x" + hex.EncodeToString(id[:])
	measurement := [48]byte{0xab, 0xcd}
	mk := func() *Reader {
		return &Reader{chainID: 8453, ledger: "0x" + strings.Repeat("ab", 20), now: time.Now}
	}
	claim := leaseLog{block: 120, index: 3, blockHash: "0x" + strings.Repeat("44", 32), topics: []string{topicClaimed, idHex, "0x" + strings.Repeat("22", 32), "0x" + strings.Repeat("0", 24) + strings.Repeat("33", 20)}, data: "0x" + strings.Repeat("0", 128)}
	renew := leaseLog{block: 900, index: 0, blockHash: "0x" + strings.Repeat("55", 32), topics: []string{topicRenewed, idHex, "0x" + strings.Repeat("22", 32)}, data: "0x" + strings.Repeat("0", 128)}
	producer := mk()
	producer.keep(id, coverage{120, 5000, []leaseLog{claim, renew}})
	stmt, err := producer.CheckpointStatement(id)
	if err != nil {
		t.Fatal(err)
	}
	evidence := func(st []byte, f func(*reportFields)) []byte {
		g := s.fields(CheckpointReportData(st), measurement, id)
		if f != nil {
			f(&g)
		}
		cp, err := EncodeCheckpoint(st, s.report(g, s.vcekKey), auxblob(s.vcek.Raw, s.ask.Raw, s.ark.Raw), s.freshCRL(t))
		if err != nil {
			t.Fatal(err)
		}
		return cp
	}
	own := s.report(s.fields([64]byte{}, measurement, id), s.vcekKey) // the consumer's own report: same build, same chip TCB
	consumer := mk()
	if consumer.AdoptCheckpoint(id, evidence(stmt, nil)) == nil {
		t.Fatal("adopted without an own report")
	}
	if e := consumer.TrustCheckpointsFrom(own); e != nil {
		t.Fatal(e)
	}
	if e := consumer.AdoptCheckpoint(id, evidence(stmt, nil)); e != nil {
		t.Fatalf("a genuine checkpoint refused: %v", e)
	}
	if consumer.seedFromCheckpoint(id, 4999, 6000, uint64(time.Now().Unix())) != 0 {
		t.Fatal("seeded past this guest's finalized view")
	}
	if hi := consumer.seedFromCheckpoint(id, 5000, 6000, uint64(time.Now().Unix())); hi != 5000 {
		t.Fatalf("not seeded at its finalized hi: %d", hi)
	}
	if cov, ok := consumer.coverage(id); !ok || cov.lo != 120 || cov.hi != 5000 || len(cov.logs) != 2 {
		t.Fatalf("coverage %+v", cov)
	}
	// every binding refuses
	var st checkpointStatement
	json.Unmarshal(stmt, &st)
	alter := func(f func(*checkpointStatement)) []byte {
		c := st
		c.Logs = append([]checkpointLog(nil), st.Logs...)
		f(&c)
		b, _ := json.Marshal(c)
		return b
	}
	dropped := alter(func(c *checkpointStatement) { c.Logs = c.Logs[:1] })
	otherDep := alter(func(c *checkpointStatement) { c.Deployment = "0x" + strings.Repeat("99", 32) })
	// the same content with "v" moved last: valid JSON, not the canonical form
	reordered := []byte(`{` + strings.TrimPrefix(string(stmt), `{"v":1,`)[:len(stmt)-len(`{"v":1,`)-1] + `,"v":1}`)
	var swapped Checkpoint
	json.Unmarshal(evidence(stmt, nil), &swapped)
	swapped.Statement = dropped // the producer's evidence, another statement
	swappedRaw, _ := json.Marshal(swapped)
	higher := s.report(s.fields([64]byte{}, measurement, id), s.vcekKey)
	binary.LittleEndian.PutUint32(higher[0:], 5)
	for _, c := range []struct {
		name, want string
		raw        []byte
		id         [32]byte
	}{
		{"a log dropped, evidence redone over it by another image", "measurement", evidence(dropped, func(f *reportFields) { f.measurement[0] ^= 1 }), id},
		{"the producer's evidence over another statement", "binding", swappedRaw, id},
		{"another deployment's statement", "deployment", evidence(otherDep, nil), id},
		{"another deployment's HOST_DATA", "host data", evidence(stmt, func(f *reportFields) { f.hostData[0] ^= 1 }), id},
		{"the statement for another id", "deployment", evidence(stmt, nil), [32]byte{0x77}},
		{"a non-canonical statement", "canonical", func() []byte {
			var c Checkpoint
			json.Unmarshal(evidence(stmt, nil), &c)
			r, _ := json.Marshal(map[string]any{"statement": json.RawMessage(reordered), "report": c.Report, "certs": c.Certs, "crl": c.CRL})
			return r
		}(), id},
		{"a producer below this guest's TCB", "tcb policy", evidence(stmt, func(f *reportFields) { f.committd[7] = 83 }), id},
	} {
		t.Run(c.name, func(t *testing.T) {
			r := mk()
			r.TrustCheckpointsFrom(own)
			if e := r.AdoptCheckpoint(c.id, c.raw); e == nil || !strings.Contains(e.Error(), c.want) {
				t.Fatalf("want a refusal mentioning %q, got %v", c.want, e)
			}
		})
	}
	_ = higher
}
