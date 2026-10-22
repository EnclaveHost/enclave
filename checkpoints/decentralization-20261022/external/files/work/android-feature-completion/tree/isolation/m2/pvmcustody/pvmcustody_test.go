package pvmcustody

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"enclave.host/isolation/m2/appconfig"
	"enclave.host/isolation/m2/bootstrap"
	"enclave.host/isolation/m2/release"
)

const identity = `{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}`
const selftest = "exec_pages=refused:EACCES wx=clean maps=1 scope=self"

func edKey(t *testing.T) (ed25519.PrivateKey, []byte) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	spki, _ := x509.MarshalPKIXPublicKey(pub)
	return priv, spki
}

// The challenge vector the JS custodian pins (test/fixtures/avf-custody-challenge-vector.json).
func TestChallengeVectorFromTheJSReference(t *testing.T) {
	b, err := os.ReadFile("../../../test/fixtures/avf-custody-challenge-vector.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct{ Binding, InstanceID, AppID, Challenge string }
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	h := func(s string) (o [32]byte) { x, _ := hex.DecodeString(s); copy(o[:], x); return }
	for _, c := range []struct{ name, want string }{{"binding", v.Binding}, {"instance", v.InstanceID}, {"app", v.AppID}} {
		if s := sha256.Sum256([]byte(c.name)); hex.EncodeToString(s[:]) != c.want {
			t.Fatalf("vector input %s differs", c.name)
		}
	}
	ch := Challenge(h(v.Binding), h(v.InstanceID), h(v.AppID))
	if hex.EncodeToString(ch[:]) != v.Challenge {
		t.Fatalf("challenge %x, the JS reference says %s", ch, v.Challenge)
	}
}

func TestVMCheckRefusesWhatTheCustodianWould(t *testing.T) {
	_, tr := edKey(t)
	_, in := edKey(t)
	good := VM{Identity: identity, Selftest: selftest, SPKI: tr, InstanceKey: in}
	if _, _, err := good.check(); err != nil {
		t.Fatal(err)
	}
	cases := map[string]VM{
		"instance = transport": {Identity: identity, Selftest: selftest, SPKI: tr, InstanceKey: tr},
		"not canonical":        {Identity: strings.Replace(identity, `"cache":"none",`, `"cache": "none",`, 1), Selftest: selftest, SPKI: tr, InstanceKey: in},
		"extra field":          {Identity: strings.Replace(identity, `}`, `,"x":"y"}`, 1), Selftest: selftest, SPKI: tr, InstanceKey: in},
		"no self-test":         {Identity: identity, SPKI: tr, InstanceKey: in},
		"not ed25519":          {Identity: identity, Selftest: selftest, SPKI: tr[:40], InstanceKey: in},
		"inadmissible runtime": {Identity: strings.Replace(identity, `"wx":"enforced"`, `"wx":"off"`, 1), Selftest: selftest, SPKI: tr, InstanceKey: in},
	}
	for name, vm := range cases {
		if _, _, err := vm.check(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestEvidenceRefusesAnInstanceSignatureOverAnotherChallenge(t *testing.T) {
	ipriv, in := edKey(t)
	_, tr := edKey(t)
	vm := VM{Identity: identity, Selftest: selftest, SPKI: tr, InstanceKey: in}
	_, iid, _ := vm.check()
	var binding [32]byte
	rand.Read(binding[:])
	chain := [][]byte{{1}, {2}}
	if _, err := vm.evidence(binding, iid, func(c [64]byte) (*Attested, error) {
		other := c
		other[0] ^= 1
		return &Attested{Chain: chain, InstanceSig: ed25519.Sign(ipriv, InstanceSigMessage(other))}, nil
	}); err == nil {
		t.Fatal("a signature over another challenge was accepted")
	}
	raw, err := vm.evidence(binding, iid, func(c [64]byte) (*Attested, error) {
		return &Attested{Chain: chain, InstanceSig: ed25519.Sign(ipriv, InstanceSigMessage(c))}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var d map[string]any
	json.Unmarshal(raw, &d)
	want := []string{"abi", "appSha256", "chain", "format", "identity", "instanceKey", "instanceSig", "runtime", "selftest", "spki", "transportKey"}
	if len(d) != len(want) {
		t.Fatalf("document fields %v", d)
	}
	for _, k := range want {
		if _, ok := d[k]; !ok {
			t.Fatalf("no %s", k)
		}
	}
	if d["transportKey"] != base64.StdEncoding.EncodeToString(tr) || d["format"] != EvidenceFormat {
		t.Fatal("transport key or format")
	}
}

// ---- the composition, with a fake owner authorization (bootstrap's own suite covers Authorize itself) ----
type fakeAuth struct {
	mode, text  string
	ptr         *release.Custody
	revalidated int
	revalidate  error
}

func (a *fakeAuth) ConfigText() (string, error)        { return a.text, nil }
func (a *fakeAuth) SecretsMode() (string, error)       { return a.mode, nil }
func (a *fakeAuth) Custody() (*release.Custody, error) { return a.ptr, nil }
func (a *fakeAuth) Revalidate(context.Context) error   { a.revalidated++; return a.revalidate }

type nopHost struct{}

func (nopHost) Dial(context.Context, string) (net.Conn, error) { return nil, errors.New("no network") }
func (nopHost) Attest([64]byte) (*Attested, error)             { return nil, errors.New("no attestation") }
func (nopHost) Authorize(context.Context, [20]byte, [32]byte, [32]byte) (string, string, int64, error) {
	return "", "", 0, errors.New("no operator")
}
func (nopHost) Logf(string, ...any) {}

func TestPublicStartupAndItsRevalidation(t *testing.T) {
	_, tr := edKey(t)
	_, in := edKey(t)
	vm := VM{Identity: identity, Selftest: selftest, SPKI: tr, InstanceKey: in}
	a := &fakeAuth{mode: "public", text: `{"a":1}`}
	var gotLoaded bootstrap.Identity
	auth := func(_ context.Context, _ [32]byte, _ []byte, l bootstrap.Identity) (startupAuth, error) {
		gotLoaded = l
		return a, nil
	}
	d := &dialer{allowed: map[string]bool{}, host: nopHost{}}
	r, err := start(context.Background(), nopHost{}, vm, [32]byte{1}, []byte("{}"), auth, d, &http.Client{})
	if err != nil || r.ConfigText != `{"a":1}` || r.Resolved != `{"a":1}` || r.Values != nil || a.revalidated != 1 {
		t.Fatalf("public: %v %+v", err, r)
	}
	rid, _, _ := vm.check()
	if gotLoaded.RuntimeID != rid {
		t.Fatal("the loaded identity is not this VM's runtime")
	}
	a.revalidate = errors.New("the lease moved")
	if _, err := start(context.Background(), nopHost{}, vm, [32]byte{1}, []byte("{}"), auth, d, &http.Client{}); err == nil {
		t.Fatal("a failed revalidation still started")
	}
	a.mode = "relay-sealed"
	if _, err := start(context.Background(), nopHost{}, vm, [32]byte{1}, []byte("{}"), auth, d, &http.Client{}); err == nil {
		t.Fatal("an unknown secrets mode started")
	}
}

func TestDialAllowlist(t *testing.T) {
	d := &dialer{allowed: map[string]bool{"a.example:443": true}, host: nopHost{}}
	if _, err := d.dial(context.Background(), "tcp", "b.example:443"); err == nil || !strings.Contains(err.Error(), "not a measured") {
		t.Fatalf("an unlisted origin: %v", err)
	}
	d.allow("b.example:8443")
	if _, err := d.dial(context.Background(), "tcp", "b.example:8443"); err == nil || !strings.Contains(err.Error(), "443") {
		t.Fatalf("a non-443 origin: %v", err)
	}
}

// ---- end to end: this package against REAL JS custodians (test/custody-v2-avf-go.test.mjs starts them) ----
type e2eScenario struct {
	Name       string            `json:"name"`
	Deployment string            `json:"deployment"`
	ConfigText string            `json:"configText"`
	Pointer    json.RawMessage   `json:"pointer"`
	Hosts      map[string]int    `json:"hosts"`
	Expect     map[string]string `json:"expect"`
	ExpectErr  string            `json:"expectErr"`
	Revalidate string            `json:"revalidate"`
}
type e2eConfig struct {
	CAPem     string        `json:"caPem"`
	Control   string        `json:"control"`
	Scenarios []e2eScenario `json:"scenarios"`
}

// e2eHost: streams to the harness's TLS custodians by name; the SYNTHETIC attestation and the operator's signature from
// the harness's control server (it plays AVmPayload_requestAttestation and the phone's host agent).
type e2eHost struct {
	t        *testing.T
	ports    map[string]int
	control  string
	scenario string
	logs     *bytes.Buffer
}

func (h *e2eHost) Dial(ctx context.Context, host string) (net.Conn, error) {
	p, ok := h.ports[host]
	if !ok {
		return nil, fmt.Errorf("no route to %s", host)
	}
	var d net.Dialer
	return d.DialContext(ctx, "tcp", fmt.Sprintf("127.0.0.1:%d", p))
}
func (h *e2eHost) call(path string, in, out any) error {
	b, _ := json.Marshal(in)
	r, err := http.Post(h.control+path, "application/json", bytes.NewReader(b))
	if err != nil {
		return err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return fmt.Errorf("control %s: %d", path, r.StatusCode)
	}
	return json.NewDecoder(r.Body).Decode(out)
}
func (h *e2eHost) Attest(ch [64]byte) (*Attested, error) {
	var o struct {
		Chain       []string `json:"chain"`
		InstanceSig string   `json:"instanceSig"`
	}
	if err := h.call("/attest", map[string]string{"scenario": h.scenario, "challenge": hex.EncodeToString(ch[:])}, &o); err != nil {
		return nil, err
	}
	a := &Attested{}
	for _, c := range o.Chain {
		b, _ := base64.StdEncoding.DecodeString(c)
		a.Chain = append(a.Chain, b)
	}
	a.InstanceSig, _ = hex.DecodeString(o.InstanceSig)
	return a, nil
}
func (h *e2eHost) Authorize(_ context.Context, vault [20]byte, id, binding [32]byte) (string, string, int64, error) {
	var o struct {
		Endpoint string `json:"endpoint"`
		Sig      string `json:"sig"`
		Expiry   int64  `json:"expiry"`
	}
	err := h.call("/authorize", map[string]string{"scenario": h.scenario, "vault": "0x" + hex.EncodeToString(vault[:]), "id": "0x" + hex.EncodeToString(id[:]), "binding": hex.EncodeToString(binding[:])}, &o)
	return o.Endpoint, o.Sig, o.Expiry, err
}
func (h *e2eHost) Logf(f string, a ...any) { fmt.Fprintf(h.logs, f+"\n", a...) }

func TestEndToEndAgainstJSCustodians(t *testing.T) {
	file := os.Getenv("PVMC_E2E")
	if file == "" {
		t.Skip("PVMC_E2E unset: run through test/custody-v2-avf-go.test.mjs, which starts the JS custodians")
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var cfg e2eConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	var vmInfo struct{ AppID, Identity, Selftest, SPKI, InstanceKey string }
	h0 := &e2eHost{t: t, control: cfg.Control}
	if err := h0.call("/vm", map[string]string{}, &vmInfo); err != nil {
		t.Fatal(err)
	}
	hx := func(s string) []byte { b, _ := hex.DecodeString(s); return b }
	vm := VM{Identity: vmInfo.Identity, Selftest: vmInfo.Selftest, SPKI: hx(vmInfo.SPKI), InstanceKey: hx(vmInfo.InstanceKey)}
	copy(vm.AppID[:], hx(vmInfo.AppID))
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM([]byte(cfg.CAPem)) {
		t.Fatal("harness CA")
	}
	for _, sc := range cfg.Scenarios {
		t.Run(sc.Name, func(t *testing.T) {
			var ptr release.Custody
			if err := json.Unmarshal(sc.Pointer, &ptr); err != nil {
				t.Fatal(err)
			}
			a := &fakeAuth{mode: "custody-v2", text: sc.ConfigText, ptr: &ptr}
			if sc.Revalidate != "" {
				a.revalidate = errors.New(sc.Revalidate)
			}
			auth := func(context.Context, [32]byte, []byte, bootstrap.Identity) (startupAuth, error) { return a, nil }
			h := &e2eHost{t: t, ports: sc.Hosts, control: cfg.Control, scenario: sc.Name, logs: &bytes.Buffer{}}
			d := &dialer{allowed: map[string]bool{}, host: h}
			client := measuredClient(d, roots)
			var id [32]byte
			copy(id[:], hx(strings.TrimPrefix(sc.Deployment, "0x")))
			ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			defer cancel()
			r, err := start(ctx, h, vm, id, []byte("{}"), auth, d, client)
			t.Logf("guest log:\n%s", h.logs.String())
			if sc.ExpectErr != "" {
				if err == nil {
					t.Fatalf("started; expected a refusal matching %q", sc.ExpectErr)
				}
				if !regexp.MustCompile(sc.ExpectErr).MatchString(err.Error() + "\n" + h.logs.String()) {
					t.Fatalf("refused for another reason: %v", err)
				}
				if r != nil {
					t.Fatal("a refusal returned values")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if r.ConfigText != sc.ConfigText || len(r.Values) != len(sc.Expect) {
				t.Fatalf("result %q %d values", r.ConfigText, len(r.Values))
			}
			// the component's config: the owner's text with every $NAME resolved, by the platform runner's rule
			if want, _ := appconfig.Resolve(sc.ConfigText, sc.Expect); r.Resolved != want || strings.Contains(r.Resolved, "$") {
				t.Fatalf("resolved config %q, want %q", r.Resolved, want)
			}
			for _, v := range sc.Expect {
				if !strings.Contains(r.Resolved, v) {
					t.Fatal("a value is not in the resolved config")
				}
			}
			for k, v := range sc.Expect {
				if r.Values[k] != v {
					t.Fatalf("%s differs", k)
				}
			}
			if a.revalidated != 1 {
				t.Fatal("not revalidated before the app start")
			}
		})
	}
}
