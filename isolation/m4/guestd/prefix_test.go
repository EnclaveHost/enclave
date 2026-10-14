package main

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"enclave.host/isolation/contract"
)

// A second guestd on a host (a lab one, say) must never sweep the first one's guests: the production canaries are
// m2-gd… units, and a boot sweep that matched them would stop them (found while planning the release lab, 09-25).
func TestASweepStopsOnlyItsOwnPrefixsUnits(t *testing.T) {
	listing := "m2-gd6e734a97-3817590.service loaded active running m2\n" +
		"m2-gdb677d751-3886305.service loaded active running m2\n" +
		"m2-lb0102abcd-4000001.service loaded active running m2\n" +
		"m2-lb99887766-4000002.service loaded active running m2\n"
	lab := (&realLauncher{prefix: "lb"}).unitPrefix()
	got := sweepUnits(listing, lab, map[string]bool{"m2-lb99887766-4000002": true})
	if len(got) != 1 || got[0] != "m2-lb0102abcd-4000001.service" {
		t.Fatalf("a lab guestd would stop %v (it may stop only its own, unkept units)", got)
	}
	prod := (&realLauncher{}).unitPrefix()
	if prod != "m2-gd" {
		t.Fatalf("the default prefix moved: %s", prod)
	}
	for _, u := range sweepUnits(listing, prod, nil) {
		if u[:5] != "m2-gd" {
			t.Fatalf("the production guestd would stop another guestd's unit %s", u)
		}
	}
}

func TestInstanceIDsCarryThePrefixAndAdoptionReadsOnlyThem(t *testing.T) {
	r := newRig(t)
	r.s.IDPrefix = "lb"
	p, _ := r.bundle("A", contract.Policy{})
	_, b := r.create(name(1), p)
	r.s.launching.Wait()
	id := b["id"].(string)
	if !regexp.MustCompile(`^lb[0-9a-f]{8}$`).MatchString(id) {
		t.Fatalf("instance id %q does not carry the lab prefix", id)
	}
	// another guestd's workdir under the same root is not this one's to adopt (and a root is per guestd anyway)
	_ = os.MkdirAll(filepath.Join(r.s.Root, "gd0badf00d"), 0o700)
	s2 := newServer(r.f, r.s.Root)
	s2.IDPrefix, s2.Now, s2.Budget = "lb", r.s.Now, r.s.Budget
	_, adopted, dropped := s2.adoptOnBoot(context.Background())
	for _, x := range append(adopted, dropped...) {
		if strings.HasPrefix(x, "gd0badf00d") {
			t.Fatalf("a guestd with prefix lb looked at a gd instance's workdir: %q", x)
		}
	}
	// a dropped workdir is DELETED (and its unit stopped): another prefix's must survive untouched
	if _, err := os.Stat(filepath.Join(r.s.Root, "gd0badf00d")); err != nil {
		t.Fatalf("a guestd with prefix lb scrubbed a gd instance's workdir: %v", err)
	}
}
