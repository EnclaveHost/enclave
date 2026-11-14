package main

import (
	"reflect"
	"testing"
)

func TestStaleLoopbackSIDs(t *testing.T) {
	listing := "\r\nList Loopback Exempted AppContainers\r\n\r\n" +
		"[1] -----------------------------------------------------------------\r\n    Name: AppContainer NOT FOUND\r\n    SID:  S-1-15-2-111-222\r\n\r\n" +
		"[2] -----------------------------------------------------------------\r\n    Name: enclave.circuit.0123456789abcdef0123456789abcdef\r\n    SID:  S-1-15-2-333-444\r\n\r\n" +
		"[3] -----------------------------------------------------------------\r\n    Name: microsoft.windows.someapp\r\n    SID:  S-1-15-2-555\r\n\r\n" +
		"[4] -----------------------------------------------------------------\r\n    Name: AppContainer NOT FOUND\r\n    SID:  S-1-15-2-777-888\r\n\r\nOK.\r\n"
	never := func(circuit, sid string) bool { t.Fatalf("asked about %s %s", circuit, sid); return true }
	got := staleLoopbackSIDs(listing, func(circuit, sid string) bool { return circuit == "" })
	if want := []string{"S-1-15-2-111-222", "S-1-15-2-777-888"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	// one of this host's circuits is pruned when it no longer runs, whatever the spelling of its name; a NOT FOUND
	// entry that still runs (another account's circuit) is kept; another program's AppContainer is not asked about
	var asked []string
	got = staleLoopbackSIDs(listing+"    Name: Enclave.Circuit.FEDCBA9876543210FEDCBA9876543210\r\n    SID:  S-1-15-2-999\r\n", func(circuit, sid string) bool {
		asked = append(asked, circuit+" "+sid)
		return sid == "S-1-15-2-333-444" || sid == "S-1-15-2-777-888"
	})
	if want := []string{"S-1-15-2-333-444", "S-1-15-2-777-888"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if want := []string{" S-1-15-2-111-222", "0123456789abcdef0123456789abcdef S-1-15-2-333-444", " S-1-15-2-777-888", "fedcba9876543210fedcba9876543210 S-1-15-2-999"}; !reflect.DeepEqual(asked, want) {
		t.Fatalf("asked %v, want %v", asked, want)
	}
	for _, name := range []string{"enclave.circuit.0123", "enclave.circuit.0123456789abcdef0123456789abcdef.x", "xenclave.circuit.0123456789abcdef0123456789abcdef"} {
		if got := staleLoopbackSIDs("Name: "+name+"\nSID: S-1-15-2-9\n", never); len(got) != 0 {
			t.Fatalf("pruned %s: %v", name, got)
		}
	}
	if got := staleLoopbackSIDs("Name: enclave.circuit.0123456789abcdef0123456789abcdef\nSID: S-1-5-18\n", never); len(got) != 0 {
		t.Fatalf("pruned a non-AppContainer SID: %v", got)
	}
	// a SID line without a NOT FOUND name just before it (a malformed or reordered listing) is never pruned
	if got := staleLoopbackSIDs("Name: AppContainer NOT FOUND\n\nSID: S-1-15-2-9\n", never); len(got) != 0 {
		t.Fatalf("pruned across a block boundary: %v", got)
	}
	if got := staleLoopbackSIDs("Name: AppContainer NOT FOUND\nSID: S-1-5-18\n", never); len(got) != 0 {
		t.Fatalf("pruned a non-AppContainer SID: %v", got)
	}
}
