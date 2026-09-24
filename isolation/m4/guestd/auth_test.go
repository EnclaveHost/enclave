package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"enclave.host/isolation/contract"
)

// ctl is a guestd-control/1 client written from the protocol text in auth.go, for these tests. The supervisor's
// client is control-client.mjs; TestTheJSClientInteroperates holds the two to the same wire format.
type ctl struct {
	t    *testing.T
	base string
	key  []byte
	sid  string
	skey []byte
	seq  uint64
}

func hm(key []byte, parts ...string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(strings.Join(parts, "\n")))
	return m.Sum(nil)
}

func (c *ctl) get(path string) (int, map[string]any) {
	res, err := http.Get(c.base + path)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	var m map[string]any
	_ = json.NewDecoder(res.Body).Decode(&m)
	return res.StatusCode, m
}

func (c *ctl) postJSON(path string, v any) (int, map[string]any) {
	b, _ := json.Marshal(v)
	res, err := http.Post(c.base+path, "application/json", bytes.NewReader(b))
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	var m map[string]any
	_ = json.NewDecoder(res.Body).Decode(&m)
	return res.StatusCode, m
}

// sessionRequest builds the handshake body a holder of key would send after this hello.
func sessionRequest(key []byte, hello map[string]any, cn string) map[string]any {
	kid := keyID(key)
	return map[string]any{"instance": hello["instance"], "nonce": hello["nonce"], "clientNonce": cn, "kid": kid,
		"mac": hex.EncodeToString(hm(key, "guestd-control/1 session", hello["instance"].(string), hello["nonce"].(string), cn, kid))}
}

func (c *ctl) handshake() error {
	code, h := c.get("/control/hello")
	if code != 200 || h["proto"] != "guestd-control/1" {
		return errors.New("no guestd-control/1 here: refusing to fall back")
	}
	cn := randHex(32)
	code, s := c.postJSON("/control/session", sessionRequest(c.key, h, cn))
	if code != 200 {
		return errors.New("session refused: " + s["error"].(string))
	}
	sid := s["session"].(string)
	skey := hm(c.key, "guestd-control/1 skey", h["instance"].(string), h["nonce"].(string), cn, sid)
	if hex.EncodeToString(hm(skey, "guestd-control/1 proof", cn)) != s["proof"] {
		return errors.New("guestd did not prove the pairing key")
	}
	c.sid, c.skey, c.seq = sid, skey, 0
	return nil
}

type signed struct {
	method, path string
	body         []byte
	hdr          http.Header
}

func (c *ctl) sign(method, path string, body []byte) signed {
	c.seq++
	n := strconv.FormatUint(c.seq, 10)
	bh := sha256.Sum256(body)
	h := http.Header{}
	h.Set("X-Guestd-Session", c.sid)
	h.Set("X-Guestd-Seq", n)
	h.Set("X-Guestd-Mac", hex.EncodeToString(hm(c.skey, "guestd-control/1 req", c.sid, n, method, path, hex.EncodeToString(bh[:]))))
	return signed{method, path, body, h}
}

// send sends a (possibly altered) signed request and returns status, body, and whether the answer's MAC verifies.
func (c *ctl) send(s signed) (int, map[string]any, bool) {
	req, _ := http.NewRequest(s.method, c.base+s.path, bytes.NewReader(s.body))
	req.Header = s.hdr.Clone()
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	rh := sha256.Sum256(raw)
	want := hex.EncodeToString(hm(c.skey, "guestd-control/1 resp", c.sid, s.hdr.Get("X-Guestd-Seq"), strconv.Itoa(res.StatusCode), hex.EncodeToString(rh[:])))
	return res.StatusCode, m, res.Header.Get("X-Guestd-Response-Mac") == want
}

func (c *ctl) do(method, path string, body []byte) (int, map[string]any, bool) {
	return c.send(c.sign(method, path, body))
}

var testKey = bytes.Repeat([]byte{0x5a}, 32)

func authRig(t *testing.T) (*rig, *ctl) {
	r := newRig(t)
	r.s.Auth = newControlAuth(testKey, r.s.Now)
	return r, &ctl{t: t, base: r.ts.URL, key: testKey}
}

func TestWithoutCredentialsTheHandshakeRefusesSoAClientFailsClosed(t *testing.T) {
	r := newRig(t)
	c := &ctl{t: t, base: r.ts.URL, key: testKey}
	if code, body := c.get("/control/hello"); code != 404 || !strings.Contains(body["error"].(string), "no control credentials") {
		t.Fatalf("lab mode must refuse the handshake: %d %v", code, body)
	}
	if err := c.handshake(); err == nil {
		t.Fatal("a client expecting guestd-control/1 must fail closed against an unauthenticated guestd")
	}
}

