//go:build linux && amd64

package main

import (
	"bytes"
	"encoding/json"
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

func TestBrokerOwnerStreamPreservesExactSignedBytesAndRefusesDowngrade(t *testing.T) {
	proof := []byte(`{ "schema":"test", "base":"fixture", "l1":"fixture" }`)
	m := map[string]any{"schema": "enclave-rpc-owner-dispatched/2", "attempt": "fixture", "proof": proof, "exporter": map[string]any{}, "rpcReady": false, "writersFenced": false, "reservationMayRelease": false}
	raw, _ := json.Marshal(m)
	got, e := decodeOwnerDispatch(raw, true)
	if e != nil || !bytes.Equal(got, proof) {
		t.Fatal("proof bytes changed", e)
	}
	for _, mode := range []string{"schema", "object-proof", "missing", "release", "oversize"} {
		v := map[string]any{}
		for k, x := range m {
			v[k] = x
		}
		switch mode {
		case "schema":
			v["schema"] = "enclave-rpc-owner-dispatched/1"
		case "object-proof":
			v["proof"] = json.RawMessage(proof)
		case "missing":
			delete(v, "writersFenced")
		case "release":
			v["reservationMayRelease"] = true
		case "oversize":
			v["proof"] = make([]byte, 2049)
		}
		bad, _ := json.Marshal(v)
		if _, e = decodeOwnerDispatch(bad, true); e == nil {
			t.Fatal(mode)
		}
	}
	if _, e = decodeOwnerDispatch(raw, false); e == nil {
		t.Fatal("unsigned protocol upgrade")
	}
}
