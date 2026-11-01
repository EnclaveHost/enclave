package rpcstorage

import (
	"enclave.host/isolation/m3/rpcservice"
	"strings"
	"testing"
	"time"
)

func TestPreparedRequestRefusesSubstitutionBeforeNamespace(t *testing.T) {
	b := rpcBundle(t)
	now, _ := rpcservice.MonotonicNow()
	req, e := NewRequest(b, now)
	if e != nil {
		t.Fatal(e)
	}
	for _, mode := range []string{"app", "deployment", "profile", "l1", "base", "boot", "expired"} {
		r := req
		v := strings.Repeat("9", 64)
		switch mode {
		case "app":
			r.AppID = v
		case "deployment":
			r.Deployment = "0x" + v
		case "profile":
			r.Profile = v
		case "l1":
			r.L1Volume = v
		case "base":
			r.BaseVolume = v
		case "boot":
			r.Boot = "11111111-2222-3333-4444-555555555555"
		case "expired":
			r.Origin = now - uint64(901*time.Second)
			r.Deadline = r.Origin + uint64(900*time.Second)
		}
		if _, e := AcquireRequest(b, r); e == nil || !strings.Contains(e.Error(), "prepared storage request differs") {
			t.Fatal(mode, e)
		}
	}
}
