//go:build !releaselab

package release

import "testing"

// The production image trusts exactly the relay keys named here, by keyId, so a changed pins.go entry fails a test
// rather than quietly changing whose signature the guest accepts. A new key (a standby or a rotation) is added in both
// places, on purpose.
var productionRelayKeyIDs = []string{
	"06212e5df9c3779a", // generated on nan 2026-09-25 18:38:21Z (enclave-63, S3b)
}

func TestTheProductionPinsAreExactlyTheRelaysKeys(t *testing.T) {
	keys, err := PinnedRelayKeys()
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) != len(productionRelayKeyIDs) {
		t.Fatalf("the production front pins %d relay key(s), want %d", len(keys), len(productionRelayKeyIDs))
	}
	for i, k := range keys {
		if got := KeyID(k); got != productionRelayKeyIDs[i] {
			t.Fatalf("pinned key %d has keyId %s, want %s", i, got, productionRelayKeyIDs[i])
		}
	}
}
