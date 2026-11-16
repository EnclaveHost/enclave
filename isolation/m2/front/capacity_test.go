package main

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"enclave.host/isolation/m2/capacity"
)

func capacityFront(t *testing.T, list string, appSha []byte) (*front, *ecdsa.PrivateKey) {
	t.Helper()
	tlsKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	c, err := loadHostCapacity(list, appSha, tlsKey)
	if err != nil {
		t.Fatal(err)
	}
	app := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(299) }) // the app's own answer
	return &front{capacity: c, app: app}, tlsKey
}

func listFile(t *testing.T, lines ...string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "host-capacity-apps")
	if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func do(f *front, method, path, body string) (int, map[string]string) {
	w := httptest.NewRecorder()
	f.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader(body)))
	var out map[string]string
	json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func TestHostCapacityOnlyForTheImagesCapacityApp(t *testing.T) {
	app, other := bytes.Repeat([]byte{0x11}, 32), bytes.Repeat([]byte{0x22}, 32)
	list := listFile(t, "# the host's capacity app", hex.EncodeToString(app))
	for name, f := range map[string]*front{
		"no list in the image": first(capacityFront(t, filepath.Join(t.TempDir(), "absent"), app)),
		"another app":          first(capacityFront(t, list, other)),
	} {
		if f.capacity != nil {
			t.Fatalf("%s: capacity is on", name)
		}
		for _, p := range []string{capacityKeyPath, capacityWorkPath, capacitySignPath} {
			if code, _ := do(f, "GET", p, ""); code != 299 {
				t.Fatalf("%s: %s did not stay the app's (%d)", name, p, code)
			}
		}
	}
	tlsKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	for _, bad := range []string{"zz", strings.Repeat("11", 31), strings.Repeat("AB", 32)} {
		if _, err := loadHostCapacity(listFile(t, bad), app, tlsKey); err == nil {
			t.Fatalf("a list holding %q was accepted", bad)
		}
	}
}

func first(f *front, _ *ecdsa.PrivateKey) *front { return f }

func TestHostCapacityKeyIsStatedByTheTLSKey(t *testing.T) {
	app := bytes.Repeat([]byte{0x11}, 32)
	f, tlsKey := capacityFront(t, listFile(t, hex.EncodeToString(app)), app)
	code, k := do(f, "GET", capacityKeyPath, "")
	if code != 200 || k["statement"] != "enclave-host-capacity-key/1" {
		t.Fatalf("key: %d %v", code, k)
	}
	addr, err := hex.DecodeString(strings.TrimPrefix(k["address"], "0x"))
	sig, err2 := base64.StdEncoding.DecodeString(k["tlsSignature"])
	if err != nil || err2 != nil || len(addr) != 20 {
		t.Fatalf("key: %v", k)
	}
	var a [20]byte
	copy(a[:], addr)
	digest := sha256.Sum256(capacity.KeyStatement(a))
	if !ecdsa.VerifyASN1(&tlsKey.PublicKey, digest[:], sig) {
		t.Fatal("the statement is not signed by the domain's TLS key")
	}
	if code, _ := do(f, "POST", capacityKeyPath, ""); code != http.StatusMethodNotAllowed {
		t.Fatalf("POST key: %d", code)
	}
	// another start, another key
	g, _ := capacityFront(t, listFile(t, hex.EncodeToString(app)), app)
	if g.capacity.address == f.capacity.address {
		t.Fatal("two starts share a proof key")
	}
	_ = crypto.SHA256
}

func TestHostCapacityAnswersAndSigns(t *testing.T) {
	raw, err := os.ReadFile("../capacity/testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Domain struct {
			ChainID  uint64 `json:"chainId"`
			Contract string
		}
		Messages []struct {
			PrimaryType string
			Values      map[string]string
		}
		Answer struct {
			Challenge json.RawMessage
			Digest    string
		}
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	app := bytes.Repeat([]byte{0x11}, 32)
	f, _ := capacityFront(t, listFile(t, hex.EncodeToString(app)), app)
	body := func(m map[string]any) string {
		m["chainId"], m["contract"] = v.Domain.ChainID, v.Domain.Contract
		b, _ := json.Marshal(m)
		return string(b)
	}
	// the work: the digest is the one the host's own code computes for this challenge
	code, a := do(f, "POST", capacityWorkPath, body(map[string]any{"challenge": v.Answer.Challenge}))
	if code != 200 || a["digest"] != v.Answer.Digest || len(a["signature"]) != 2+130 {
		t.Fatalf("answer: %d %v, want digest %s", code, a, v.Answer.Digest)
	}
	// the other messages are signed; the answer never from a caller's fields, nor a digest, nor anything unknown
	for _, m := range v.Messages {
		code, s := do(f, "POST", capacitySignPath, body(map[string]any{"primaryType": m.PrimaryType, "message": m.Values}))
		if m.PrimaryType == "CapacityAnswer" {
			if code != 400 {
				t.Fatalf("a CapacityAnswer was signed from a caller's fields (%d)", code)
			}
			continue
		}
		if code != 200 || len(s["signature"]) != 2+130 {
			t.Fatalf("%s: %d %v", m.PrimaryType, code, s)
		}
	}
	for name, b := range map[string]string{
		"a digest":            body(map[string]any{"digest": v.Answer.Digest}),
		"an unknown message":  body(map[string]any{"primaryType": "Permit", "message": map[string]string{"owner": "0x00"}}),
		"a challenge to sign": body(map[string]any{"primaryType": "CapacityReport", "message": v.Messages[2].Values, "challenge": v.Answer.Challenge}),
		"no domain":           `{"primaryType":"CapacityReport","message":{}}`,
		"not JSON":            "x",
	} {
		if code, _ := do(f, "POST", capacitySignPath, b); code != 400 {
			t.Fatalf("%s was not refused on the sign path (%d)", name, code)
		}
	}
	for name, b := range map[string]string{
		"no challenge":       body(map[string]any{}),
		"a message":          body(map[string]any{"primaryType": "CapacityReport", "message": v.Messages[2].Values}),
		"work out of bounds": body(map[string]any{"challenge": map[string]any{"Epoch": 1, "Checker": "0x" + strings.Repeat("11", 32), "Target": "0x" + strings.Repeat("22", 32), "Seed": "0x" + strings.Repeat("33", 32), "Nonce": "0x" + strings.Repeat("44", 32), "Rounds": 1, "MemoryMiB": 1, "Lanes": 9999}}),
		"a short checker id": body(map[string]any{"challenge": map[string]any{"Epoch": 1, "Checker": "0x11", "Target": "0x" + strings.Repeat("22", 32), "Seed": "0x" + strings.Repeat("33", 32), "Nonce": "0x" + strings.Repeat("44", 32), "Rounds": 1, "MemoryMiB": 1, "Lanes": 1}}),
	} {
		if code, _ := do(f, "POST", capacityWorkPath, b); code != 400 {
			t.Fatalf("%s was not refused on the work path (%d)", name, code)
		}
	}
	if code, _ := do(f, "GET", capacityWorkPath, ""); code != http.StatusMethodNotAllowed {
		t.Fatalf("GET work: %d", code)
	}
	// one challenge at a time
	f.capacity.work <- struct{}{}
	if code, _ := do(f, "POST", capacityWorkPath, body(map[string]any{"challenge": v.Answer.Challenge})); code != http.StatusServiceUnavailable {
		t.Fatalf("a second challenge at once: %d", code)
	}
}