func TestEveryRouteRefusesAnUnauthenticatedRequest(t *testing.T) {
	r, c := authRig(t)
	p, _ := r.bundle("A", contract.Policy{})
	for _, q := range []struct{ m, p, b string }{{"GET", "/health", ""}, {"GET", "/vms", ""}, {"GET", "/vms/gd00", ""},
		{"DELETE", "/vms/gd00", ""}, {"POST", "/vms/lease", `{"ids":[]}`}, {"POST", "/prefetch", `{"image":"ipfs://x"}`},
		{"POST", "/vms", `{"image":"file://` + p + `","name":"0xa"}`}} {
		req, _ := http.NewRequest(q.m, c.base+q.p, strings.NewReader(q.b))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 401 {
			t.Errorf("%s %s without a session: %d", q.m, q.p, res.StatusCode)
		}
	}
	if r.f.builds != 0 || len(r.s.vms) != 0 {
		t.Fatal("an unauthenticated request did something")
	}
}

func TestTheHandshakeIsMutualAndAuthorisesSignedRequests(t *testing.T) {
	r, c := authRig(t)
	if err := c.handshake(); err != nil {
		t.Fatal(err)
	}
	p, _ := r.bundle("A", contract.Policy{})
	body, _ := json.Marshal(map[string]any{"image": "file://" + p, "name": "0xa"})
	code, got, ok := c.do("POST", "/vms", body)
	if code != 201 || !ok {
		t.Fatalf("signed launch: %d %v (response mac ok=%v)", code, got, ok)
	}
	r.s.launching.Wait()
	code, got, ok = c.do("GET", "/vms/"+got["id"].(string), nil)
	if code != 200 || got["status"] != "running" || !ok {
		t.Fatalf("signed read: %d %v %v", code, got, ok)
	}
	if code, _, ok := c.do("GET", "/health", nil); code != 200 || !ok {
		t.Fatal("signed health")
	}
}

func TestTheHandshakeRefusesTheWrongKeyAndAnyReusedExpiredOrForeignNonce(t *testing.T) {
	r, c := authRig(t)
	_, h := c.get("/control/hello")
	if code, _ := c.postJSON("/control/session", sessionRequest(bytes.Repeat([]byte{7}, 32), h, randHex(32))); code != 401 {
		t.Fatalf("another key: %d", code)
	}
	// a correct key but the kid of another: refused
	bad := sessionRequest(testKey, h, randHex(32))
	bad["kid"] = "0000000000000000"
	if code, _ := c.postJSON("/control/session", bad); code != 401 {
		t.Fatal("wrong kid accepted")
	}
	_, h = c.get("/control/hello")
	good := sessionRequest(testKey, h, randHex(32))
	if code, _ := c.postJSON("/control/session", good); code != 200 {
		t.Fatalf("the genuine handshake: %d", code)
	}
	if code, _ := c.postJSON("/control/session", good); code != 401 {
		t.Fatal("a nonce was accepted twice")
	}
	_, h = c.get("/control/hello")
	r.advance(31 * time.Second)
	if code, _ := c.postJSON("/control/session", sessionRequest(testKey, h, randHex(32))); code != 401 {
		t.Fatal("an expired nonce was accepted")
	}
	forged := sessionRequest(testKey, map[string]any{"instance": r.s.Auth.instance, "nonce": randHex(32)}, randHex(32))
	if code, _ := c.postJSON("/control/session", forged); code != 401 {
		t.Fatal("a nonce this guestd never issued was accepted")
	}
}

func TestAReplayedOrOldRequestIsRefusedAndOrderWithinTheWindowIsNot(t *testing.T) {
	_, c := authRig(t)
	if err := c.handshake(); err != nil {
		t.Fatal(err)
	}
	first := c.sign("GET", "/vms", nil)
	if code, _, _ := c.send(first); code != 200 {
		t.Fatal("the original")
	}
	if code, _, _ := c.send(first); code != 401 {
		t.Fatal("a replay was accepted")
	}
	// concurrent requests arrive out of order: 3 then 2 are both fine, once each
	two, three := c.sign("GET", "/vms", nil), c.sign("GET", "/vms", nil)
	if code, _, _ := c.send(three); code != 200 {
		t.Fatal("seq 3")
	}
	if code, _, _ := c.send(two); code != 200 {
		t.Fatal("seq 2 inside the window")
	}
	if code, _, _ := c.send(two); code != 401 {
		t.Fatal("seq 2 replayed")
	}
	for i := 0; i < 70; i++ {
		c.sign("GET", "/vms", nil) // numbers the client skips
	}
	if code, _, _ := c.do("GET", "/vms", nil); code != 200 {
		t.Fatal("a jump forward")
	}
	if code, _, _ := c.send(c.withSeq(c.sign("GET", "/vms", nil), 4)); code != 401 {
		t.Fatal("a number older than the window was accepted")
	}
	if code, _, _ := c.send(c.withSeq(c.sign("GET", "/vms", nil), 0)); code != 401 {
		t.Fatal("sequence 0 was accepted")
	}
}

