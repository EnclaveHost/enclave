//go:build linux && amd64

package rpcservice

import (
	"os"
	"strings"
	"testing"
)

func TestPrepareGroupsCannotAdoptOrdinaryDirectories(t *testing.T) {
	d, err := os.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	for _, nonce := range []string{"", strings.Repeat("0", 64), "../../escape", strings.Repeat("a", 64)} {
		if _, err := PrepareGroups(d, nonce); err == nil {
			t.Fatal("ordinary filesystem accepted")
		}
	}
	entries, err := d.ReadDir(-1)
	if err != nil || len(entries) != 0 {
		t.Fatal("refused preparation mutated directory", entries, err)
	}
	if _, err := PrepareGroups(nil, strings.Repeat("a", 64)); err == nil {
		t.Fatal("missing capability accepted")
	}
}
func TestPreparedGroupsTransferCannotRepeatOrCloseTransferredFDs(t *testing.T) {
	d, err := os.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	p := &PreparedGroups{groups: Groups{Parent: d}}
	g, _, err := p.Take()
	if err != nil || g.Parent != d {
		t.Fatal(err)
	}
	if _, _, err = p.Take(); err == nil {
		t.Fatal("repeated transfer accepted")
	}
	if err = p.Abandon(); err == nil {
		t.Fatal("transferred descriptor closed")
	}
	if _, err = d.Stat(); err != nil {
		t.Fatal("transferred handle no longer live", err)
	}
}
func TestPreparedGroupsAbandonIsTerminal(t *testing.T) {
	d, err := os.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p := &PreparedGroups{groups: Groups{Parent: d}}
	if err = p.Abandon(); err != nil {
		t.Fatal(err)
	}
	if _, err = d.Stat(); err == nil {
		t.Fatal("unused handle not closed")
	}
	if _, _, err = p.Take(); err == nil {
		t.Fatal("abandoned groups transferred")
	}
}
