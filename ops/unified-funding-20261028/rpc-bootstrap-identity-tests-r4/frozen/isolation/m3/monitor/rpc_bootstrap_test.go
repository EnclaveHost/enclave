package main

import (
	"enclave.host/isolation/contract"
	"enclave.host/isolation/m3/rpcbootstrap"
	"enclave.host/isolation/m3/rpcservice"
	"strings"
	"testing"
	"time"
)

func TestRPCBootstrapControlRequiresActualGuestTPM(t *testing.T) {
	m := newMonitor(false, "/plat", "/domains", 40000, 5000)
	if _, e := m.rpcBootstrap(request{Cmd: "rpc-bootstrap-info"}); e == nil {
		t.Fatal("no loaded attempt")
	}
	now, _ := rpcservice.MonotonicNow()
	req := contract.RPCStorageRequest{AppID: strings.Repeat("a", 64), BaseVolume: strings.Repeat("b", 64), L1Volume: strings.Repeat("c", 64), Profile: strings.Repeat("d", 64), Nonce: strings.Repeat("e", 64), Deployment: "0x" + strings.Repeat("f", 64), Boot: "11111111-2222-3333-4444-555555555555", Origin: now, Deadline: now + uint64(900*time.Second), Schema: contract.RPCStorageRequestSchema}
	rt := contract.RuntimeIdentity{Name: "wasmtime", Version: "49.0.3", Execution: contract.ExecJIT, TargetISA: contract.ISAx86_64, HostISA: contract.ISAx86_64, CPUFeatures: "baseline", WX: contract.WXEnforced, Cache: contract.CacheNone}
	identity, e := rpcbootstrap.New(req, rt)
	if e != nil {
		t.Fatal(e)
	}
	defer identity.Close()
	m.rpcAttempt = &domain{rpc: &rpcDomain{bootstrap: identity}}
	p, _ := identity.Public()
	_, e = m.rpcBootstrap(request{Cmd: "rpc-bootstrap-info"})
	if nativeRPCBuild && e != nil {
		t.Fatal(e)
	}
	if !nativeRPCBuild && e == nil {
		t.Fatal("ordinary monitor exposed bootstrap")
	}
	if _, e = m.rpcBootstrap(request{Cmd: "rpc-bootstrap-attest", Boot: p.Request.Boot, RequestSHA256: p.RequestSHA256, Challenge: strings.Repeat("7", 64)}); e == nil {
		t.Fatal("missing TPM accepted")
	}
	if _, e = m.rpcBootstrap(request{Cmd: "rpc-bootstrap-acquire", Boot: p.Request.Boot, RequestSHA256: p.RequestSHA256}); e == nil {
		t.Fatal("missing report released")
	}
}