// withSeq re-signs s under sequence number n (a genuine signature for an old number).
func (c *ctl) withSeq(s signed, n uint64) signed {
	save := c.seq
	c.seq = n - 1
	out := c.sign(s.method, s.path, s.body)
	c.seq = save
	return out
}

func TestATamperedRequestOrAnswerIsCaught(t *testing.T) {
	r, c := authRig(t)
	if err := c.handshake(); err != nil {
		t.Fatal(err)
	}
	p, _ := r.bundle("A", contract.Policy{})
	body, _ := json.Marshal(map[string]any{"image": "file://" + p, "name": "0xa"})
	for name, alter := range map[string]func(s signed) signed{
		"body":   func(s signed) signed { s.body = bytes.Replace(s.body, []byte("0xa"), []byte("0xb"), 1); return s },
		"path":   func(s signed) signed { s.path = "/vms/lease"; return s },
		"method": func(s signed) signed { s.method = "PUT"; return s },
		"seq": func(s signed) signed {
			s.hdr = s.hdr.Clone()
			s.hdr.Set("X-Guestd-Seq", "999")
			return s
		},
		"mac": func(s signed) signed {
			s.hdr = s.hdr.Clone()
			m := []byte(s.hdr.Get("X-Guestd-Mac"))
			m[0] ^= 1
			s.hdr.Set("X-Guestd-Mac", string(m))
			return s
		},
	} {
		if code, _, _ := c.send(alter(c.sign("POST", "/vms", body))); code != 401 {
			t.Errorf("tampered %s: %d", name, code)
		}
	}
	if r.f.builds != 0 {
		t.Fatal("a tampered request launched something")
	}
	// the numbers the tampered requests used were NOT burned: a forgery cannot poison the window
	if code, _, ok := c.send(c.withSeq(c.sign("GET", "/vms", nil), 1)); code != 200 || !ok {
		t.Fatalf("seq 1 after forgeries: %d", code)
	}
	// and an answer altered in transit fails the client's check
	s := c.sign("GET", "/health", nil)
	req, _ := http.NewRequest("GET", c.base+"/health", nil)
	req.Header = s.hdr
	res, _ := http.DefaultClient.Do(req)
	raw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	raw[len(raw)-2] ^= 1
	rh := sha256.Sum256(raw)
	if hex.EncodeToString(hm(c.skey, "guestd-control/1 resp", c.sid, s.hdr.Get("X-Guestd-Seq"), "200", hex.EncodeToString(rh[:]))) == res.Header.Get("X-Guestd-Response-Mac") {
		t.Fatal("a tampered answer verified")
	}
}

func TestNothingCrossesBetweenInstancesSharingAKey(t *testing.T) {
	_, a := authRig(t)
	rb, b := authRig(t) // a second guestd, the SAME pairing key
	if err := a.handshake(); err != nil {
		t.Fatal(err)
	}
	s := a.sign("GET", "/vms", nil)
	b.sid, b.skey = a.sid, a.skey
	if code, _, _ := b.send(s); code != 401 {
		t.Fatal("A's session was accepted by B")
	}
	// a handshake computed for A's hello, presented to B
	_, ha := a.get("/control/hello")
	if code, got := b.postJSON("/control/session", sessionRequest(testKey, ha, randHex(32))); code != 401 || got["error"] != "not this guestd instance" {
		t.Fatalf("A's handshake at B: %d %v", code, got)
	}
	_, hb := b.get("/control/hello")
	if ha["instance"] == hb["instance"] || hb["instance"] != rb.s.Auth.instance {
		t.Fatal("two guestds sharing a key must still be two instances")
	}
}

