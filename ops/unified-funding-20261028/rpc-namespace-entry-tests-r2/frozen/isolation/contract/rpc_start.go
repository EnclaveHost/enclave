package contract

import (
	"bytes"
	"errors"
)

// RPCStartBinding is carried only on private inherited descriptors between the
// measured RPC supervisor and front. It is not a signature, storage permit,
// provider settlement receipt or an externally acceptable authorization.
type RPCStartBinding struct {
	AppID, RuntimeID, Deployment, Nonce [32]byte
}

const RPCStartFrameSize = 136

func (b RPCStartBinding) Frame() ([]byte, error) {
	if b.AppID == [32]byte{} || b.RuntimeID == [32]byte{} || b.Deployment == [32]byte{} || b.Nonce == [32]byte{} {
		return nil, errors.New("RPC start identity and fresh nonce required")
	}
	raw := make([]byte, RPCStartFrameSize)
	copy(raw, "ERPCGO01")
	copy(raw[8:40], b.AppID[:])
	copy(raw[40:72], b.RuntimeID[:])
	copy(raw[72:104], b.Deployment[:])
	copy(raw[104:], b.Nonce[:])
	return raw, nil
}

func ParseRPCStartBinding(raw []byte) (RPCStartBinding, error) {
	var b RPCStartBinding
	if len(raw) != RPCStartFrameSize || string(raw[:8]) != "ERPCGO01" {
		return b, errors.New("invalid RPC start frame")
	}
	copy(b.AppID[:], raw[8:40])
	copy(b.RuntimeID[:], raw[40:72])
	copy(b.Deployment[:], raw[72:104])
	copy(b.Nonce[:], raw[104:])
	canonical, err := b.Frame()
	if err != nil || !bytes.Equal(raw, canonical) {
		return RPCStartBinding{}, errors.New("noncanonical RPC start binding")
	}
	return b, nil
}
