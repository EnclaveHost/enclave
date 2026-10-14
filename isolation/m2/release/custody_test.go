package release

import (
	"bytes"
	"strings"
	"testing"
)

func TestCustodyAuthLines(t *testing.T) {
	var id, bind [32]byte
	id[0], bind[31] = 0xd1, 0x7f
	var buf bytes.Buffer
	if err := WriteAuthRequest(&buf, id, bind); err != nil {
		t.Fatal(err)
	}
	gid, gb, err := ReadAuthRequest(&buf)
	if err != nil || gid != id || gb != bind {
		t.Fatalf("request round trip: %v", err)
	}
	sig := "0x" + strings.Repeat("ab", 65)
	buf.Reset()
	if err := WriteAuth(&buf, CustodyAuth{Endpoint: "https://api.enclave.host/t/metal0 x", Sig: sig, Expiry: 1}); err == nil {
		t.Fatal("an endpoint with a space was written")
	}
	if err := WriteAuth(&buf, CustodyAuth{Endpoint: "https://api.enclave.host/t/metal0", Sig: sig, Expiry: 1800000000}); err != nil {
		t.Fatal(err)
	}
	a, err := ReadAuth(&buf)
	if err != nil || a.Endpoint != "https://api.enclave.host/t/metal0" || a.Sig != sig || a.Expiry != 1800000000 {
		t.Fatalf("auth round trip: %+v %v", a, err)
	}
	for _, bad := range []string{
		"custody-auth-v1 0x" + strings.Repeat("d1", 32) + " " + strings.Repeat("AB", 32) + "\n", // uppercase binding
		"custody-auth-v1 " + strings.Repeat("d1", 32) + " " + strings.Repeat("ab", 32) + "\n",   // id without 0x
		"custody-auth-v1 0x" + strings.Repeat("d1", 32) + " " + strings.Repeat("ab", 31) + "\n", // short binding
		"ticket-v1 0x" + strings.Repeat("d1", 32) + " " + strings.Repeat("ab", 32) + "\n",       // another protocol
	} {
		if _, _, err := ReadAuthRequest(strings.NewReader(bad)); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	for _, bad := range []string{
		"custody-sig-v1 aHR0cHM6Ly94 0 " + sig + "\n",
		"custody-sig-v1 aHR0cHM6Ly94 5 0x" + strings.Repeat("ab", 64) + "\n",
		"custody-sig-v1 !! 5 " + sig + "\n",
	} {
		if _, err := ReadAuth(strings.NewReader(bad)); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}
