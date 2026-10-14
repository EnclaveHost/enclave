package main

// Custody authorization, host side (docs/security/secret-custody.md; the guest side is isolation/m2/front/custody.go).
//
// A guest whose deployment's secrets are held by custodians asks for them itself, under a fresh attestation; the custodians
// also require the lease holder's OPERATOR to authorize that exact release (their proof the request comes from the host
// that holds the lease). The operator key is the supervisor's, not this host's, so guestd only carries it:
//
//   1. the guest connects to release.CustodyAuthPort and sends "custody-auth-v1 0x<id> <binding>", or for custody v2
//      (docs/security/secret-custody-v2-spec.md §3) "custody-auth-v2 0x<vault> 0x<id> <binding>";
//   2. guestd answers only the ONE instance it launched with that vsock CID, and only for that instance's own
//      deployment (HOST_DATA), and reports it in GET /vms/<id> as awaitingCustodyAuth: "<binding>" for v1 (the shape the
//      v1 supervisor reads), or awaitingCustodyAuth: {v: 2, vault, binding} for v2 (the supervisor signs a v2 release
//      only for the v2 vault it was measured with; a v1-only supervisor reads no string there and signs nothing);
//   3. the supervisor signs the binding with the operator key and POSTs /vms/<id>/custody-auth {binding, endpoint,
//      sig, expiry}; guestd hands it to that guest only if the binding is the one the guest is waiting on.
//
// Nothing secret passes here: the binding is a hash, the signature authorizes one release to a key this host never sees.

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"time"

	"enclave.host/isolation/m2/release"
)

// maxCustodyAuths bounds the authorizations one instance may ask for (a release retried after a refusal asks again).
const maxCustodyAuths = 8

var (
	custodySigRE      = regexp.MustCompile(`^0x[0-9a-f]{130}$`)
	custodyEndpointRE = regexp.MustCompile(`^https?://[!-~]{1,190}$`)
	custodyBindingRE  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	custodyVaultRE    = regexp.MustCompile(`^0x[0-9a-f]{40}$`)
)

func (s *server) takeCustodyAuth(ctx context.Context, cid uint32, req release.AuthRequest, gone <-chan struct{}) (release.CustodyAuth, *vm, error) {
	var out release.CustodyAuth
	id, binding := req.ID, req.Binding
	switch {
	case req.V == 1 && req.Vault == "":
	case req.V == 2 && custodyVaultRE.MatchString(req.Vault):
	default:
		return out, nil, errors.New("not a custody-auth-v1 or custody-auth-v2 request")
	}
	s.mu.Lock()
	var v *vm
	for _, o := range s.vms {
		if o.cid == cid && cid != 0 && o.release && releaseLive(o) && (o.Status == "starting" || o.Status == "running") {
			v = o
			break
		}
	}
	switch {
	case v == nil:
		s.mu.Unlock()
		return out, nil, errors.New("no live deployment guest has this CID")
	case v.HostData != hex.EncodeToString(id[:]):
		s.mu.Unlock()
		return out, v, errors.New("the request names another deployment than this guest's HOST_DATA")
	case v.custodyPending != "":
		s.mu.Unlock()
		return out, v, errors.New("this guest already waits for a custody authorization")
	case v.custodyServed >= maxCustodyAuths:
		s.mu.Unlock()
		return out, v, errors.New("this guest has asked for too many custody authorizations")
	case s.held >= maxHeld:
		s.mu.Unlock()
		return out, v, errors.New("too many guests are waiting")
	}
	ch := make(chan release.CustodyAuth, 1)
	v.custodyPending, v.custodyV, v.custodyVault, v.custodyAuth = hex.EncodeToString(binding[:]), req.V, req.Vault, ch
	s.held++
	s.mu.Unlock()
	defer s.set(v, func() { v.custodyPending, v.custodyV, v.custodyVault, v.custodyAuth = "", 0, "", nil; s.held-- })

	hold := s.TicketHold
	if hold <= 0 {
		hold = release.TicketHold
	}
	timeout := time.NewTimer(hold)
	defer timeout.Stop()
	check := time.NewTicker(250 * time.Millisecond)
	defer check.Stop()
	for {
		if !releaseLive(v) {
			return out, v, errors.New("the instance's end was asked for while its guest waited")
		}
		select {
		case a := <-ch:
			s.set(v, func() { v.custodyServed++ })
			return a, v, nil
		case <-gone:
			return out, v, errors.New("the guest closed its connection")
		case <-timeout.C:
			return out, v, errors.New("no custody authorization arrived for this guest")
		case <-ctx.Done():
			return out, v, ctx.Err()
		case <-check.C:
		}
	}
}

