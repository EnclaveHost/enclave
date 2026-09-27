package main

import (
	"context"
	"enclave.host/isolation/contract"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHistoricalRuntimePins(t *testing.T) {
	dir := t.TempDir()
	now, old := chainRuntime, chainRuntime
	old.Version = "historic-48"
	files := []string{filepath.Join(dir, "new.json"), filepath.Join(dir, "old.json")}
	for i, r := range []contract.RuntimeIdentity{now, old} {
		b, _ := json.Marshal(r)
		if e := os.WriteFile(files[i], b, 0600); e != nil {
			t.Fatal(e)
		}
	}
	release := strings.Repeat("ab", 32)
	pins, e := parseRuntimePins(release + "=" + files[1])
	if e != nil {
		t.Fatal(e)
	}
	l := &realLauncher{runtimeIdentity: files[0], runtimePins: pins}
	oldID, _ := runtimeFileID(files[1])
	newID, _ := runtimeFileID(files[0])
	id, e := l.RuntimeForReleases([]string{release})
	if e != nil || id != oldID || id == newID {
		t.Fatal(id, e)
	}
	if _, e = l.RuntimeForReleases([]string{release, strings.Repeat("cd", 32)}); e == nil {
		t.Fatal("ambiguous releases accepted")
	}
	if _, e = parseRuntimePins(release + "=" + files[1] + "," + release + "=" + files[0]); e == nil {
		t.Fatal("duplicate pin accepted")
	}
	s := newServer(l, dir)
	s.RuntimeID = newID
	v := &vm{RuntimeID: oldID}
	if s.view(v)["runtimeId"] != oldID {
		t.Fatal("adopted identity relabelled")
	}
}

// A restart with a newer default runtime must keep the runtime that was
// independently pinned and verified for an existing guest.
type historicalLauncher struct {
	Launcher
	rid string
}

func (l historicalLauncher) RuntimeForReleases([]string) (string, error) { return l.rid, nil }
func TestAdoptHistoricalRuntime(t *testing.T) {
	r := newRig(t)
	p, _ := r.bundle("old-runtime", contract.Policy{})
	code, body := r.create("0x"+strings.Repeat("ab", 32), p)
	if code != 201 {
		t.Fatal(code, body)
	}
	r.s.launching.Wait()
	id := body["id"].(string)
	old := strings.Repeat("48", 32)
	s := newServer(historicalLauncher{r.f, old}, r.s.Root)
	s.RuntimeID = strings.Repeat("49", 32)
	if why := s.adoptOne(context.Background(), filepath.Join(r.s.Root, id)); why != "" {
		t.Fatal(why)
	}
	v := s.vms[id]
	if s.vmRuntime(v) != old {
		t.Fatal("historical runtime lost")
	}
	defer v.stopFwd()
}
