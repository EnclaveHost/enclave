package contract

import (
	"bytes"
	"encoding/binary"
	"errors"
	"math"
)

// RPCLocalReady is a private, one-shot observation from the measured front to
// its supervisor. It is NOT a signed attestation, storage grant, serving permit,
// provider settlement, or ledger Running event. ObservedMono is sampled BEFORE
// the successful health request, on the same unshifted kernel monotonic clock.
type RPCLocalReady struct {
	Binding      RPCStartBinding
	ObservedMono uint64
}

const RPCLocalReadyFrameSize = 8 + RPCStartFrameSize + 8
const RPCLocalReadyFreshnessNS uint64 = 4_000_000_000

func (r RPCLocalReady) Frame() ([]byte, error) {
	b, err := r.Binding.Frame()
	if err != nil || r.ObservedMono == 0 || r.ObservedMono > math.MaxInt64 {
		return nil, errors.New("invalid RPC local readiness observation")
	}
	raw := make([]byte, RPCLocalReadyFrameSize)
	copy(raw, "ERPCRD01")
	copy(raw[8:], b)
	binary.LittleEndian.PutUint64(raw[8+RPCStartFrameSize:], r.ObservedMono)
	return raw, nil
}

func ParseRPCLocalReady(raw []byte) (RPCLocalReady, error) {
	var r RPCLocalReady
	if len(raw) != RPCLocalReadyFrameSize || string(raw[:8]) != "ERPCRD01" {
		return r, errors.New("invalid RPC readiness frame")
	}
	b, err := ParseRPCStartBinding(raw[8 : 8+RPCStartFrameSize])
	if err != nil {
		return r, err
	}
	r.Binding = b
	r.ObservedMono = binary.LittleEndian.Uint64(raw[8+RPCStartFrameSize:])
	canonical, err := r.Frame()
	if err != nil || !bytes.Equal(raw, canonical) {
		return RPCLocalReady{}, errors.New("noncanonical RPC readiness frame")
	}
	return r, nil
}

// Validate checks the whole observation age, including request and IPC time.
// Sample completion cannot refresh a slow or queued observation. The receiver
// additionally owns the original startup deadline and the private descriptor.
func (r RPCLocalReady) Validate(expected RPCStartBinding, now uint64) error {
	if _, err := r.Frame(); err != nil {
		return err
	}
	if r.Binding != expected || now > math.MaxInt64 || now < r.ObservedMono || now-r.ObservedMono >= RPCLocalReadyFreshnessNS {
		return errors.New("RPC readiness identity or freshness mismatch")
	}
	return nil
}
