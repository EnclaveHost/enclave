//go:build linux && amd64

package rpcdomain

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"enclave.host/isolation/m3/rpcservice"
)

// Go 1.27 testing.TempDir honors GOTMPDIR, which is the bounded compiler
// work directory on disk here. Claim qualification needs the private tmpfs.
func claimTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "rpc-claim-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Error(err)
		}
	})
	return dir
}

func claimFixture() binding {
	return binding{AppID: strings.Repeat("1", 64), BaseVolume: strings.Repeat("2", 64), Deployment: "0x" + strings.Repeat("3", 64), L1Volume: strings.Repeat("4", 64), Nonce: strings.Repeat("5", 64), Origin: 123, Profile: strings.Repeat("6", 64), Schema: "enclave-rpc-domain-claim/1"}
}
func TestActualConsumedClaimIsExclusiveAndBound(t *testing.T) {
	if os.Getuid() != 0 {
		t.Fatal("requires bounded private user namespace uid0 test runner")
	}
	dir := claimTempDir(t)
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	d, err := os.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	b := claimFixture()
	f, err := consumeClaim(d, b)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(f)
	if err != nil {
		t.Fatal(err)
	}
	var got binding
	if err = json.Unmarshal(raw, &got); err != nil || got != b {
		t.Fatal(got, err)
	}
	if _, err = f.Write([]byte("replace")); err == nil {
		t.Fatal("retained claim descriptor writable")
	}
	if err = f.Close(); err != nil {
		t.Fatal(err)
	}
	b.Nonce = strings.Repeat("7", 64)
	if _, err = consumeClaim(d, b); err == nil {
		t.Fatal("closed original claim replayed")
	}
	again, err := os.ReadFile(filepath.Join(dir, "claimed"))
	if err != nil || string(again) != string(raw) {
		t.Fatal("second claim changed original", err)
	}
}
func TestClaimRejectsPreexistingLinkAndInvalidBinding(t *testing.T) {
	dir := claimTempDir(t)
	os.Chmod(dir, 0700)
	d, err := os.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	b := claimFixture()
	b.L1Volume = b.BaseVolume
	if _, err = consumeClaim(d, b); err == nil {
		t.Fatal("same volumes accepted")
	}
	if _, err = os.Stat(filepath.Join(dir, "claimed")); !os.IsNotExist(err) {
		t.Fatal("invalid binding consumed claim")
	}
	outside := filepath.Join(claimTempDir(t), "outside")
	os.WriteFile(outside, []byte("unchanged"), 0600)
	if err = os.Symlink(outside, filepath.Join(dir, "claimed")); err != nil {
		t.Fatal(err)
	}
	if _, err = consumeClaim(d, claimFixture()); err == nil {
		t.Fatal("symlink adopted")
	}
	raw, _ := os.ReadFile(outside)
	if string(raw) != "unchanged" {
		t.Fatal("external file changed")
	}
}
func TestOriginalWindowCannotResetOrOverflow(t *testing.T) {
	now, err := rpcservice.MonotonicNow()
	if err != nil {
		t.Fatal(err)
	}
	if err = withinOriginal(now); err != nil {
		t.Fatal(err)
	}
	badOrigins := []uint64{^uint64(0), now + uint64(rpcservice.StartupWindow)}
	if now >= uint64(rpcservice.StartupWindow) {
		badOrigins = append(badOrigins, now-uint64(rpcservice.StartupWindow))
	}
	for _, bad := range badOrigins {
		if err = withinOriginal(bad); err == nil {
			t.Fatal("invalid origin accepted", bad)
		}
	}
}
func TestPrepareRefusesNonRPCBeforeClaim(t *testing.T) {
	if _, err := Prepare([]byte("not a bundle"), 0); err == nil {
		t.Fatal("unbound preparation accepted")
	}
}
func TestProtectedDirectoryRefusesWritableAncestorAndSymlink(t *testing.T) {
	if _, err := protectedDirectory(claimTempDir(t)); err == nil {
		t.Fatal("writable /tmp ancestor accepted")
	}
	for _, name := range []string{"relative", "/", "/run/../tmp", "/run//tmp"} {
		if f, err := protectedDirectory(name); err == nil {
			f.Close()
			t.Fatal(name)
		}
	}
}
