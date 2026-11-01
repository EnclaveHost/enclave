package contract

import (
	"encoding/hex"
	"errors"
	"math"
	"strings"
)

const RPCStorageRequestSchema = "enclave-rpc-storage-acquire/1"
const RPCStartupNanoseconds uint64 = 900_000_000_000

// RPCStorageRequest contains identity, never a host path or an authorization
// assertion. Canonical JSON field order is part of the signed request digest.
type RPCStorageRequest struct {
	AppID      string `json:"appId"`
	BaseVolume string `json:"baseVolume"`
	Boot       string `json:"boot"`
	Deadline   uint64 `json:"deadlineMonotonicNs"`
	Deployment string `json:"deployment"`
	L1Volume   string `json:"l1Volume"`
	Nonce      string `json:"nonce"`
	Origin     uint64 `json:"originMonotonicNs"`
	Profile    string `json:"profile"`
	Schema     string `json:"schema"`
}

func (r RPCStorageRequest) Validate() error {
	for _, h := range []string{r.AppID, r.BaseVolume, r.L1Volume, r.Profile, r.Nonce} {
		if !NonzeroHash(h) {
			return errors.New("invalid storage request identity")
		}
	}
	if !strings.HasPrefix(r.Deployment, "0x") || !NonzeroHash(strings.TrimPrefix(r.Deployment, "0x")) || r.Schema != RPCStorageRequestSchema || r.BaseVolume == r.L1Volume || r.Origin > math.MaxInt64-RPCStartupNanoseconds || r.Deadline != r.Origin+RPCStartupNanoseconds {
		return errors.New("invalid original storage request")
	}
	if len(r.Boot) != 36 || r.Boot[8] != '-' || r.Boot[13] != '-' || r.Boot[18] != '-' || r.Boot[23] != '-' || strings.ToLower(r.Boot) != r.Boot {
		return errors.New("invalid storage boot identity")
	}
	b, e := hex.DecodeString(strings.ReplaceAll(r.Boot, "-", ""))
	if e != nil || len(b) != 16 {
		return errors.New("invalid storage boot identity")
	}
	var nonzero byte
	for _, v := range b {
		nonzero |= v
	}
	if nonzero == 0 {
		return errors.New("zero storage boot identity")
	}
	return nil
}
