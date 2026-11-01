package contract

import (
	"encoding/binary"
	"math"
	"testing"
)

func TestRPCLocalReadyBindingClockAndPurpose(t *testing.T) {
	b := RPCStartBinding{AppID: [32]byte{1}, RuntimeID: [32]byte{2}, Deployment: [32]byte{3}, Nonce: [32]byte{4}}
	r := RPCLocalReady{Binding: b, ObservedMono: 10_000_000_000}
	raw, err := r.Frame()
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseRPCLocalReady(raw)
	if err != nil || parsed != r {
		t.Fatal(parsed, err)
	}
	if err = parsed.Validate(b, r.ObservedMono+RPCLocalReadyFreshnessNS-1); err != nil {
		t.Fatal(err)
	}
	for _, now := range []uint64{r.ObservedMono - 1, r.ObservedMono + RPCLocalReadyFreshnessNS, math.MaxUint64} {
		if parsed.Validate(b, now) == nil {
			t.Fatal("accepted stale/future/overflow clock", now)
		}
	}
	for i := 0; i < 4; i++ {
		wrong := b
		switch i {
		case 0:
			wrong.AppID[0]++
		case 1:
			wrong.RuntimeID[0]++
		case 2:
			wrong.Deployment[0]++
		case 3:
			wrong.Nonce[0]++
		}
		if parsed.Validate(wrong, r.ObservedMono) == nil {
			t.Fatal("accepted wrong binding", i)
		}
	}
	start, _ := b.Frame()
	if _, err = ParseRPCLocalReady(start); err == nil {
		t.Fatal("startup approval used as readiness")
	}
	if _, err = ParseRPCStartBinding(raw); err == nil {
		t.Fatal("readiness used as startup approval")
	}
	for _, bad := range [][]byte{raw[:len(raw)-1], append(append([]byte{}, raw...), 0), append([]byte("ERPCGO01"), raw[8:]...)} {
		if _, err = ParseRPCLocalReady(bad); err == nil {
			t.Fatal("accepted malformed readiness")
		}
	}
	for _, n := range []uint64{0, math.MaxUint64} {
		bad := append([]byte{}, raw...)
		binary.LittleEndian.PutUint64(bad[len(bad)-8:], n)
		if _, err = ParseRPCLocalReady(bad); err == nil {
			t.Fatal("accepted invalid origin")
		}
	}
}
