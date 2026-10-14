package custody_test

import (
	"bytes"
	"crypto/ecdh"
	"encoding/hex"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"

	"enclave.host/isolation/m2/custody"
	"enclave.host/isolation/m2/custody/v2member"
)

type v2Vectors struct {
	ChainID     uint64 `json:"chainId"`
	Vault       string `json:"vault"`
	ID          string `json:"id"`
	CommitteeID string `json:"committeeId"`
	SecretRev   uint64 `json:"secretRev"`
	PolicyRev   uint64 `json:"policyRev"`
	Epoch       uint32 `json:"epoch"`
	Seats       struct {
		Machines []bool     `json:"machines"`
		N        int        `json:"n"`
		T        int        `json:"t"`
		W        int        `json:"W"`
		Indices  [][]uint32 `json:"indices"`
	} `json:"seats"`
	Commitments  []string          `json:"commitments"`
	Y            string            `json:"Y"`
	Label        string            `json:"label"`
	ConfigSha256 string            `json:"configSha256"`
	Env          map[string]string `json:"env"`
	Bundle       string            `json:"bundle"`
	Challenges   []struct {
		EncKey string `json:"encKey"`
		Nonce  string `json:"nonce"`
	} `json:"challenges"`
	ChallengeRoot    string   `json:"challengeRoot"`
	RuntimeID        string   `json:"runtimeId"`
	TransportSpki    string   `json:"transportSpki"`
	RecipientPrivate string   `json:"recipientPrivate"`
	RecipientKey     string   `json:"recipientKey"`
	Binding          string   `json:"binding"`
	Partials         []string `json:"partials"`
	PartialIndices   []uint32 `json:"partialIndices"`
	SealedPartial    struct {
		MemberEncKey string `json:"memberEncKey"`
		Count        int    `json:"count"`
		Sealed       string `json:"sealed"`
		Record       string `json:"record"`
	} `json:"sealedPartial"`
	S         string `json:"S"`
	Decrypted struct {
		Env          map[string]string `json:"env"`
		ConfigSha256 string            `json:"configSha256"`
	} `json:"decrypted"`
	SeatCases []struct {
		Machines []bool     `json:"machines"`
		N        int        `json:"n"`
		T        int        `json:"t"`
		W        int        `json:"W"`
		Indices  [][]uint32 `json:"indices"`
	} `json:"seatCases"`
}

