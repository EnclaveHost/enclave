package contract

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
)

const RPCBootstrapPurpose = "enclave-rpc-storage-bootstrap/1"

// RPCBootstrapBinding is purpose-separated from serving, secrets release and
// Bind2. The request includes deployment, volumes, boot, nonce and original D.
// The verifier supplies a fresh challenge; neither a report nor this digest is
// storage authorization, a writer fence, an attested running app or readiness.
func RPCBootstrapBinding(req RPCStorageRequest, spki, certificate, challenge []byte, runtime [32]byte) ([32]byte, error) {
	if err := req.Validate(); err != nil {
		return [32]byte{}, err
	}
	if len(spki) < 32 || len(spki) > 4096 || len(certificate) == 0 || len(certificate) > 16384 || len(challenge) != 32 || runtime == [32]byte{} {
		return [32]byte{}, errors.New("bounded bootstrap key, certificate, challenge and runtime required")
	}
	var nonzero byte
	for _, b := range challenge {
		nonzero |= b
	}
	if nonzero == 0 {
		return [32]byte{}, errors.New("zero bootstrap challenge")
	}
	raw, err := json.Marshal(req)
	if err != nil {
		return [32]byte{}, err
	}
	requestSHA, keySHA, certSHA := sha256.Sum256(raw), sha256.Sum256(spki), sha256.Sum256(certificate)
	h := sha256.New()
	h.Write([]byte(RPCBootstrapPurpose + "\n"))
	h.Write(requestSHA[:])
	h.Write(keySHA[:])
	h.Write(certSHA[:])
	h.Write(challenge)
	h.Write(runtime[:])
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out, nil
}
