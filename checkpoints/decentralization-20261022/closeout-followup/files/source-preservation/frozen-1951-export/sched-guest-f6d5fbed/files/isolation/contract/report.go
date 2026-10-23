package contract

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
)

// What a report BINDS, on every backend:
//
//	report_data[0:32]  = bind   = sha256(domain key SPKI DER || verifier nonce)   computed IN the domain
//	report_data[32:64] = app ID from the MONITOR's table for the caller               never from the caller
//
// On SEV-SNP the PSP signs report_data (format FormatSNP). Where no hardware signs, the platform's
// monitor signs a document carrying report_data (FormatHyperV: the Windows launcher's Ed25519 key).
// The bytes bound are identical, so one verifier rule covers every tier.
const (
	NonceLen = 32

	TierSNP    = "T1"
	TierNone   = "T0"
	TierHyperV = "T0-hv"

	FormatSNP    = "sev-snp-guest-domain-v1"
	FormatNone   = "none"
	FormatHyperV = "hyperv-partition-domain/v1"
)

var ErrNonceLen = errors.New("nonce must be 32 bytes")

func Bind(spki, nonce []byte) ([32]byte, error) {
	if len(nonce) != NonceLen {
		return [32]byte{}, ErrNonceLen
	}
	h := sha256.New()
	h.Write(spki)
	h.Write(nonce)
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out, nil
}

func ReportData(bind, appID [32]byte) [64]byte {
	var rd [64]byte
	copy(rd[:32], bind[:])
	copy(rd[32:], appID[:])
	return rd
}

// ReportRequest is everything a domain may say when it asks for a report. There is deliberately no
// field for the app: the app is not the domain's to state.
type ReportRequest struct {
	Bind string `json:"bind"`
}

// ParseReportRequest reads a request and returns its binding. Any other field the caller sent -- an
// app hash, an id, a label -- is not an error and is not read: a caller that tries to name another
// app gets a report naming its own.
func ParseReportRequest(b []byte) ([32]byte, error) {
	var r ReportRequest
	if err := json.Unmarshal(b, &r); err != nil {
		return [32]byte{}, err
	}
	raw, err := hex.DecodeString(r.Bind)
	if err != nil || len(raw) != 32 {
		return [32]byte{}, errors.New("bind must be 32 bytes of hex")
	}
	var out [32]byte
	copy(out[:], raw)
	return out, nil
}
