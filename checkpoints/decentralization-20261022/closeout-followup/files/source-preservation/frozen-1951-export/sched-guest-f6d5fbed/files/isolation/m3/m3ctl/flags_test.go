package main

import "testing"

// The bug this guards: Go's flag package stops at the first non-flag argument, so `m3ctl -cid 3 destroy -id 1`
// left `-id 1` unparsed and -id kept its default of 0 - which silently destroyed DOMAIN 0, a different
// tenant's domain, while reporting success. Refusing is the only safe behaviour: there is no way to guess
// whether the caller meant the flag or the default, and one of those choices destroys the wrong thing.
func TestAFlagAfterTheSubcommandIsRefusedRatherThanIgnored(t *testing.T) {
	for _, tc := range []struct{ args []string; want string }{
		{[]string{"destroy", "-id", "1"}, "-id"},
		{[]string{"stop", "-id", "2"}, "-id"},
		{[]string{"load", "app.wasm", "-probe"}, "-probe"},
		{[]string{"load", "app.wasm", "-label", "A"}, "-label"},
		{[]string{"destroy", "-id=1"}, "-id=1"},
		{[]string{"list", "-cpu", "50"}, "-cpu"},
	} {
		if got := misplacedFlag(tc.args); got != tc.want {
			t.Errorf("misplacedFlag(%q) = %q, want %q", tc.args, got, tc.want)
		}
	}
}

func TestCorrectlyOrderedCommandsArePassedThrough(t *testing.T) {
	for _, args := range [][]string{
		{"destroy"}, {"stop"}, {"list"}, {"state"}, {"load", "app.wasm"}, {"load", "/path/to/app.wasm"},
		{}, // no subcommand: the usage check handles that, not this one
	} {
		if got := misplacedFlag(args); got != "" {
			t.Errorf("misplacedFlag(%q) = %q, want no complaint", args, got)
		}
	}
	// a lone "-" is a path convention, not a flag, and must not be rejected as one
	if got := misplacedFlag([]string{"load", "-"}); got != "" {
		t.Errorf(`misplacedFlag(load -) = %q, want no complaint`, got)
	}
}

func TestTheSuggestedCorrectionDropsTheFlagAndItsValue(t *testing.T) {
	for _, tc := range []struct{ args, want []string }{
		{[]string{"destroy", "-id", "1"}, []string{"destroy"}},
		{[]string{"load", "app.wasm", "-label", "A"}, []string{"load", "app.wasm"}},
		{[]string{"destroy", "-id=1"}, []string{"destroy"}},
		{[]string{"load", "app.wasm", "-probe"}, []string{"load", "app.wasm"}},
	} {
		got := withoutFlags(tc.args)
		if len(got) != len(tc.want) {
			t.Fatalf("withoutFlags(%q) = %q, want %q", tc.args, got, tc.want)
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Fatalf("withoutFlags(%q) = %q, want %q", tc.args, got, tc.want)
			}
		}
	}
}
