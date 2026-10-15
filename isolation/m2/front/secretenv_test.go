package main

import (
	"bytes"
	"io"
	"os"
	"strings"
	"testing"
)

// Each staged secret reaches the app as its own variable: the front validates them with init's rules and appends
// them after the config ("\0S" then "NAME=VALUE\0" each), which dominit.c read_front_msg parses
// (isolation/m2/test-dominit-handoff.sh pins the parser).
func TestSecretEnvRules(t *testing.T) {
	env, err := secretEnv(map[string]string{"DB_URL": "postgres://u:p@h/x", "API_KEY": "v1", "EMPTY": ""})
	if err != nil || strings.Join(env, "|") != "API_KEY=v1|DB_URL=postgres://u:p@h/x|EMPTY=" {
		t.Fatalf("sorted entries: %v %v", env, err)
	}
	for _, bad := range []map[string]string{
		{"ENCLAVE_X": "1"}, {"enclave_x": "1"}, {"1A": "1"}, {"A-B": "1"}, {"": "1"}, {"A": "x\ny"}, {"A": "x\ry"}, {"A": "x\x00y"},
		{strings.Repeat("A", 65): "1"}, {"A": strings.Repeat("v", 20480)},
	} {
		if _, err := secretEnv(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	many := map[string]string{}
	for i := 0; i < 65; i++ {
		many["K"+strings.Repeat("x", i)] = "v"
	}
	if _, err := secretEnv(many); err == nil {
		t.Fatal("accepted 65 secrets")
	}
	if env, err := secretEnv(nil); err != nil || len(env) != 0 {
		t.Fatal("no secrets must be no entries")
	}
}

func TestHandToInitAppendsSecrets(t *testing.T) {
	read := func(config string, env []string) []byte {
		r, w, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		go handToInitFull(w, config, false, false, env)
		b, _ := io.ReadAll(r)
		return b
	}
	if got := read(`{"a":1}`, []string{"A=1", "B=two"}); !bytes.Equal(got, []byte("C{\"a\":1}\x00SA=1\x00B=two\x00")) {
		t.Fatalf("with config: %q", got)
	}
	if got := read("", []string{"T=x"}); !bytes.Equal(got, []byte("N\x00ST=x\x00")) {
		t.Fatalf("without config: %q", got)
	}
	if got := read("{}", nil); !bytes.Equal(got, []byte("C{}")) {
		t.Fatalf("no secrets is the old message: %q", got)
	}
}
