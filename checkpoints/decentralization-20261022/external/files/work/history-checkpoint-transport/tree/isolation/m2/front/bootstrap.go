package main

// Direct startup has a distinct entry point; it never consumes a relay ticket
// or falls back to a signed release. The measured entry point/transport still
// needs activation as a new runtime before any production deployment uses it.
import (
	"context"
	"enclave.host/isolation/m2/appconfig"
	"enclave.host/isolation/m2/bootstrap"
	"enclave.host/isolation/m2/egress"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"enclave.host/isolation/m2/release"
)

// runStartup is the actual measured entry point used by main. Its selection is
// compiled into the front, not negotiated with an untrusted launcher.
func (p *provisioner) runStartup(ctx context.Context, packages func() (net.Conn, error), hostData, spki []byte, rt *runtimeState, appID []byte) (*provisioned, error) {
	if !directBootstrap {
		var err error
		p.roots, err = release.RelayRoots()
		if err != nil {
			return nil, err
		}
		p.keys, err = release.PinnedRelayKeys()
		if err != nil {
			return nil, err
		}
		return p.run(ctx, hostData, spki, rt, appID)
	}
	var err error
	p.roots, err = bootstrap.MeasuredRoots()
	if err != nil {
		return nil, err
	}
	if len(hostData) != 32 || isZero(hostData) || packages == nil {
		return nil, errors.New("direct startup requires deployment and package transport")
	}
	var id [32]byte
	copy(id[:], hostData)
	c, err := packages()
	if err != nil {
		return nil, errors.New("startup package transport unavailable")
	}
	stop := context.AfterFunc(ctx, func() { c.Close() })
	c.SetDeadline(time.Now().Add(15 * time.Second))
	raw, err := bootstrap.ReadPackage(c, id)
	c.Close()
	stop()
	if err != nil {
		return nil, err
	}
	// the measured reader (measured_reader.go): measured origins through this guest's egress, TLS to the measured roots,
	// and the history sources of the package once Authorize has verified the owner's commitment
	reader, err := measuredReader(p.roots, p.egress)
	if err != nil {
		return nil, err
	}
	return p.runDirect(ctx, reader, raw, hostData, spki, rt, appID)
}

func (p *provisioner) runDirect(ctx context.Context, reader *bootstrap.Reader, manifest, hostData, spki []byte, rt *runtimeState, appID []byte) (*provisioned, error) {
	if !p.appFromCode || rt == nil || len(appID) != 32 || len(hostData) != 32 || isZero(hostData) {
		return nil, errors.New("direct startup requires deployment HOST_DATA and loaded code/runtime identity")
	}
	var id [32]byte
	copy(id[:], hostData)
	loaded := bootstrap.Identity{RuntimeID: rt.RID}
	copy(loaded.AppID[:], appID)
	auth, err := reader.AuthorizeWhenConfirmed(ctx, id, manifest, loaded)
	if err != nil {
		return nil, err
	}
	text, err := auth.ConfigText()
	if err != nil {
		return nil, err
	}
	ptr, err := auth.Custody()
	if err != nil {
		return nil, err
	}
	var secrets map[string]string
	if ptr != nil {
		secrets, err = p.custodySecrets(ctx, ptr, id, spki, rt, appID, text)
		if err != nil {
			return nil, err
		}
	}
	// Release facts (storage writer fencing): this build's isolation, and the lease's writer authority from the guest's
	// OWN measured RPC quorum when the owner's config refers to it (relay-free). Waiting for a just-made claim to finalize
	// happens here, before the Revalidate below, so the lease is re-checked after any wait.
	facts, err := directFacts(ctx, auth, text, snpIsolation, p.loadCheckpoints)
	if err != nil {
		return nil, err
	}
	// Quorum retrieval may take minutes. Owner/lease/config changes during it
	// must prevent app start even if a previous custody operation succeeded.
	if err = auth.Revalidate(ctx); err != nil {
		return nil, err
	}
	pol, err := egress.FromBootstrap(auth, secrets)
	if err != nil {
		return nil, err
	}
	tag, err := auth.EnvelopeTag()
	if err != nil {
		return nil, err
	}
	out := &provisioned{envelope: tag, owner: &ownerStartup{auth: auth}}
	if _, ok := facts[appconfig.FactWriterAuthority]; ok {
		out.writerAuthority = auth
	}
	// An owner-selected CA with an EAB: the binding is resolved here, from custody secrets, and kept in this process.
	if g, e := auth.NameGrant(); e == nil && g.ACME != nil && g.ACME.EAB != nil {
		out.owner.eabKID, out.owner.eabKey, out.owner.eabErr = eabFrom(secrets, g.ACME.EAB)
	}
	if text != "" {
		resolved, e := appconfig.ResolveWithFacts(text, secrets, facts)
		if e != nil {
			return nil, e
		}
		value, ok := appconfig.EnvValue(resolved)
		if !ok {
			return nil, errors.New("direct startup config exceeds ENCLAVE_CONFIG ceiling")
		}
		out.config = value
	}
	secrets = nil
	return p.startForwarders(ctx, id, out, pol)
}

