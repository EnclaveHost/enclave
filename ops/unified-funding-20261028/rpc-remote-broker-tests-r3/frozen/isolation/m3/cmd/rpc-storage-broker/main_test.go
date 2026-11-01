//go:build linux && amd64

package main

import (
	"os"
	"testing"
)

func TestBrokerCanonicalPolicyAndResponses(t *testing.T) {
	type value struct {
		Schema string `json:"schema"`
		Ready  bool   `json:"ready"`
	}
	for _, raw := range []string{`{"ready":false,"schema":"ok"}`, `{"ready":false,"schema":"ok"}` + "\n"} {
		var v value
		if e := exactJSON([]byte(raw), &v); e != nil {
			t.Fatal(e)
		}
	}
	for _, raw := range []string{`{"schema":"ok","ready":false}`, `{"ready":false,"schema":"ok","schema":"ok"}`, `{"ready":false,"Schema":"ok"}`, `{"schema":"ok"}`, `{"ready":null,"schema":"ok"}`, `{"ready":false,"schema":"ok","extra":0}`, `{"ready":false,"schema":"ok"} {}`} {
		var v value
		if e := exactJSON([]byte(raw), &v); e == nil {
			t.Fatal("ambiguous policy accepted", raw)
		}
	}
}
func TestBrokerProtectedCredentialInputs(t *testing.T) {
	path := t.TempDir() + "/input"
	if e := os.WriteFile(path, []byte("public fixture"), 0600); e != nil {
		t.Fatal(e)
	}
	f, e := os.Open(path)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	if _, e = privateInput(int(f.Fd()), 32); e != nil {
		t.Fatal(e)
	}
	if _, e = privateInput(int(f.Fd()), 2); e == nil {
		t.Fatal("oversized credential")
	}
	if e = os.Chmod(path, 0644); e != nil {
		t.Fatal(e)
	}
	if _, e = privateInput(int(f.Fd()), 32); e == nil {
		t.Fatal("public credential")
	}
	r, w, e := os.Pipe()
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	defer w.Close()
	if _, e = privateInput(int(r.Fd()), 32); e == nil {
		t.Fatal("pipe credential")
	}
}
