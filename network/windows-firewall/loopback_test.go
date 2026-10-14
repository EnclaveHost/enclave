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
	got := staleLoopbackSIDs(listing)
	if want := []string{"S-1-15-2-111-222", "S-1-15-2-777-888"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	// a SID line without a NOT FOUND name just before it (a malformed or reordered listing) is never pruned
	if got := staleLoopbackSIDs("Name: AppContainer NOT FOUND\n\nSID: S-1-15-2-9\n"); len(got) != 0 {
		t.Fatalf("pruned across a block boundary: %v", got)
	}
	if got := staleLoopbackSIDs("Name: AppContainer NOT FOUND\nSID: S-1-5-18\n"); len(got) != 0 {
		t.Fatalf("pruned a non-AppContainer SID: %v", got)
	}
}