func TestSessionsExpireAndARestartForcesAFreshHandshake(t *testing.T) {
	r, c := authRig(t)
	if err := c.handshake(); err != nil {
		t.Fatal(err)
	}
	r.advance(9 * time.Minute)
	if code, _, _ := c.do("GET", "/vms", nil); code != 200 {
		t.Fatal("inside the idle limit")
	}
	r.advance(11 * time.Minute)
	code, got, _ := c.do("GET", "/vms", nil)
	if code != 401 || got["reauth"] != true {
		t.Fatalf("idle expiry must ask for a new handshake: %d %v", code, got)
	}
	if err := c.handshake(); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 7; i++ { // stay active, but past the absolute limit
		r.advance(9 * time.Minute)
		c.do("GET", "/vms", nil)
	}
	if code, got, _ := c.do("GET", "/vms", nil); code != 401 || got["reauth"] != true {
		t.Fatalf("the absolute limit: %d %v", code, got)
	}
	// a restart: a new instance, no sessions
	if err := c.handshake(); err != nil {
		t.Fatal(err)
	}
	r.s.Auth = newControlAuth(testKey, r.s.Now)
	if code, got, _ := c.do("GET", "/vms", nil); code != 401 || got["reauth"] != true {
		t.Fatalf("a session from before the restart: %d %v", code, got)
	}
	if err := c.handshake(); err != nil {
		t.Fatal(err)
	}
	if code, _, ok := c.do("GET", "/vms", nil); code != 200 || !ok {
		t.Fatal("after re-handshaking")
	}
}

func TestTheTablesStayBoundedAndAreSwept(t *testing.T) {
	r, c := authRig(t)
	for i := 0; i < 500; i++ {
		c.get("/control/hello")
	}
	if n, _ := r.s.Auth.counts(); n > 64 {
		t.Fatalf("%d outstanding nonces after 500 unauthenticated hellos", n)
	}
	for i := 0; i < 20; i++ {
		if err := c.handshake(); err != nil {
			t.Fatal(err)
		}
	}
	if _, s := r.s.Auth.counts(); s > 8 {
		t.Fatalf("%d sessions", s)
	}
	if code, _, _ := c.do("GET", "/vms", nil); code != 200 {
		t.Fatal("the newest session was evicted")
	}
	r.advance(2 * time.Hour)
	r.s.Auth.sweep()
	if n, s := r.s.Auth.counts(); n != 0 || s != 0 {
		t.Fatalf("after the sweep: %d nonces, %d sessions", n, s)
	}
}

func TestAKeyFileMustBePrivateAndWellFormed(t *testing.T) {
	d := t.TempDir()
	good := filepath.Join(d, "k")
	if _, err := genKey(good); err != nil {
		t.Fatal(err)
	}
	if _, err := genKey(good); err == nil {
		t.Fatal("gen-key overwrote an existing key")
	}
	k, err := loadKey(good)
	if err != nil || len(k) != 32 {
		t.Fatalf("a generated key: %v", err)
	}
	write := func(name, content string, mode os.FileMode) string {
		p := filepath.Join(d, name)
		_ = os.WriteFile(p, []byte(content), mode)
		_ = os.Chmod(p, mode)
		return p
	}
	hex64s := strings.Repeat("ab", 32)
	for name, p := range map[string]string{
		"group-readable": write("g", hex64s, 0o640),
		"world-readable": write("w", hex64s, 0o604),
		"short":          write("s", hex64s[:62], 0o600),
		"uppercase":      write("u", strings.ToUpper(hex64s), 0o600),
		"all zero":       write("z", strings.Repeat("0", 64), 0o600),
		"trailing junk":  write("j", hex64s+"\nx", 0o600),
	} {
		if _, err := loadKey(p); err == nil {
			t.Errorf("%s key accepted", name)
		}
	}
	link := filepath.Join(d, "l")
	_ = os.Symlink(good, link)
	if _, err := loadKey(link); err == nil {
		t.Error("a symlinked key accepted")
	}
}

// The supervisor's client (control-client.mjs, a second implementation of the protocol) against this server.
func TestTheJSClientInteroperates(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	r, _ := authRig(t)
	lab := newRig(t) // no credentials: the lab mode a client must refuse
	p, _ := r.bundle("A", contract.Policy{})
	out, err := exec.Command("node", "testdata/interop.mjs", r.ts.URL, hex.EncodeToString(testKey), p, lab.ts.URL).CombinedOutput()
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	t.Logf("interop: %s", strings.TrimSpace(string(out)))
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	want := map[string]string{"connect": "ok", "health": "200", "launch": "201 starting", "lease": `200 ["0xjs"]`,
		"replay": "200 then 401", "tampered": "401", "reauth": "200 reconnected"}
	for k, v := range want {
		if s := strings.TrimSuffix(strings.TrimSpace(jsonString(got[k])), ".0"); s != v {
			t.Errorf("%s: got %q, want %q", k, s, v)
		}
	}
	for _, k := range []string{"otherKey", "labMode", "zeroKey"} {
		if !strings.HasPrefix(jsonString(got[k]), "THREW: ") {
			t.Errorf("%s must fail closed: %v", k, got[k])
		}
	}
}

func jsonString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	b, _ := json.Marshal(v)
	return string(b)
}
