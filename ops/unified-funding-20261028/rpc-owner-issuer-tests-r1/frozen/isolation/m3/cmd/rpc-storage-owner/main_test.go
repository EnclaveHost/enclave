//go:build linux && amd64

package main

import (
	"os"
	"syscall"
	"testing"
)

func TestOwnerWireRejectsAliasDuplicateMissingAndTrailing(t *testing.T) {
	type row struct {
		Schema string `json:"schema"`
	}
	for _, raw := range []string{`{"Schema":"a"}`, `{"schema":"a","schema":"a"}`, `{}`, `{"schema":"a"} {}`, `{"schema":null}`, `{"schema":"a","unknown":true}`} {
		var out row
		if decode([]byte(raw), &out, true) == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	var out row
	if e := decode([]byte("{\"schema\":\"a\"}\n"), &out, true); e != nil {
		t.Fatal(e)
	}
}

func TestOwnerInputsRequireHeldPrivateReadonlyRegularFile(t *testing.T) {
	path := t.TempDir() + "/seed"
	if e := os.WriteFile(path, make([]byte, 32), 0600); e != nil {
		t.Fatal(e)
	}
	f, e := os.Open(path)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	if b, e := owned(int(f.Fd()), 32); e != nil || len(b) != 32 {
		t.Fatal(e)
	}
	rw, e := os.OpenFile(path, os.O_RDWR, 0)
	if e != nil {
		t.Fatal(e)
	}
	defer rw.Close()
	if _, e = owned(int(rw.Fd()), 32); e == nil {
		t.Fatal("writable seed fd accepted")
	}
	if e = os.Chmod(path, 0644); e != nil {
		t.Fatal(e)
	}
	if _, e = owned(int(f.Fd()), 32); e == nil {
		t.Fatal("public seed accepted")
	}
	r, w, e := os.Pipe()
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	defer w.Close()
	if _, e = owned(int(r.Fd()), 32); e == nil {
		t.Fatal("blocking pipe accepted as key")
	}
	if _, e = owned(-1, 32); e == nil {
		t.Fatal("invalid fd accepted")
	}
	// An invalid input must not close or mutate standard input by fd reuse.
	if _, _, e := syscall.Syscall(syscall.SYS_FCNTL, 0, syscall.F_GETFD, 0); e != 0 {
		t.Fatal(e)
	}
}
