package bootstrap

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"os"
	"strings"
	"testing"
	"time"
)

// testdata/checkpoint-vectors.json: attested checkpoints over a SYNTHETIC AMD-shaped chain (certificates valid 2026-01-01
// to 2099-01-01, judged at 2026-10-20), which the guest (AdoptCheckpoint, here) and the owner's tools
// (verifier/history-checkpoint.mjs, site/js/core/history-checkpoint.js; test/history-checkpoint-transport.test.mjs) must
// accept or refuse identically. Written once by WRITE_CHECKPOINT_VECTORS=1 (random keys, so not reproducible byte for
// byte; the file's sha256 is recorded with the delivery), then read by both.

type checkpointVectors struct {
	Generator   string `json:"generator"`
	Now         string `json:"now"`
	ArkSHA256   string `json:"arkSha256"`
	ChainID     uint64 `json:"chainId"`
	Ledger      string `json:"ledger"`
	Deployment  string `json:"deployment"`
	Measurement string `json:"measurement"`
	OwnReport   string `json:"ownReport"`
	KDS         struct {
		VCEK  string `json:"vcek"`
		Chain string `json:"chain"`
		CRL   string `json:"crl"`
	} `json:"kds"`
	Cases []struct {
		Name     string `json:"name"`
		Envelope string `json:"envelope"`
		Valid    bool   `json:"valid"`
		Why      string `json:"why"`     // what the guest's refusal says (a substring)
		Bare     bool   `json:"bare"`    // no certificates and no CRL: the tools complete them from the KDS double
		JSWhy    string `json:"jsWhy"`   // the tools' wording where the order of checks differs
		Refresh  bool   `json:"refresh"` // stale CRL: valid once the tools' refresh-crl replaced it
	} `json:"cases"`
}

var vectorsNow = time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)

