//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"github.com/EnclaveHost/enclave/network/tuna/revenueshare"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func endpoint(t *testing.T, value any) string {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": "1", "result": value})
	}))
	t.Cleanup(s.Close)
	return s.URL
}
func TestQuorumDisagreement(t *testing.T) {
	a := endpoint(t, map[string]any{"hash": "a"})
	b := endpoint(t, map[string]any{"hash": "b"})
	c := endpoint(t, map[string]any{"hash": "a"})
	if _, e := quorum[map[string]any](context.Background(), []string{a, b}, "getblock", map[string]any{}); e == nil {
		t.Fatal("accepted disagreement")
	}
	got, e := quorum[map[string]any](context.Background(), []string{a, b, c}, "getblock", map[string]any{})
	if e != nil || got["hash"] != "a" {
		t.Fatal(got, e)
	}
}
func TestJournalIsDurableAndPrivate(t *testing.T) {
	file := filepath.Join(t.TempDir(), "private", "state.json")
	s := revenueshare.State{Gross: 100, Pending: []revenueshare.Pending{{Hash: "exact", Raw: "signed"}}}
	if e := save(file, s); e != nil {
		t.Fatal(e)
	}
	raw, e := os.ReadFile(file)
	if e != nil {
		t.Fatal(e)
	}
	var back revenueshare.State
	if e = json.Unmarshal(raw, &back); e != nil {
		t.Fatal(e)
	}
	if back.Pending[0].Raw != "signed" || back.Gross != 100 {
		t.Fatal(back)
	}
	stat, _ := os.Stat(file)
	if stat.Mode().Perm() != 0600 {
		t.Fatal(stat.Mode())
	}
	if _, e = os.Stat(file + ".tmp"); !os.IsNotExist(e) {
		t.Fatal("uncommitted temporary state")
	}
}