func h(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(strings.TrimPrefix(s, "0x"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func h32(t *testing.T, s string) (o [32]byte) {
	t.Helper()
	b := h(t, s)
	if len(b) != 32 {
		t.Fatalf("%s: not 32 bytes", s)
	}
	copy(o[:], b)
	return
}

type v2Fixture struct {
	v           v2Vectors
	ctx         custody.Context
	id, cid     [32]byte
	label       [32]byte
	binding     [32]byte
	commitments [][]byte
	R           []byte
	sk          *ecdh.PrivateKey
	challenges  []custody.Challenge
}

func loadV2(t *testing.T) *v2Fixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/v2-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	f := &v2Fixture{}
	if err := json.Unmarshal(raw, &f.v); err != nil {
		t.Fatal(err)
	}
	f.ctx = custody.Context{ChainID: f.v.ChainID}
	copy(f.ctx.Vault[:], h(t, f.v.Vault))
	f.id, f.cid = h32(t, f.v.ID), h32(t, f.v.CommitteeID)
	f.label, f.binding = h32(t, f.v.Label), h32(t, f.v.Binding)
	for _, c := range f.v.Commitments {
		f.commitments = append(f.commitments, h(t, c))
	}
	f.R = h(t, f.v.Bundle)[:33]
	if f.sk, err = ecdh.X25519().NewPrivateKey(h(t, f.v.RecipientPrivate)); err != nil {
		t.Fatal(err)
	}
	for _, c := range f.v.Challenges {
		f.challenges = append(f.challenges, custody.Challenge{EncKey: h32(t, c.EncKey), Nonce: h32(t, c.Nonce)})
	}
	return f
}

func (f *v2Fixture) bindingInput(t *testing.T) custody.BindingInputV2 {
	return custody.BindingInputV2{Ctx: f.ctx, ID: f.id, PolicyRev: f.v.PolicyRev, SecretRev: f.v.SecretRev, CommitteeID: f.cid, Epoch: f.v.Epoch,
		Challenges: f.challenges, RuntimeID: h32(t, f.v.RuntimeID), TransportSPKI: h(t, f.v.TransportSpki), RecipientKey: h32(t, f.v.RecipientKey)}
}

func TestV2VectorsFromTheJSReference(t *testing.T) {
	f := loadV2(t)
	v := f.v

	// seats
	l, err := custody.SeatLayout(v.Seats.Machines)
	if err != nil || l.N != v.Seats.N || l.T != v.Seats.T || l.W != v.Seats.W || !reflect.DeepEqual(l.Indices, v.Seats.Indices) {
		t.Fatalf("seats: %+v %v", l, err)
	}
	for _, c := range v.SeatCases {
		l, err := custody.SeatLayout(c.Machines)
		if err != nil || l.N != c.N || l.T != c.T || l.W != c.W || !reflect.DeepEqual(l.Indices, c.Indices) {
			t.Fatalf("seat case %v: %+v %v", c.Machines, l, err)
		}
	}
	if v.Commitments[0] != v.Y {
		t.Fatal("the vectors' Y is not C0")
	}

	// label, challenge root, binding
	if got := custody.LabelOf(custody.LabelInput{Ctx: f.ctx, ID: f.id, SecretRev: v.SecretRev, CommitteeID: f.cid}); got != f.label {
		t.Fatalf("label %x", got)
	}
	if got, err := custody.ChallengeRootV2(f.challenges); err != nil || hex.EncodeToString(got[:]) != v.ChallengeRoot {
		t.Fatalf("challenge root %x %v", got, err)
	}
	// order does not matter
	rev := []custody.Challenge{f.challenges[1], f.challenges[0]}
	if got, _ := custody.ChallengeRootV2(rev); hex.EncodeToString(got[:]) != v.ChallengeRoot {
		t.Fatal("the challenge root depends on order")
	}
	if got := hex.EncodeToString(f.sk.PublicKey().Bytes()); got != v.RecipientKey {
		t.Fatalf("recipient key %s", got)
	}
	if got, err := custody.BindingV2(f.bindingInput(t)); err != nil || got != f.binding {
		t.Fatalf("binding %x %v", got, err)
	}

	// the bundle's label proof
	bundle := h(t, v.Bundle)
	if !custody.VerifyLabelProof(bundle, f.label) {
		t.Fatal("the vector bundle's label proof does not verify")
	}
	other := f.label
	other[0] ^= 1
	if custody.VerifyLabelProof(bundle, other) {
		t.Fatal("the label proof verified under another label")
	}

	// partial verification
	var ps []custody.Partial
	R, err := custody.PointOf(f.R, "R")
	if err != nil {
		t.Fatal(err)
	}
	for i, rec := range v.Partials {
		p, err := custody.VerifyPartial(h(t, rec), R, f.binding, f.commitments)
		if err != nil || p.K != v.PartialIndices[i] {
			t.Fatalf("partial %d: %+v %v", i, p, err)
		}
		ps = append(ps, p)
	}

	// the sealed partial opens under the recipient key to the record
	sp := v.SealedPartial
	recs, err := custody.OpenPartials(f.sk, f.binding, h32(t, sp.MemberEncKey), sp.Count, h(t, sp.Sealed))
	if err != nil || len(recs) != 1 || hex.EncodeToString(recs[0]) != sp.Record || sp.Record != v.Partials[1] {
		t.Fatalf("sealed partial: %v", err)
	}
	// and the Go seal with the vectors' ephemeral key reproduces the JS bytes
	resealed, err := v2member.Seal(f.sk.PublicKey(), f.binding, h32(t, sp.MemberEncKey), [][]byte{h(t, sp.Record)}, bytes.Repeat([]byte{0x44}, 32))
	if err != nil || hex.EncodeToString(resealed) != sp.Sealed {
		t.Fatalf("reseal: %v", err)
	}

	// combine and decrypt
	S, err := custody.Combine(ps, v.Seats.T)
	if err != nil {
		t.Fatal(err)
	}
	if sb, _ := custody.PointBytesOf(S); hex.EncodeToString(sb) != v.S {
		t.Fatalf("S %x", sb)
	}
	b, err := custody.DecryptBundleV2(S, f.label, bundle)
	if err != nil || !reflect.DeepEqual(b.Env, v.Decrypted.Env) || b.ConfigSha256 != v.Decrypted.ConfigSha256 || !reflect.DeepEqual(b.Env, v.Env) {
		t.Fatalf("decrypt: %+v %v", b, err)
	}

	// the Go owner/member halves reproduce the JS bytes from the same deterministic inputs (they back the fake committees)
	com := v2member.NewCommittee(2, v2member.Scalar(bytes.Repeat([]byte{0x5a}, 32)), v2member.Scalar(bytes.Repeat([]byte{0x17}, 32)))
	for j, c := range com.Commitments {
		if hex.EncodeToString(c) != v.Commitments[j] {
			t.Fatalf("commitment %d", j)
		}
	}
	re, err := v2member.EncryptBundle(com.Y(), f.label, v.Env, v.ConfigSha256, v2member.Scalar(bytes.Repeat([]byte{0xa1}, 32)),
		v2member.Scalar(bytes.Repeat([]byte{0xb2}, 32)), h(t, "00112233445566778899aabb"))
	if err != nil || hex.EncodeToString(re) != v.Bundle {
		t.Fatalf("bundle: %v", err)
	}
	for i, k := range v.PartialIndices {
		u := v2member.Scalar(bytes.Repeat([]byte{map[uint32]byte{1: 0xc1, 3: 0xc3}[k]}, 32))
		rec, err := v2member.Partial(k, com.Share(k), f.R, f.binding, com.Commitments, u)
		if err != nil || hex.EncodeToString(rec) != v.Partials[i] {
			t.Fatalf("partial %d: %v", k, err)
		}
	}
	// any 2 of the 3 indices give the same S
	var p2 custody.Partial
	rec2, _ := v2member.Partial(2, com.Share(2), f.R, f.binding, com.Commitments, nil)
	if p2, err = custody.VerifyPartial(rec2, R, f.binding, f.commitments); err != nil {
		t.Fatal(err)
	}
	for _, set := range [][]custody.Partial{{ps[0], p2}, {p2, ps[1]}, {ps[1], ps[0]}} {
		S2, err := custody.Combine(set, 2)
		if sb, _ := custody.PointBytesOf(S2); err != nil || hex.EncodeToString(sb) != v.S {
			t.Fatalf("subset %d,%d: %v", set[0].K, set[1].K, err)
		}
	}
}

func TestV2Negatives(t *testing.T) {
	f := loadV2(t)
	v := f.v
	R, _ := custody.PointOf(f.R, "R")
	rec := h(t, v.Partials[0])
	ok := func(r []byte, R []byte, binding [32]byte, cs [][]byte) error {
		Rp, err := custody.PointOf(R, "R")
		if err != nil {
			return err
		}
		_, err = custody.VerifyPartial(r, Rp, binding, cs)
		return err
	}
	if err := ok(rec, f.R, f.binding, f.commitments); err != nil {
		t.Fatal(err)
	}
	mut := func(i int, x byte) []byte { r := append([]byte(nil), rec...); r[i] ^= x; return r }
	// tampered D, c, z
	for _, i := range []int{10, 40, 80, 100} {
		if err := ok(mut(i, 1), f.R, f.binding, f.commitments); err == nil {
			t.Fatalf("a partial tampered at byte %d verified", i)
		}
	}
	// wrong binding
	wb := f.binding
	wb[31] ^= 1
	if err := ok(rec, f.R, wb, f.commitments); err == nil {
		t.Fatal("a partial verified under another binding")
	}
	// wrong index: the same proof claimed for index 2
	wi := append([]byte(nil), rec...)
	wi[3] = 2
	if err := ok(wi, f.R, f.binding, f.commitments); err == nil {
		t.Fatal("a partial verified under another index")
	}
	for _, k := range []byte{0, 200} {
		bad := append([]byte(nil), rec...)
		bad[3] = k
		if err := ok(bad, f.R, f.binding, f.commitments); err == nil {
			t.Fatalf("index %d accepted", k)
		}
	}
	// wrong R (another bundle)
	otherR, _ := custody.PointBytesOf(f.commitmentPoint(t, 1))
	if err := ok(rec, otherR, f.binding, f.commitments); err == nil {
		t.Fatal("a partial verified for another R")
	}
	// out-of-range and zero scalars, a non-point D, a short record
	q := h(t, "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141")
	for _, off := range []int{37, 69} {
		over := append([]byte(nil), rec...)
		copy(over[off:off+32], q)
		if err := ok(over, f.R, f.binding, f.commitments); err == nil || !strings.Contains(err.Error(), "out of range") {
			t.Fatalf("scalar q at %d: %v", off, err)
		}
		zero := append([]byte(nil), rec...)
		copy(zero[off:off+32], make([]byte, 32))
		if err := ok(zero, f.R, f.binding, f.commitments); err == nil {
			t.Fatalf("a zero scalar at %d verified", off)
		}
	}
	notPoint := append([]byte(nil), rec...)
	notPoint[4] = 0x04
	if err := ok(notPoint, f.R, f.binding, f.commitments); err == nil {
		t.Fatal("a D with a bad prefix verified")
	}
	if _, err := custody.VerifyPartial(rec[:100], R, f.binding, f.commitments); err == nil {
		t.Fatal("a short record verified")
	}
	// identity / off-curve encodings never parse
	for _, b := range [][]byte{make([]byte, 33), append([]byte{0x02}, make([]byte, 32)...), append([]byte{0x02}, bytes.Repeat([]byte{0xff}, 32)...)} {
		if _, err := custody.PointOf(b, "p"); err == nil {
			t.Fatalf("%x parsed as a point", b)
		}
	}

	// combine: too few, too many, duplicate indices
	p1, _ := custody.VerifyPartial(h(t, v.Partials[0]), R, f.binding, f.commitments)
	p3, _ := custody.VerifyPartial(h(t, v.Partials[1]), R, f.binding, f.commitments)
	for _, set := range [][]custody.Partial{{p1}, {p1, p1}, {p1, p3, p3}, nil} {
		if _, err := custody.Combine(set, 2); err == nil {
			t.Fatalf("combined %d partials", len(set))
		}
	}
	S, _ := custody.Combine([]custody.Partial{p1, p3}, 2)
	bundle := h(t, v.Bundle)
	// wrong label
	wl := f.label
	wl[0] ^= 1
	if _, err := custody.DecryptBundleV2(S, wl, bundle); err == nil {
		t.Fatal("decrypted under another label")
	}
	// wrong S (combined as if t were 1)
	S1, _ := custody.Combine([]custody.Partial{p1}, 1)
	if _, err := custody.DecryptBundleV2(S1, f.label, bundle); err == nil {
		t.Fatal("decrypted under the wrong S")
	}
	// a tampered bundle
	tb := append([]byte(nil), bundle...)
	tb[len(tb)-1] ^= 1
	if _, err := custody.DecryptBundleV2(S, f.label, tb); err == nil {
		t.Fatal("a tampered bundle opened")
	}

	// the sealed partial: wrong binding, wrong member key, wrong count
	sp := v.SealedPartial
	if _, err := custody.OpenPartials(f.sk, wb, h32(t, sp.MemberEncKey), 1, h(t, sp.Sealed)); err == nil {
		t.Fatal("opened under another binding")
	}
	if _, err := custody.OpenPartials(f.sk, f.binding, h32(t, v.Challenges[0].EncKey), 1, h(t, sp.Sealed)); err == nil {
		t.Fatal("opened under another member key")
	}
	if _, err := custody.OpenPartials(f.sk, f.binding, h32(t, sp.MemberEncKey), 2, h(t, sp.Sealed)); err == nil {
		t.Fatal("opened with another count")
	}

	// bundle plaintexts that are not v2, commit no config, or carry a bad env
	com := v2member.NewCommittee(1)
	for _, c := range []struct {
		env map[string]string
		cfg string
		bad string
	}{
		{map[string]string{"A": "b"}, "nothex", "commits no config"},
		{map[string]string{"ENCLAVE_X": "b"}, strings.Repeat("7d", 32), "reserved"},
		{nil, strings.Repeat("7d", 32), "env must be an object"},
	} {
		b, err := v2member.EncryptBundle(com.Y(), f.label, c.env, c.cfg, nil, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		Rb, _ := custody.PointOf(b[:33], "R")
		rec, _ := v2member.Partial(1, com.Share(1), b[:33], f.binding, com.Commitments, nil)
		p, err := custody.VerifyPartial(rec, Rb, f.binding, com.Commitments)
		if err != nil {
			t.Fatal(err)
		}
		S, _ := custody.Combine([]custody.Partial{p}, 1)
		if _, err := custody.DecryptBundleV2(S, f.label, b); err == nil || !strings.Contains(err.Error(), c.bad) {
			t.Fatalf("%+v: %v", c, err)
		}
	}

	// challenges: none, duplicates, too many
	if _, err := custody.ChallengeRootV2(nil); err == nil {
		t.Fatal("no challenges")
	}
	if _, err := custody.ChallengeRootV2([]custody.Challenge{f.challenges[0], f.challenges[0]}); err == nil {
		t.Fatal("duplicate challenges")
	}
	many := make([]custody.Challenge, custody.MaxMachinesV2+1)
	for i := range many {
		many[i].EncKey[0], many[i].EncKey[1] = byte(i), byte(i>>8)
	}
	if _, err := custody.ChallengeRootV2(many); err == nil {
		t.Fatal("97 challenges")
	}
	if _, err := custody.ChallengeRootV2(many[:custody.MaxMachinesV2]); err != nil {
		t.Fatalf("96 challenges: %v", err)
	}
}

func (f *v2Fixture) commitmentPoint(t *testing.T, j int) *custody.Point {
	p, err := custody.PointOf(f.commitments[j], "C")
	if err != nil {
		t.Fatal(err)
	}
	return p
}
