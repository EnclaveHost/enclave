// Package rpcbootstrap holds a guest-created, per-attempt storage credential.
// Public control callers can challenge it but cannot supply or extract its key.
package rpcbootstrap

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"sync"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m3/rpcservice"
)

type Public struct {
	Purpose       string                     `json:"purpose"`
	Request       contract.RPCStorageRequest `json:"request"`
	RequestSHA256 string                     `json:"requestSha256"`
	Runtime       contract.RuntimeIdentity   `json:"runtime"`
	TransportKey  []byte                     `json:"transportKey"`
	Certificate   []byte                     `json:"certificate"`
	RootsGranted  bool                       `json:"rootsGranted"`
	RPCReady      bool                       `json:"rpcReady"`
}
type Evidence struct {
	Public
	Challenge string `json:"challenge"`
	Report    []byte `json:"vbsVmReport"`
}
type Identity struct {
	mu                                                 sync.Mutex
	public                                             Public
	key                                                ed25519.PrivateKey
	reportUsed, reported, acquireUsed, keyUsed, closed bool
	acquire                                            chan struct{}
}

func New(req contract.RPCStorageRequest, runtime contract.RuntimeIdentity) (*Identity, error) {
	if err := req.Validate(); err != nil {
		return nil, err
	}
	if _, err := contract.RuntimeID(runtime); err != nil {
		return nil, err
	}
	if err := current(req); err != nil {
		return nil, err
	}
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	spki, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}
	// A self-signed transport container, never a CA or independent authority.
	// Owner verification pins its exact DER under the hardware report. The guest
	// monotonic deadline remains authoritative even if its wall clock changes.
	now := time.Now()
	tmpl := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "RPC attempt"}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(15 * time.Minute), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}, BasicConstraintsValid: true}
	cert, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, pub, key)
	if err != nil {
		return nil, err
	}
	raw, _ := json.Marshal(req)
	digest := sha256.Sum256(raw)
	return &Identity{public: Public{Purpose: contract.RPCBootstrapPurpose, Request: req, RequestSHA256: hex.EncodeToString(digest[:]), Runtime: runtime, TransportKey: spki, Certificate: cert}, key: key, acquire: make(chan struct{})}, nil
}
func current(req contract.RPCStorageRequest) error {
	now, err := rpcservice.MonotonicNow()
	if err != nil {
		return err
	}
	if now < req.Origin || now >= req.Deadline {
		return errors.New("original bootstrap window ended")
	}
	return nil
}
func (i *Identity) check(boot, digest string) error {
	if i.closed || boot != i.public.Request.Boot || digest != i.public.RequestSHA256 {
		return errors.New("exact active bootstrap attempt required")
	}
	return current(i.public.Request)
}
func (i *Identity) Public() (Public, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if err := i.check(i.public.Request.Boot, i.public.RequestSHA256); err != nil {
		return Public{}, err
	}
	p := i.public
	p.TransportKey = append([]byte(nil), p.TransportKey...)
	p.Certificate = append([]byte(nil), p.Certificate...)
	return p, nil
}

// Attest consumes the one report gate before entering hardware code. A lost or
// failed report cannot be retried. report MUST be the measured monitor's actual
// guest TPM reporter; a host/launcher JSON document is not this evidence.
func (i *Identity) Attest(boot, digest string, challenge []byte, report func([]byte) ([]byte, error)) (Evidence, error) {
	i.mu.Lock()
	if err := i.check(boot, digest); err != nil {
		i.mu.Unlock()
		return Evidence{}, err
	}
	if i.reportUsed || report == nil {
		i.mu.Unlock()
		return Evidence{}, errors.New("bootstrap report missing or consumed")
	}
	rid, err := contract.RuntimeID(i.public.Runtime)
	binding, e := contract.RPCBootstrapBinding(i.public.Request, i.public.TransportKey, i.public.Certificate, challenge, rid)
	if err != nil || e != nil {
		i.mu.Unlock()
		return Evidence{}, errors.New("invalid bootstrap challenge")
	}
	i.reportUsed = true
	p := i.public
	i.mu.Unlock()
	app, _ := hex.DecodeString(p.Request.AppID)
	var appID [32]byte
	copy(appID[:], app)
	rd := contract.ReportData(binding, appID)
	raw, err := report(rd[:])
	if err != nil {
		return Evidence{}, err
	}
	if len(raw) == 0 || len(raw) > 9000 {
		return Evidence{}, errors.New("bounded guest VBS report required")
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	if err = i.check(boot, digest); err != nil {
		return Evidence{}, err
	}
	i.reported = true
	p.TransportKey = append([]byte(nil), p.TransportKey...)
	p.Certificate = append([]byte(nil), p.Certificate...)
	return Evidence{Public: p, Challenge: hex.EncodeToString(challenge), Report: append([]byte(nil), raw...)}, nil
}

// Acquire only permits the monitor to contact its protected local broker.
// It does not authorize storage. The bootstrap coordinator calls this after
// the actual bounded broker's listening receipt, never on a timer or retry.
func (i *Identity) Acquire(boot, digest string) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if err := i.check(boot, digest); err != nil {
		return err
	}
	if !i.reported || i.acquireUsed {
		return errors.New("bootstrap not reported or acquire consumed")
	}
	i.acquireUsed = true
	close(i.acquire)
	return nil
}
func (i *Identity) Wait() error {
	i.mu.Lock()
	req := i.public.Request
	closed := i.closed
	i.mu.Unlock()
	if closed {
		return errors.New("bootstrap closed")
	}
	now, err := rpcservice.MonotonicNow()
	if err != nil || now < req.Origin || now >= req.Deadline {
		return errors.New("original bootstrap window ended")
	}
	timer := time.NewTimer(time.Duration(req.Deadline - now))
	defer timer.Stop()
	select {
	case <-i.acquire:
	case <-timer.C:
		return errors.New("original bootstrap window ended")
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.check(req.Boot, i.public.RequestSHA256)
}

// TakeCredential is only a local measured-TCB handoff, not a wire method. It
// returns the same private key exactly once for the bounded broker launch.
func (i *Identity) TakeCredential() (tls.Certificate, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if err := i.check(i.public.Request.Boot, i.public.RequestSHA256); err != nil {
		return tls.Certificate{}, err
	}
	if !i.reported || i.keyUsed {
		return tls.Certificate{}, errors.New("credential unavailable or consumed")
	}
	i.keyUsed = true
	return tls.Certificate{Certificate: [][]byte{append([]byte(nil), i.public.Certificate...)}, PrivateKey: i.key}, nil
}
func (i *Identity) Close() {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.closed = true
	if !i.acquireUsed {
		i.acquireUsed = true
		close(i.acquire)
	}
}