func TestWriteCheckpointVectors(t *testing.T) {
	if os.Getenv("WRITE_CHECKPOINT_VECTORS") != "1" {
		t.Skip("writes testdata/checkpoint-vectors.json when WRITE_CHECKPOINT_VECTORS=1")
	}
	s := makeSynthAMD(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC))
	from := leaseFromBlock
	leaseFromBlock = 1
	defer func() { leaseFromBlock = from }()
	id := [32]byte{0x0d, 0xe9, 0x01}
	idHex := "0x" + hex.EncodeToString(id[:])
	ledger := "0x" + strings.Repeat("ab", 20)
	m, otherM := [48]byte{0xab, 0xcd}, [48]byte{0xab, 0xce}
	claim := leaseLog{block: 120, index: 3, blockHash: "0x" + strings.Repeat("44", 32), topics: []string{topicClaimed, idHex, "0x" + strings.Repeat("22", 32), "0x" + strings.Repeat("0", 24) + strings.Repeat("33", 20)}, data: "0x" + strings.Repeat("0", 128)}
	renew := leaseLog{block: 900, index: 0, blockHash: "0x" + strings.Repeat("55", 32), topics: []string{topicRenewed, idHex, "0x" + strings.Repeat("22", 32)}, data: "0x" + strings.Repeat("0", 128)}
	day := 24 * time.Hour
	fresh := s.crl(t, nil, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC), s.arkKey)
	stale := s.crl(t, nil, vectorsNow.Add(-60*day), vectorsNow.Add(-30*day), s.arkKey)
	revoked := s.crl(t, []*big.Int{s.ask.SerialNumber}, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC), s.arkKey)
	aux := auxblob(s.vcek.Raw, s.ask.Raw, s.ark.Raw)
	statement := func(dep string, logs []leaseLog) []byte {
		r := &Reader{chainID: 8453, ledger: ledger, now: time.Now}
		var d [32]byte
		b, _ := hex.DecodeString(strings.TrimPrefix(dep, "0x"))
		copy(d[:], b)
		r.keep(d, coverage{120, 5000, logs})
		st, err := r.CheckpointStatement(d)
		if err != nil {
			t.Fatal(err)
		}
		return st
	}
	env := func(st []byte, f func(*reportFields), certs, crl []byte) string {
		g := s.fields(CheckpointReportData(st), m, id)
		if f != nil {
			f(&g)
		}
		b, err := EncodeCheckpoint(st, s.report(g, s.vcekKey), certs, crl)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	st := statement(idHex, []leaseLog{claim, renew})
	var good Checkpoint
	json.Unmarshal([]byte(env(st, nil, aux, fresh)), &good)
	var stv checkpointStatement
	json.Unmarshal(st, &stv)
	dropped := stv
	dropped.Logs = stv.Logs[:1]
	droppedSt, _ := json.Marshal(dropped)
	swap := good
	swap.Statement = droppedSt
	swapped, _ := json.Marshal(swap)
	otherDep := "0x" + strings.Repeat("77", 32)
	oc := claim
	oc.topics = []string{topicClaimed, otherDep, claim.topics[2], claim.topics[3]}
	var oid [32]byte
	copy(oid[:], bytes.Repeat([]byte{0x77}, 32))
	otherSt := statement(otherDep, []leaseLog{oc})
	otherEnv := func() string {
		b, _ := EncodeCheckpoint(otherSt, s.report(s.fields(CheckpointReportData(otherSt), m, oid), s.vcekKey), aux, fresh)
		return string(b)
	}()
	pretty := func() string { // the same envelope re-indented: the statement is no longer its canonical bytes
		var v any
		json.Unmarshal([]byte(env(st, nil, aux, fresh)), &v)
		b, _ := json.MarshalIndent(v, "", "  ")
		return string(b)
	}()
	g := env(st, nil, aux, fresh)
	var v checkpointVectors
	v.Generator, v.Now, v.ChainID, v.Ledger, v.Deployment = "WRITE_CHECKPOINT_VECTORS=1 go test -run TestWriteCheckpointVectors ./bootstrap", vectorsNow.Format(time.RFC3339), 8453, ledger, idHex
	sum := sha256.Sum256(s.ark.Raw)
	v.ArkSHA256, v.Measurement = hex.EncodeToString(sum[:]), hex.EncodeToString(m[:])
	v.OwnReport = base64.StdEncoding.EncodeToString(s.report(s.fields([64]byte{}, m, id), s.vcekKey))
	v.KDS.VCEK = base64.StdEncoding.EncodeToString(s.vcek.Raw)
	v.KDS.Chain = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: s.ask.Raw})) + string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: s.ark.Raw}))
	v.KDS.CRL = base64.StdEncoding.EncodeToString(fresh)
	add := func(name, envelope string, valid bool, why string) {
		v.Cases = append(v.Cases, struct {
			Name     string `json:"name"`
			Envelope string `json:"envelope"`
			Valid    bool   `json:"valid"`
			Why      string `json:"why"`
			Bare     bool   `json:"bare"`
			JSWhy    string `json:"jsWhy"`
			Refresh  bool   `json:"refresh"`
		}{Name: name, Envelope: envelope, Valid: valid, Why: why})
	}
	add("genuine", g, true, "")
	add("as the producer serves it: no certificates, no CRL", env(st, nil, nil, nil), false, "collateral")
	v.Cases[len(v.Cases)-1].Bare = true
	add("stale CRL", env(st, nil, aux, stale), false, "CRL is stale")
	v.Cases[len(v.Cases)-1].Refresh = true
	add("ASK revoked", env(st, nil, aux, revoked), false, "REVOKED")
	add("a log dropped after signing", string(swapped), false, "binding")
	add("another deployment's genuine checkpoint", otherEnv, false, "another chain, ledger or deployment")
	add("another build", env(st, func(f *reportFields) { f.measurement = otherM }, aux, fresh), false, "measurement")
	add("DEBUG allowed", env(st, func(f *reportFields) { f.policy |= 1 << 19 }, aux, fresh), false, "DEBUG")
	add("VMPL1", env(st, func(f *reportFields) { f.vmpl = 1 }, aux, fresh), false, "VMPL1")
	add("committed TCB below", env(st, func(f *reportFields) { f.committd[6] = 22 }, aux, fresh), false, "committed")
	add("HOST_DATA of another deployment", env(st, func(f *reportFields) { f.hostData = oid }, aux, fresh), false, "host data")
	add("re-indented (not canonical)", pretty, false, "canonical")
	add("unknown member", strings.Replace(g, `{"statement":`, `{"note":"x","statement":`, 1), false, "unknown member")
	add("duplicate member", strings.Replace(g, `,"report":`, `,"certs":"","report":`, 1), false, "not an unambiguous JSON object")
	add("not JSON", "<html>", false, "not an unambiguous JSON object")
	b, _ := json.MarshalIndent(v, "", " ")
	if err := os.WriteFile("testdata/checkpoint-vectors.json", append(b, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %d checkpoint vectors", len(v.Cases))
}

// The guest's verdict on every vector (the tools' are in test/history-checkpoint-transport.test.mjs).
func TestCheckpointVectorsAgreeWithJavaScript(t *testing.T) {
	b, err := os.ReadFile("testdata/checkpoint-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v checkpointVectors
	if err = json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Cases) < 15 {
		t.Fatalf("only %d vectors", len(v.Cases))
	}
	old := amdArkSHA256["Genoa"]
	amdArkSHA256["Genoa"] = v.ArkSHA256
	defer func() { amdArkSHA256["Genoa"] = old }()
	from := leaseFromBlock
	leaseFromBlock = 1
	defer func() { leaseFromBlock = from }()
	var id [32]byte
	ib, _ := hex.DecodeString(strings.TrimPrefix(v.Deployment, "0x"))
	copy(id[:], ib)
	own, _ := base64.StdEncoding.DecodeString(v.OwnReport)
	now, _ := time.Parse(time.RFC3339, v.Now)
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			r := &Reader{chainID: v.ChainID, ledger: v.Ledger, now: func() time.Time { return now }}
			if e := r.TrustCheckpointsFrom(own); e != nil {
				t.Fatal(e)
			}
			e := r.AdoptCheckpoint(id, []byte(c.Envelope))
			if c.Valid != (e == nil) || !c.Valid && !strings.Contains(e.Error(), c.Why) {
				t.Fatalf("valid=%v why %q: %v", c.Valid, c.Why, e)
			}
		})
	}
	// the real AMD pin refuses the synthetic root
	amdArkSHA256["Genoa"] = old
	r := &Reader{chainID: v.ChainID, ledger: v.Ledger, now: func() time.Time { return now }}
	r.TrustCheckpointsFrom(own)
	if e := r.AdoptCheckpoint(id, []byte(v.Cases[0].Envelope)); e == nil || !strings.Contains(e.Error(), "pinned") {
		t.Fatalf("the real AMD pin accepted the synthetic root: %v", e)
	}
}
