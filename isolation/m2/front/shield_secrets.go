package main

import (
	"context"
	"crypto/ed25519"
	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/appconfig"
	"enclave.host/isolation/m2/bootstrap"
	"enclave.host/isolation/m2/egress"
	"enclave.host/isolation/m2/release"
	"enclave.host/isolation/m2/shieldconfig"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

const shieldSecretsPath = "/.well-known/enclave-secrets"
const shieldSecretPurpose = "enclave-shield-secrets/1"

type shieldSecrets struct {
	mu     sync.Mutex
	id     [32]byte
	text   string
	pipe   io.WriteCloser
	pins   []ed25519.PublicKey
	key    *release.SealKey
	nonce  [32]byte
	until  time.Time
	done   bool
	egress *shieldEgress     // the domain's outbound path, set up from the release before the pipe is written (shield_egress.go)
	fwd    *egress.Forwarder // its forwarders, held for the domain's life
}

func newShieldSecrets(pipe io.WriteCloser, file string, eg *shieldEgress) (*shieldSecrets, error) {
	if eg == nil {
		return nil, errors.New("a secret domain needs its egress path: the runtime must never get secrets without its allowlist")
	}
	b, e := os.ReadFile(file)
	if e != nil {
		return nil, e
	}
	if !regexp.MustCompile(`^0x[0-9a-f]{64}$`).Match(b) {
		return nil, errors.New("invalid secret deployment")
	}
	id, e := release.ID(string(b))
	if e != nil {
		return nil, e
	}
	pins, e := release.PinnedRelayKeys()
	if e != nil {
		return nil, e
	}
	eg.encID = id
	return &shieldSecrets{id: id, text: string(b), pipe: pipe, pins: pins, egress: eg}, nil
}
func (f *front) serveShieldSecrets(w http.ResponseWriter, r *http.Request) {
	s := f.secrets
	if s == nil {
		http.NotFound(w, r)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		http.Error(w, "already provisioned", http.StatusConflict)
		return
	}
	if r.Method == http.MethodGet {
		n, e := hex.DecodeString(r.URL.Query().Get("nonce"))
		if e != nil || len(n) != 32 {
			http.Error(w, "nonce required", 400)
			return
		}
		var nonce [32]byte
		copy(nonce[:], n)
		if s.key == nil || s.nonce != nonce || time.Now().After(s.until) {
			s.key, e = release.NewSealKey()
			if e != nil {
				http.Error(w, "key unavailable", 503)
				return
			}
			s.nonce = nonce
			s.until = time.Now().Add(120 * time.Second)
		}
		rid, e := contract.RuntimeID(f.rt.ID)
		if e != nil {
			http.Error(w, "runtime unavailable", 503)
			return
		}
		bind, e := release.Binding(s.id, f.spki, s.nonce, rid, s.key.Public())
		if e != nil {
			http.Error(w, "binding unavailable", 503)
			return
		}
		rep, certs, boundary, tier, format, wx, e := f.askMonitor(bind[:])
		if e != nil {
			http.Error(w, "report unavailable", 503)
			return
		}
		self, e := f.selfTest(wx)
		if e != nil {
			http.Error(w, "self-test unavailable", 503)
			return
		}
		d := doc{Tier: tier, Format: format, Report: base64.StdEncoding.EncodeToString(rep), TransportKey: base64.StdEncoding.EncodeToString(f.spki), AppSha256: hex.EncodeToString(f.appSha), Nonce: hex.EncodeToString(nonce[:]), Boundary: boundary, Abi: contract.ABI2, Runtime: &f.rt.ID, RuntimeSelfTest: self}
		if len(certs) > 0 {
			d.Certs = base64.StdEncoding.EncodeToString(certs)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(struct {
			Doc     doc    `json:"doc"`
			SealKey string `json:"sealKey"`
			Purpose string `json:"purpose"`
			ID      string `json:"id"`
		}{d, base64.StdEncoding.EncodeToString(s.key.Public()), shieldSecretPurpose, s.text})
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method refused", 405)
		return
	}
	if s.key == nil || time.Now().After(s.until) {
		http.Error(w, "no live challenge", 409)
		return
	}
	var b struct {
		Nonce  string `json:"nonce"`
		Sealed string `json:"sealed"`
		Sig    string `json:"sig"`
		KeyID  string `json:"keyId"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536))
	dec.DisallowUnknownFields()
	if dec.Decode(&b) != nil || b.Nonce != hex.EncodeToString(s.nonce[:]) {
		http.Error(w, "invalid release", 400)
		return
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		http.Error(w, "invalid release", 400)
		return
	}
	sealed, e := base64.StdEncoding.Strict().DecodeString(b.Sealed)
	if e != nil {
		http.Error(w, "invalid release", 400)
		return
	}
	sig, e := base64.StdEncoding.Strict().DecodeString(b.Sig)
	if e != nil {
		http.Error(w, "invalid release", 400)
		return
	}
	resp, e := s.key.Verify(s.pins, s.id, s.nonce, sealed, sig, b.KeyID)
	if e != nil {
		http.Error(w, "release refused", 403)
		return
	}
	plain, e := s.key.Open(resp)
	if e != nil {
		http.Error(w, "release refused", 403)
		return
	}
	issued, e := time.Parse(time.RFC3339Nano, plain.IssuedAt)
	if e != nil || time.Since(issued) > 120*time.Second || time.Until(issued) > 30*time.Second || shieldconfig.Validate(plain.Secrets) != nil || string(plain.Config) != "null" {
		http.Error(w, "release refused", 403)
		return
	}
	// Release facts (storage writer fencing): this build's isolation and, when the relay sent one, the lease's writer
	// authority, strictly bound to THIS deployment.
	facts, e := releaseFacts(plain, s.id, shieldIsolation)
	if e != nil {
		http.Error(w, "release refused", 403)
		return
	}
	// which facts the app gets is decided by the MEASURED config (the domain's /app.config, the bytes the AppID binds and
	// egress reads), never by the release: only the names it refers to. An unreadable one is egress's refusal below.
	measured := ""
	if s.egress != nil {
		measured, _ = readMeasuredConfig(s.egress.config, s.egress.configUID)
	}
	facts = referencedFacts(facts, measured)
	// A measured config that needs the writer authority, and a release without it (the claim not final yet, or a relay
	// that could not establish it): the release is accepted and egress set up as always, then THIS front reads the
	// authority from its own measured RPC quorum and only then writes the pipe; the runtime waits on it, the app does
	// not start, and the domain stays alive so the host keeps renewing the lease. Past writerAuthorityWindow, or on a
	// refusal, the pipe is closed EMPTY: secretrun refuses and the domain ends.
	_, have := facts[appconfig.FactWriterAuthority]
	pending := !have && strings.Contains(measured, appconfig.FactWriterAuthority)
	// the authority this front would establish is bound to the lease holder the release was for; a release that does not
	// name one (a relay predating it) is refused BEFORE it is spent
	var runner [32]byte
	if pending {
		if runner, e = releaseRunner(plain); e != nil {
			http.Error(w, "release refused", 403)
			return
		}
	}
	// Only this private pipe reaches the waiting runtime. Nothing is persisted or logged. The owner's secrets (validated
	// above: never an ENCLAVE_ name) and the reserved facts share it; secretrun separates them again (appconfig.SplitFacts).
	launch := make(map[string]string, len(plain.Secrets)+len(facts)+1)
	for k, v := range plain.Secrets {
		launch[k] = v
	}
	for k, v := range facts {
		launch[k] = v
	}
	s.done = true
	s.key = nil
	// EGRESS BEFORE THE RUNTIME (shield_egress.go): the allowlist from the measured config resolved with THESE secrets,
	// a forwarder per allowed origin listening, /etc/hosts naming only them, and the listener audit clean - all before
	// one byte reaches the runtime. On any failure the pipe is closed EMPTY: secretrun reads EOF, refuses, and the
	// domain ends, so the app never runs without the allowlist its owner's config states. The release is spent either
	// way. The console gets the failing step's name only.
	if s.egress == nil {
		e = egressStepError{"setup"}
	} else {
		s.fwd, e = s.egress.start(plain)
	}
	plain.Secrets = nil
	if e != nil {
		launch = nil
		s.pipe.Close()
		if es, ok := e.(egressStepError); ok {
			fmt.Printf("DOM egress: %s; the runtime gets nothing and the domain ends\n", es.Error())
		}
		http.Error(w, "egress unavailable", 503)
		return
	}
	s.egress.addEnc(launch)
	if pending {
		fmt.Printf("DOM writer authority: not in the release; reading the lease's finalized claim from the measured RPCs (pending)\n")
		go s.launchWhenAuthority(launch, runner)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true,"writerAuthority":"pending"}`))
		return
	}
	if e = s.launch(launch); e != nil {
		http.Error(w, "launch channel unavailable", 503)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}

// launch writes the runtime's one payload (the owner's secrets and the facts) to the pipe and closes it.
func (s *shieldSecrets) launch(m map[string]string) error {
	payload, e := json.Marshal(m)
	for k := range m {
		delete(m, k)
	}
	if e != nil || len(payload) > 65536 {
		s.pipe.Close()
		return errors.New("launch payload invalid")
	}
	_, e = s.pipe.Write(payload)
	s.pipe.Close()
	for i := range payload {
		payload[i] = 0
	}
	return e
}

// launchWhenAuthority: the writer authority from this guest's own measured RPC quorum, then the launch. The runtime is
// waiting on the pipe meanwhile. Any failure closes the pipe empty (secretrun refuses; the domain ends).
func (s *shieldSecrets) launchWhenAuthority(m map[string]string, runner [32]byte) {
	fail := func(why string) {
		for k := range m {
			delete(m, k)
		}
		s.pipe.Close()
		fmt.Printf("DOM writer authority: %s; the runtime gets nothing and the domain ends\n", why)
	}
	if s.egress == nil || s.egress.upstream == nil {
		fail("no measured egress")
		return
	}
	roots, err := bootstrap.MeasuredRoots()
	if err != nil {
		fail("no measured roots")
		return
	}
	reader, err := measuredReader(roots, s.egress.upstream)
	if err != nil {
		fail("no measured reader")
		return
	}
	w, err := bootstrap.WhenFinal(context.Background(), writerAuthorityWindow, writerAuthorityInterval, func(c context.Context) (appconfig.WriterAuthority, error) {
		return reader.LeaseWriterAuthorityFor(c, s.id, runner)
	})
	if err != nil {
		fail("unavailable (" + strings.SplitN(err.Error(), "\n", 2)[0] + ")")
		return
	}
	j, err := w.JSON()
	if err != nil {
		fail("invalid")
		return
	}
	m[appconfig.FactWriterAuthority] = j
	if s.launch(m) != nil {
		fmt.Printf("DOM writer authority: established, but the launch channel failed\n")
		return
	}
	fmt.Printf("DOM writer authority: established (claim block %d); the runtime is launched\n", w.ClaimBlock)
}