// How long a direct front waits for a just-made claim to reach Base's finalized block (L1 finality: typically 15-30
// minutes), and how often it asks. Past the window the front does not start: an app that needs the fact never runs
// without it.
var writerAuthorityWindow, writerAuthorityInterval = 45 * time.Minute, 30 * time.Second

// directFacts: the facts a direct front hands the app. The writer authority only when the config refers to it; before it
// is read, checkpoints (nil: this build reads none) loads the owner-committed attested history checkpoints.
func directFacts(ctx context.Context, auth *bootstrap.Authorization, configText, isolation string, checkpoints func(context.Context, *bootstrap.Authorization)) (map[string]string, error) {
	facts := map[string]string{appconfig.FactInstanceIsolation: isolation}
	if !strings.Contains(configText, appconfig.FactWriterAuthority) {
		return facts, nil
	}
	if checkpoints != nil {
		checkpoints(ctx, auth)
	}
	w, err := auth.WriterAuthorityWhenFinal(ctx, writerAuthorityWindow, writerAuthorityInterval)
	if err != nil {
		return nil, fmt.Errorf("the lease's writer authority: %w", err)
	}
	j, err := w.JSON()
	if err != nil {
		return nil, err
	}
	facts[appconfig.FactWriterAuthority] = j
	return facts, nil
}

// loadCheckpoints (SEV-SNP direct): the owner-committed attested history checkpoints, verified against THIS guest's own
// report (its measurement, product line and TCB), adopted before the lease's history is read
// (work/history-checkpoint-transport-interface.txt). Never a startup failure: without one, the history sources are read
// as before.
func (p *provisioner) loadCheckpoints(ctx context.Context, auth *bootstrap.Authorization) {
	if len(auth.CheckpointMirrors()) == 0 {
		return
	}
	logf := p.logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	if p.report == nil {
		logf("DOM history checkpoints: this guest has no report source: not used")
		return
	}
	own, _, err := p.report(make([]byte, 64))
	if err != nil {
		logf("DOM history checkpoints: no own report (%v): not used", err)
		return
	}
	logf("DOM history checkpoints: %s", auth.LoadCheckpoints(ctx, own))
}

// checkpointRefresh: how often a direct SEV-SNP front re-reads its lease's history and re-binds its checkpoint.
var checkpointRefresh = 6 * time.Hour

// startCheckpointProducer (SEV-SNP direct, the lease's history verified at startup): serve this guest's attested history
// checkpoint at bootstrap.CheckpointPath, refreshed every checkpointRefresh.
func startCheckpointProducer(ctx context.Context, auth *bootstrap.Authorization, report func([]byte) ([]byte, []byte, error), logf func(string, ...any)) *bootstrap.CheckpointProducer {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	p, err := bootstrap.NewCheckpointProducer(auth, report)
	if err != nil {
		logf("DOM history checkpoint: not served (%v)", err)
		return nil
	}
	go p.Run(ctx, checkpointRefresh, domLogf(logf))
	return p
}
