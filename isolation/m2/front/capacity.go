package main

// A host's proof key and its answer to a capacity check, in this domain (isolation/m2/capacity has the why and the
// rules). OFF unless the IMAGE says this domain's app is the host's capacity app: the file -host-capacity-apps (in the
// measured initrd) lists app ids, and this front serves the three paths below only when its own app is on that list.
// Every image without the file, and every domain running any other app, leaves the paths to the app as before, so no
// customer's domain can be made to burn its processors or to sign for a host.
//
//	GET  /.well-known/enclave-capacity-key    the proof key's address, signed by this domain's TLS key
//	POST /.well-known/enclave-capacity        a capacity challenge: the work is done here and the answer signed here
//	POST /.well-known/enclave-capacity-sign   one of the capacity contract's other messages, assembled and signed here
//
// A verifier ties the proof key to this domain in two steps: the attestation document (/.well-known/enclave-attestation)
// binds this domain's TLS key in a hardware report for this app and image, and the key statement is signed by that TLS
// key. The proof key is made at start and lives in this process only: a restarted domain has another one, and the host
// publishes it again (the registry's proof key).
//
// Whether a checker may ask is the HOST's to decide (it reads the contract; this domain has no chain). So the host can
// ask this domain for any amount of work within the bounds, and gets what it asked: a correct answer to that challenge.

import (
	"crypto"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"

	"enclave.host/isolation/m2/capacity"
)

const (
	capacityKeyPath  = "/.well-known/enclave-capacity-key"
	capacityWorkPath = "/.well-known/enclave-capacity"
	capacitySignPath = "/.well-known/enclave-capacity-sign"
)

type hostCapacity struct {
	key       *capacity.Key
	address   string // 0x + 40 hex
	statement string // base64 of the TLS key's signature (ASN.1 DER) over capacity.KeyStatement
	work      chan struct{}
}

// loadHostCapacity: nil unless `list` names this domain's app. A list that cannot be read as app ids, or a key that
// cannot be made or stated, ends the domain: a capacity domain that is silently not one would answer nothing.
func loadHostCapacity(list string, appSha []byte, tlsKey crypto.Signer) (*hostCapacity, error) {
	raw, err := os.ReadFile(list)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	mine := false
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		id, err := hex.DecodeString(line)
		if err != nil || len(id) != 32 || strings.ToLower(line) != line {
			return nil, fmt.Errorf("%s: %q is not an app id", list, line)
		}
		mine = mine || string(id) == string(appSha)
	}
	if !mine {
		return nil, nil
	}
	key, err := capacity.NewKey()
	if err != nil {
		return nil, err
	}
	addr := key.Address()
	digest := sha256.Sum256(capacity.KeyStatement(addr))
	sig, err := tlsKey.Sign(rand.Reader, digest[:], crypto.SHA256)
	if err != nil {
		return nil, err
	}
	return &hostCapacity{key: key, address: "0x" + hex.EncodeToString(addr[:]), statement: base64.StdEncoding.EncodeToString(sig), work: make(chan struct{}, 1)}, nil
}

func (c *hostCapacity) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	answer := func(status int, v any) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(v)
	}
	refuse := func(status int, why string) { answer(status, map[string]string{"error": why}) }
	if r.URL.Path == capacityKeyPath {
		if r.Method != http.MethodGet {
			refuse(http.StatusMethodNotAllowed, "GET only")
			return
		}
		answer(http.StatusOK, map[string]string{"address": c.address, "statement": "enclave-host-capacity-key/1", "tlsSignature": c.statement})
		return
	}
	if r.Method != http.MethodPost {
		refuse(http.StatusMethodNotAllowed, "POST only")
		return
	}
	var req struct {
		ChainID     uint64            `json:"chainId"`
		Contract    string            `json:"contract"`
		PrimaryType string            `json:"primaryType"`
		Message     map[string]string `json:"message"`
		Challenge   *struct {
			Epoch                        uint64
			Checker, Target, Seed, Nonce string
			Rounds, MemoryMiB, Lanes     int
		} `json:"challenge"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		refuse(http.StatusBadRequest, "not a capacity request")
		return
	}
	contract, err := hex.DecodeString(strings.TrimPrefix(req.Contract, "0x"))
	if err != nil || len(contract) != 20 || !strings.HasPrefix(req.Contract, "0x") || req.ChainID == 0 {
		refuse(http.StatusBadRequest, "chain id and contract address required")
		return
	}
	d := capacity.Domain{ChainID: req.ChainID}
	copy(d.Contract[:], contract)
	hx := func(b []byte) string { return "0x" + hex.EncodeToString(b) }
	if r.URL.Path == capacitySignPath {
		if req.Challenge != nil {
			refuse(http.StatusBadRequest, "a challenge is answered on the work path")
			return
		}
		sig, err := c.key.SignMessage(d, req.PrimaryType, req.Message)
		if err != nil {
			refuse(http.StatusBadRequest, err.Error())
			return
		}
		answer(http.StatusOK, map[string]string{"signature": hx(sig[:])})
		return
	}
	ch := req.Challenge
	if ch == nil || req.PrimaryType != "" || req.Message != nil {
		refuse(http.StatusBadRequest, "a challenge required")
		return
	}
	var words [4][32]byte
	for i, s := range []string{ch.Checker, ch.Target, ch.Seed, ch.Nonce} {
		b, err := hex.DecodeString(strings.TrimPrefix(s, "0x"))
		if err != nil || len(b) != 32 || !strings.HasPrefix(s, "0x") {
			refuse(http.StatusBadRequest, "checker, target, seed and nonce are 32 bytes each")
			return
		}
		copy(words[i][:], b)
	}
	select { // one challenge at a time: the lanes are sized to the whole domain
	case c.work <- struct{}{}:
		defer func() { <-c.work }()
	default:
		refuse(http.StatusServiceUnavailable, "busy with another check")
		return
	}
	digest, sig, err := c.key.Answer(d, capacity.Challenge{Epoch: ch.Epoch, Checker: words[0], Target: words[1], Seed: words[2], Nonce: words[3],
		Rounds: ch.Rounds, MemoryMiB: ch.MemoryMiB, Lanes: ch.Lanes})
	if err != nil {
		refuse(http.StatusBadRequest, err.Error())
		return
	}
	answer(http.StatusOK, map[string]string{"digest": hx(digest[:]), "signature": hx(sig[:])})
}
