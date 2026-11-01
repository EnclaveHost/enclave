package main

import (
	"enclave.host/isolation/m3/rpcbootstrap"
	"encoding/hex"
	"errors"
)

// Host transport is untrusted. It may forward an owner's fresh challenge or
// cause denial of service; it cannot choose the loaded app, key or request.
func (m *monitor) rpcBootstrap(req request) (any, error) {
	if !nativeRPCBuild || m.snp {
		return nil, errors.New("dedicated RPC bootstrap required")
	}
	m.mu.Lock()
	d := m.rpcAttempt
	var identity *rpcbootstrap.Identity
	if d != nil && d.rpc != nil {
		identity = d.rpc.bootstrap
	}
	m.mu.Unlock()
	if identity == nil {
		return nil, errors.New("RPC bootstrap has no loaded attempt")
	}
	switch req.Cmd {
	case "rpc-bootstrap-info":
		return identity.Public()
	case "rpc-bootstrap-attest":
		nonce, err := hex.DecodeString(req.Challenge)
		if err != nil || len(nonce) != 32 || hex.EncodeToString(nonce) != req.Challenge {
			return nil, errors.New("canonical verifier challenge required")
		}
		if m.vtpm == nil {
			return nil, errors.New("actual guest TPM required; no launcher fallback")
		}
		return identity.Attest(req.Boot, req.RequestSHA256, nonce, m.vtpm.Report)
	case "rpc-bootstrap-acquire":
		d.rpc.brokerMu.Lock()
		defer d.rpc.brokerMu.Unlock()
		if d.rpc.brokerStopped || d.rpc.broker != nil {
			return nil, errors.New("RPC broker launch consumed")
		}
		broker, err := identity.StartBroker(req.Boot, req.RequestSHA256, m.rpcClock, d.rpc.bootstrapBundle)
		d.rpc.broker = broker // retain exact handles even on ambiguous failure
		if err != nil {
			return nil, err
		}
		if err := identity.Acquire(req.Boot, req.RequestSHA256); err != nil {
			broker.Stop()
			return nil, err
		}
		return map[string]any{"acquisitionRequested": true, "rootsGranted": false, "rpcReady": false}, nil
	}
	return nil, errors.New("unknown bootstrap operation")
}