// serveCustodyAuth is the guest-facing service: one request line, one answer line, then close. It logs the CID, the
// instance and the outcome; a binding is a hash and a signature authorizes nothing secret, but neither is logged.
func (s *server) serveCustodyAuth(ctx context.Context, l net.Listener, cidOf func(net.Conn) uint32, lg *log.Logger) error {
	if cidOf == nil {
		return errors.New("custody authorization: cidOf is required")
	}
	go func() { <-ctx.Done(); l.Close() }()
	for {
		c, err := l.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if errors.Is(err, net.ErrClosed) || errors.Is(err, os.ErrClosed) {
				return err
			}
			lg.Printf("custody accept: %v", err)
			time.Sleep(50 * time.Millisecond)
			continue
		}
		go func() {
			defer c.Close()
			cid := cidOf(c)
			c.SetReadDeadline(time.Now().Add(10 * time.Second))
			req, err := release.ReadAnyAuthRequest(c)
			if err != nil {
				lg.Printf("guest %d: custody authorization request refused: %v", cid, err)
				return
			}
			c.SetReadDeadline(time.Time{})
			gone := make(chan struct{})
			go func() { var b [1]byte; _, _ = c.Read(b[:]); close(gone) }()
			a, v, err := s.takeCustodyAuth(ctx, cid, req, gone)
			inst := "-"
			if v != nil {
				inst = v.ID
			}
			if err != nil {
				lg.Printf("guest %d (instance %s): no custody authorization: %v", cid, inst, err)
				return
			}
			c.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := release.WriteAuth(c, a); err != nil {
				lg.Printf("guest %d (instance %s): custody authorization not delivered: %v", cid, inst, err)
				return
			}
			lg.Printf("guest %d (instance %s): custody-auth-v%d authorization delivered", cid, inst, req.V)
		}()
	}
}

// postCustodyAuth is POST /vms/<id>/custody-auth {binding, endpoint, sig, expiry}: the supervisor's signature for the
// binding the instance's guest is waiting on, and for nothing else.
func (s *server) postCustodyAuth(w http.ResponseWriter, r *http.Request, id string) {
	if !s.Release {
		s.json(w, 422, map[string]any{"error": "this guestd carries no custody authorizations (-release is off)"})
		return
	}
	var b struct {
		Binding  string `json:"binding"`
		Endpoint string `json:"endpoint"`
		Sig      string `json:"sig"`
		Expiry   int64  `json:"expiry"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil {
		s.json(w, 400, map[string]any{"error": "bad request: " + err.Error()})
		return
	}
	if !custodyBindingRE.MatchString(b.Binding) || !custodyEndpointRE.MatchString(b.Endpoint) || !custodySigRE.MatchString(b.Sig) || b.Expiry <= 0 {
		s.json(w, 422, map[string]any{"error": "binding (64 hex), endpoint, sig (0x + 130 hex) and expiry are required"})
		return
	}
	s.mu.Lock()
	v := s.vms[id]
	var ch chan release.CustodyAuth
	ok := v != nil && v.custodyPending == b.Binding && v.custodyAuth != nil
	if ok {
		ch = v.custodyAuth
	}
	s.mu.Unlock()
	if v == nil {
		s.json(w, 404, map[string]any{"error": "no such instance"})
		return
	}
	if !ok {
		s.json(w, 409, map[string]any{"error": "this instance's guest is not waiting on that binding"})
		return
	}
	select {
	case ch <- release.CustodyAuth{Endpoint: b.Endpoint, Sig: b.Sig, Expiry: b.Expiry}:
		s.json(w, 202, map[string]any{"id": v.ID, "custodyAuth": "pending"})
	default:
		s.json(w, 409, map[string]any{"error": "an authorization is already pending for this guest"})
	}
}

// custodyAuthMsg is what the supervisor's POST hands the waiting guest (server.go keeps the vm struct free of the release
// package's types).
type custodyAuthMsg = release.CustodyAuth
