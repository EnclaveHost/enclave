package main

import (
	"bytes"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
)

// What releaseForInit hands init (or nothing, if it failed), and whether it provisioned.
func runReleaseForInit(t *testing.T, f *front, hd []byte, hdErr error, prov func() (string, error)) (msg []byte, provisioned bool, err error) {
	t.Helper()
	r, w, perr := os.Pipe()
	if perr != nil {
		t.Fatal(perr)
	}
	defer r.Close()
	err = f.releaseForInit(w, hd, hdErr, func() (string, error) { provisioned = true; return prov() })
	msg, _ = io.ReadAll(r) // EOF: releaseForInit closes its end on every path
	return msg, provisioned, err
}

// enclave-e3's review of 7de792bc, confirmed by enclave-d1: on the M2 SNP path a HOST_DATA read that FAILED was taken
// for "no deployment", so a host that failed the guest's first report request got the app started with no config,
// secrets or allowlist, while every later report (right measurement, right HOST_DATA) looked fine. The read fails once
// here; the domain must end with init handed NOTHING (init then powers the guest off) and no release attempted.
func TestAFailedHostDataReadEndsTheDomainAndStartsNoApp(t *testing.T) {
	f := &front{snp: true}
	msg, provisioned, err := runReleaseForInit(t, f, nil, errors.New("SNP_GUEST_REQUEST failed (the host's answer)"),
		func() (string, error) { return `{"k":"v"}`, nil })
	if err == nil || !strings.Contains(err.Error(), "HOST_DATA unreadable") {
		t.Fatalf("a failed HOST_DATA read must end the domain, got err=%v", err)
	}
	if len(msg) != 0 {
		t.Fatalf("init was handed %q: it would start the app", msg)
	}
	if provisioned {
		t.Fatal("a release was attempted without knowing which deployment this guest serves")
	}
}

func TestTheReleaseDecision(t *testing.T) {
	zero := make([]byte, 32)
	dep := bytes.Repeat([]byte{0xab}, 32)
	ok := func() (string, error) { return `{"api_key":"synthetic"}`, nil }
	cases := []struct {
		name          string
		f             *front
		hd            []byte
		hdErr         error
		prov          func() (string, error)
		wantMsg       string
		wantProv, err bool
	}{
		// a SUCCESSFUL read of all-zero HOST_DATA is the one "none" on the M2 SNP path (a lab / no-deployment guest)
		{"zero HOST_DATA from a good report", &front{snp: true}, zero, nil, ok, "N", false, false},
		{"a deployment's HOST_DATA", &front{snp: true}, dep, nil, ok, `C{"api_key":"synthetic"}`, true, false},
		{"a release that fails", &front{snp: true}, dep, nil, func() (string, error) { return "", errors.New("refused") }, "", true, true},
		{"a HOST_DATA of the wrong length", &front{snp: true}, dep[:31], nil, ok, "", false, true},
		// off the M2 SNP path there is no release at all (T0, a monitor, a plane): unchanged
		{"not SNP", &front{}, nil, errors.New("no hardware report on this tier"), ok, "N", false, false},
		{"an M3 monitor", &front{snp: true, monitor: "/run/m"}, dep, nil, ok, "N", false, false},
	}
	for _, c := range cases {
		msg, provisioned, err := runReleaseForInit(t, c.f, c.hd, c.hdErr, c.prov)
		if (err != nil) != c.err || string(msg) != c.wantMsg || provisioned != c.wantProv {
			t.Errorf("%s: err=%v msg=%q provisioned=%v; want err=%v msg=%q provisioned=%v",
				c.name, err, msg, provisioned, c.err, c.wantMsg, c.wantProv)
		}
	}
}
