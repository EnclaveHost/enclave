package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"syscall"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/vsock"
	"enclave.host/isolation/m3/rpcbootstrap"
	"enclave.host/isolation/m3/rpcdomain"
	"enclave.host/isolation/m3/rpcservice"
	"enclave.host/isolation/m3/rpcstorage"
)

// A dedicated RPC monitor retains its single attempt for its entire lifetime.
// No legacy unmount, RemoveAll, retry or reservation-release code may see it.
type rpcDomain struct {
	bootstrap       *rpcbootstrap.Identity
	bootstrapBundle []byte
	brokerMu        sync.Mutex
	broker          *rpcbootstrap.Broker
	brokerStopped   bool
	storage         *rpcstorage.Attempt
	prepared        *rpcdomain.Prepared
	launch          *rpcdomain.Launch
	kill            *os.File
	stop            sync.Once
}

func (m *monitor) initRPCGuest() error {
	if !nativeRPCBuild || m.snp || m.hostPort == 0 || m.plat != "/plat" || m.root != "/domains" || m.baseUID != 5000 || m.native != nil {
		return errors.New("RPC requires its distinct fixed dedicated T0-hv monitor")
	}
	if _, err := rpcservice.OriginalEntryOrigin(m.rpcClock); err != nil {
		return err
	}
	// Actual installed resource verification remains in Prepare, after the
	// independent storage authority/guardian has acknowledged this exact attempt.
	return nil
}
func rpcLoadInput(req request, app []byte) (contract.Manifest, error) {
	if req.Probe || req.Name != "" || req.CPU != 0 && req.CPU != 400 || req.MemMiB != 0 && req.MemMiB != 19456 {
		return contract.Manifest{}, errors.New("RPC accepts fixed measured allocation and owner-direct names only")
	}
	man, _, err := contract.ParseRPC(app)
	return man, err
}
func (m *monitor) loadRPC(br *bufio.Reader, req request) (*domain, error) {
	if err := m.initRPCGuest(); err != nil {
		return nil, err
	}
	if req.Size <= 0 || req.Size > contract.MaxRPCControllerBytes+(1<<20) {
		return nil, errors.New("bounded complete RPC bundle required")
	}
	// Inherit the original sealed interval; load arrival never starts a new one.
	// Bootstrap/host supervision must cover earlier preparation on their clocks.
	origin, err := rpcservice.OriginalEntryOrigin(m.rpcClock)
	if err != nil {
		return nil, err
	}
	app := make([]byte, req.Size)
	if _, err = io.ReadFull(br, app); err != nil {
		return nil, err
	}
	man, err := rpcLoadInput(req, app)
	if err != nil {
		return nil, err
	}
	sum := contract.AppID(app)
	d := &domain{ID: 1, Boot: m.boot, Label: man.Label, AppSha: fmt.Sprintf("%x", sum), appHash: sum, SecretDeployment: man.SecretDeployment, CPU: 400, MemMiB: 19456, Mode: "run", HTTP: 8000, UID: 2105, FrontUID: 1053577, Port: m.basePrt + 1, Ports: append([]string(nil), man.Ports...), exited: make(chan struct{}), inFlight: make(chan struct{}, maxReportsPerDom), rpc: &rpcDomain{}}
	d.AppConfig, err = man.AppConfig()
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	if m.rpcAttempt != nil || m.noDomains != "" {
		m.mu.Unlock()
		return nil, errors.New("RPC guest already consumed or unavailable")
	}
	m.rpcAttempt = d // permanent, including any failed/ambiguous broker response
	m.mu.Unlock()
	fail := func(err error) (*domain, error) {
		if d.rpc.bootstrap != nil {
			d.rpc.bootstrap.Close()
		}
		m.abandon(d, "RPC load failed; storage retained")
		return nil, err
	}
	request, err := rpcstorage.NewRequest(app, origin)
	if err != nil {
		return fail(err)
	}
	runtime, err := rpcservice.InstalledRuntime()
	if err != nil {
		return fail(err)
	}
	identity, err := rpcbootstrap.New(request, runtime)
	if err != nil {
		return fail(err)
	}
	m.mu.Lock()
	d.rpc.bootstrap = identity
	d.rpc.bootstrapBundle = append([]byte(nil), app...)
	m.mu.Unlock()
	// The loaded app is now available for a bootstrap-purpose challenge. Its
	// credential is generated here, not accepted from the host. Wait is covered
	// by PID1's original deadline; no mount or app child exists yet.
	if err = identity.Wait(); err != nil {
		return fail(err)
	}
	d.rpc.storage, err = rpcstorage.AcquireRequest(app, request)
	if err != nil {
		return fail(err)
	}
	d.rpc.prepared, err = rpcdomain.Prepare(app, origin)
	if err != nil {
		return fail(err)
	}
	d.rpc.launch, err = d.rpc.prepared.ComposeCommand(app, rpcdomain.StateVolume{LogicalID: man.RPC.L1VolumeID, Root: d.rpc.storage.L1}, rpcdomain.StateVolume{LogicalID: man.RPC.BaseVolumeID, Root: d.rpc.storage.Base})
	if err != nil {
		return fail(err)
	}
	l := d.rpc.launch
	d.dir = l.Composition.Path
	// Exact held group, opened once and never closed while cleanup is uncertain.
	fd, err := syscall.Openat(int(l.Capabilities.Groups.Parent.Fd()), "cgroup.kill", syscall.O_WRONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return fail(err)
	}
	d.rpc.kill = os.NewFile(uintptr(fd), "rpc-domain-kill")
	select {
	case <-d.rpc.storage.Loss():
		return fail(errors.New("storage grant lost before Start"))
	default:
	}
	ln, err := vsock.Listen(d.Port)
	if err != nil {
		return fail(err)
	}
	// register() inside launch precedes the first front instruction. Only its
	// fixed UID can obtain app-bound reports; native clients have distinct UIDs.
	go func() { <-d.rpc.storage.Loss(); m.retire(d, "RPC storage authority/deadline lost; retained") }()
	if err = m.launch(d, l.Cmd, ln); err != nil {
		return nil, err
	}
	return d, nil // process launched, NOT chain readiness, serving adoption or ledger Running
}
func (d *domain) releaseRPC() {
	d.rpc.brokerMu.Lock()
	d.rpc.brokerStopped = true
	d.rpc.broker.Stop()
	d.rpc.brokerMu.Unlock()
	if d.rpc.bootstrap != nil {
		d.rpc.bootstrap.Close()
	}
	if d.ln != nil {
		_ = d.ln.Close()
	}
	d.rpc.stop.Do(func() {
		if d.rpc.kill != nil {
			if _, err := d.rpc.kill.Write([]byte("1")); err != nil {
				fmt.Printf("MON RPC kill uncertain; all resources retained\n")
			}
		}
	})
	// Deliberately keep mounts, groups, owner/storage capabilities and all COWs.
	// Even known local death alone cannot establish clean DB/writer settlement.
}
