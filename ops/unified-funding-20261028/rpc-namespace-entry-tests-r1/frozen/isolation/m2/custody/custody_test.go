package custody

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"strings"
	"testing"
)

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(strings.TrimPrefix(s, "0x"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// RFC 9180 Appendix A.1 (DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM), base mode, sequence 0
func TestHPKEAgainstRFC9180A1(t *testing.T) {
	skE, err := DeriveKeyPair(unhex(t, "7268600d403fce431561aef583ee1613527cff655c1343f29812e66706df3234"))
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(skE.PublicKey().Bytes()); got != "37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431" {
		t.Fatalf("pkEm %s", got)
	}
	skR, err := DeriveKeyPair(unhex(t, "6db9df30aa07dd42ee5e8181afdb977e538f5e1fec8a06223f33f7013e525037"))
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(skR.Bytes()); got != "4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8" {
		t.Fatalf("skRm %s", got)
	}
	info := unhex(t, "4f6465206f6e2061204772656369616e2055726e")
	pt := unhex(t, "4265617574792069732074727574682c20747275746820626561757479")
	aad := unhex(t, "436f756e742d30")
	blob, err := Seal(skR.PublicKey(), info, aad, pt, unhex(t, "7268600d403fce431561aef583ee1613527cff655c1343f29812e66706df3234"))
	if err != nil {
		t.Fatal(err)
	}
	want := "37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431" +
		"f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a"
	if hex.EncodeToString(blob) != want {
		t.Fatalf("seal\n got %x\nwant %s", blob, want)
	}
	got, err := Open(skR, info, aad, blob)
	if err != nil || string(got) != string(pt) {
		t.Fatalf("open: %v", err)
	}
	if _, err := Open(skR, info, []byte("other"), blob); err == nil {
		t.Fatal("opened under another aad")
	}
	var zero [32]byte
	if pk, err := ecdh.X25519().NewPublicKey(zero[:]); err == nil {
		if _, err := Seal(pk, info, aad, pt, nil); err == nil {
			t.Fatal("sealed to a low-order key")
		}
	}
}

type vectors struct {
	ChainID    uint64          `json:"chainId"`
	Vault      string          `json:"vault"`
	ID         string          `json:"id"`
	PolicyRev  string          `json:"policyRev"`
	SecretRev  string          `json:"secretRev"`
	Epoch      uint32          `json:"epoch"`
	Members    []string        `json:"members"`
	Challenges []wireChallenge `json:"challenges"`
	Root       string          `json:"challengeRoot"`
	RuntimeID  string          `json:"runtimeId"`
	SPKI       string          `json:"transportSpki"`
	Recipient  struct {
		IkmFill byte `json:"ikmFill"`
	} `json:"recipient"`
	Binding  string `json:"binding"`
	Operator struct {
		Endpoint string `json:"endpoint"`
		Expiry   int64  `json:"expiry"`
		Message  string `json:"message"`
	} `json:"operator"`
	Threshold  int               `json:"threshold"`
	SecretFill byte              `json:"secretFill"`
	C0         string            `json:"c0"`
	DEK        string            `json:"dek"`
	BundleAAD  string            `json:"bundleAad"`
	Env        map[string]string `json:"env"`
	ConfigSha  string            `json:"configSha256"`
	Cipher     string            `json:"ciphertext"`
	Responses  []struct {
		Index  int    `json:"index"`
		EncKey string `json:"encKey"`
		Sealed string `json:"sealed"`
	} `json:"responses"`
	Bad struct {
		Index  int    `json:"index"`
		EncKey string `json:"encKey"`
		Sealed string `json:"sealed"`
	} `json:"badResponse"`
}

func loadVectors(t *testing.T) (vectors, Context, [32]byte) {
	t.Helper()
	raw, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	var c Context
	c.ChainID = v.ChainID
	copy(c.Vault[:], unhex(t, v.Vault))
	var id [32]byte
	copy(id[:], unhex(t, v.ID))
	return v, c, id
}

func b32(t *testing.T, s string) (o [32]byte) { copy(o[:], unhex(t, s)); return }

func TestVectorsFromTheJSReference(t *testing.T) {
	v, c, id := loadVectors(t)
	var chs []Challenge
	for _, ch := range v.Challenges {
		chs = append(chs, Challenge{EncKey: b32(t, ch.EncKey), Nonce: b32(t, ch.Nonce)})
	}
	root, err := ChallengeRoot(chs)
	if err != nil || hex.EncodeToString(root[:]) != v.Root {
		t.Fatalf("challenge root %x vs %s (%v)", root, v.Root, err)
	}
	sk, err := DeriveKeyPair(bytes.Repeat([]byte{v.Recipient.IkmFill}, 32))
	if err != nil {
		t.Fatal(err)
	}
	var pk [32]byte
	copy(pk[:], sk.PublicKey().Bytes()) // pinned below: the binding commits to it
	var pr, sr uint64
	fmt.Sscan(v.PolicyRev, &pr)
	fmt.Sscan(v.SecretRev, &sr)
	bind, err := Binding(BindingInput{Ctx: c, ID: id, PolicyRev: pr, SecretRev: sr, Epoch: v.Epoch, Challenges: chs,
		RuntimeID: b32(t, v.RuntimeID), TransportSPKI: unhex(t, v.SPKI), RecipientKey: pk})
	if err != nil || hex.EncodeToString(bind[:]) != v.Binding {
		t.Fatalf("binding %x vs %s (%v)", bind, v.Binding, err)
	}
	if m := OperatorMessage(c, id, v.Operator.Endpoint, bind, v.Operator.Expiry); m != v.Operator.Message {
		t.Fatalf("operator message\n got %s\nwant %s", m, v.Operator.Message)
	}
	s := new(big.Int).SetBytes(bytes.Repeat([]byte{v.SecretFill}, 32))
	dek, err := DeriveDEK(s, c, id, sr)
	if err != nil || hex.EncodeToString(dek) != v.DEK {
		t.Fatalf("dek %x vs %s", dek, v.DEK)
	}
	aad, _ := BundleAAD(c, id, sr, unhex(t, v.C0))
	if hex.EncodeToString(aad) != v.BundleAAD {
		t.Fatalf("bundle aad %x vs %s", aad, v.BundleAAD)
	}
	b, err := DecryptBundle(dek, aad, unhex(t, v.Cipher))
	if err != nil || fmt.Sprint(b.Env) != fmt.Sprint(v.Env) || b.ConfigSha256 != v.ConfigSha {
		t.Fatalf("bundle: %+v %v", b, err)
	}
	// the responses open under the recipient key and this binding, and combine to the secret
	var sh []share
	for _, r := range v.Responses {
		y, err := openShare(sk, bind, b32(t, r.EncKey), r.Index, unhex(t, r.Sealed))
		if err != nil {
			t.Fatalf("response %d: %v", r.Index, err)
		}
		sh = append(sh, share{x: int64(r.Index + 1), y: y})
	}
	got, err := lagrange(sh)
	if err != nil || got.Cmp(s) != 0 {
		t.Fatalf("combine: %v", err)
	}
	// a response opened under ANOTHER binding fails: the recipient-key/binding pairing is authenticated
	other := bind
	other[0] ^= 1
	if _, err := openShare(sk, other, b32(t, v.Responses[0].EncKey), v.Responses[0].Index, unhex(t, v.Responses[0].Sealed)); err == nil {
		t.Fatal("a response opened under another binding")
	}
	// a lying custodian's (well-formed) wrong share: the first combination including it fails, another succeeds
	bad, err := openShare(sk, bind, b32(t, v.Bad.EncKey), v.Bad.Index, unhex(t, v.Bad.Sealed))
	if err != nil {
		t.Fatal(err)
	}
	all := append([]share{{x: int64(v.Bad.Index + 1), y: bad}}, sh...)
	out, tried, err := recoverEnv(all, v.Threshold, 1024, func(s *big.Int) (*Bundle, error) {
		k, _ := DeriveDEK(s, c, id, sr)
		return DecryptBundle(k, aad, unhex(t, v.Cipher))
	})
	if err != nil || fmt.Sprint(out.Env) != fmt.Sprint(v.Env) || tried < 2 {
		t.Fatalf("recover with a liar: tried %d, %v", tried, err)
	}
}

// Obtain end to end against in-process custodians that seal exactly as custody/custodian.mjs does.
func TestObtainAgainstFakeCustodians(t *testing.T) {
	v, c, id := loadVectors(t)
	var sr uint64
	fmt.Sscan(v.SecretRev, &sr)
	s := new(big.Int).SetBytes(bytes.Repeat([]byte{v.SecretFill}, 32))
	// the 5 shares of the fixture's secret (x = 1..5) from its polynomial: recompute them from the 3 known ones
	known := map[int64]*big.Int{}
	sk0, _ := DeriveKeyPair(bytes.Repeat([]byte{v.Recipient.IkmFill}, 32))
	bind0 := b32(t, v.Binding)
	for _, r := range v.Responses {
		y, _ := openShare(sk0, bind0, b32(t, r.EncKey), r.Index, unhex(t, r.Sealed))
		known[int64(r.Index+1)] = y
	}
	shareAt := func(x int64) *big.Int { // Lagrange interpolation of the degree-2 polynomial at x
		out := new(big.Int)
		for xi, yi := range known {
			num, den := big.NewInt(1), big.NewInt(1)
			for xj := range known {
				if xj == xi {
					continue
				}
				num.Mod(num.Mul(num, new(big.Int).Mod(big.NewInt(x-xj), order)), order)
				den.Mod(den.Mul(den, new(big.Int).Mod(big.NewInt(xi-xj), order)), order)
			}
			term := new(big.Int).Mul(yi, num)
			term.Mul(term.Mod(term, order), new(big.Int).ModInverse(den, order))
			out.Add(out, term).Mod(out, order)
		}
		return out
	}
	st := State{Ctx: c, ID: id, PolicyRev: 7, SecretRev: sr, Epoch: v.Epoch, Threshold: 3, C0: unhex(t, v.C0), Ciphertext: unhex(t, v.Cipher)}
	for i, m := range v.Members {
		st.Members = append(st.Members, Member{EncKey: b32(t, m), Endpoint: fmt.Sprintf("https://custodian-%d.example", i)})
	}
	runB := func(down map[int]bool, liar int) (*Bundle, error) {
		var lastReq wireRelease
		cl := &Client{RuntimeID: b32(t, v.RuntimeID), TransportSPKI: unhex(t, v.SPKI),
			Evidence: func(b [32]byte) (json.RawMessage, error) { return json.RawMessage(`{"format":"test"}`), nil },
			Authorize: func(ctx context.Context, id, b [32]byte) (string, string, int64, error) {
				return "https://host.example", "0xsig", 1800000000, nil
			},
			Post: func(ctx context.Context, url string, body, out any) error {
				var i int
				fmt.Sscanf(url, "https://custodian-%d.example", &i)
				if down[i] {
					return errors.New("unreachable")
				}
				if strings.HasSuffix(url, "/challenge") {
					n := sha256.Sum256([]byte(fmt.Sprint("nonce", i)))
					*out.(*wireChallenge) = wireChallenge{EncKey: v.Members[i], Nonce: hex.EncodeToString(n[:])}
					return nil
				}
				lastReq = body.(wireRelease)
				// the custodian recomputes the binding from the request, as custody/custodian.mjs does
				var chs []Challenge
				for _, ch := range lastReq.Challenges {
					chs = append(chs, Challenge{EncKey: b32(t, ch.EncKey), Nonce: b32(t, ch.Nonce)})
				}
				bind, err := Binding(BindingInput{Ctx: c, ID: id, PolicyRev: 7, SecretRev: sr, Epoch: v.Epoch, Challenges: chs,
					RuntimeID: b32(t, v.RuntimeID), TransportSPKI: unhex(t, v.SPKI), RecipientKey: b32(t, lastReq.RecipientKey)})
				if err != nil {
					return err
				}
				y := shareAt(int64(i + 1))
				if i == liar {
					y = new(big.Int).Add(y, big.NewInt(1))
				}
				pk, _ := ecdh.X25519().NewPublicKey(unhex(t, lastReq.RecipientKey))
				sealed, err := Seal(pk, []byte(infoRelease), responseAAD(bind, b32(t, v.Members[i]), i), scalarBytes(y), nil)
				if err != nil {
					return err
				}
				*out.(*wireShare) = wireShare{V: 1, EncKey: v.Members[i], Index: i, Sealed: base64.StdEncoding.EncodeToString(sealed)}
				return nil
			}}
		return cl.Obtain(context.Background(), st)
	}
	run := func(down map[int]bool, liar int) (map[string]string, error) {
		b, err := runB(down, liar)
		if err != nil {
			return nil, err
		}
		if b.ConfigSha256 != v.ConfigSha {
			return nil, fmt.Errorf("config commitment %s", b.ConfigSha256)
		}
		return b.Env, nil
	}
	if env, err := run(nil, -1); err != nil || fmt.Sprint(env) != fmt.Sprint(v.Env) {
		t.Fatalf("all up: %v %v", env, err)
	}
	if env, err := run(map[int]bool{0: true, 3: true}, -1); err != nil || fmt.Sprint(env) != fmt.Sprint(v.Env) {
		t.Fatalf("two down: %v %v", env, err)
	}
	if env, err := run(nil, 2); err != nil || fmt.Sprint(env) != fmt.Sprint(v.Env) {
		t.Fatalf("one liar: %v %v", env, err)
	}
	if _, err := run(map[int]bool{0: true, 1: true, 4: true}, -1); !errors.Is(err, ErrQuorum) {
		t.Fatalf("three down must be a quorum failure, got %v", err)
	}
	_ = s
}
