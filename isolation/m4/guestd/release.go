package main

// The attested release, host side (docs/security/attested-release.md; the guest side is isolation/m2/front/provision.go).
//
// A guest that serves a deployment gets its owner's config and secrets from the relay, sealed to a key only it holds,
// and nothing about them crosses this host. What this host does is carry two things it cannot misuse:
//
//   - the TICKET. The lease holder's supervisor gets it from the relay (it holds the operator key; this host does
//     not) and hands it to guestd; guestd hands it to the ONE guest it launched for that deployment, on vsock host
//     port release.TicketPort. A ticket is useless in any other guest (the relay binds it to a report that guest
//     cannot produce), but it is one-use, so a ticket routed to the wrong guest is BURNED: the service therefore
//     answers a guest only by the vsock CID guestd itself chose for it, and only with that guest's own deployment's
//     ticket. The guest's front refuses a ticket that does not name its HOST_DATA anyway.
//   - the guest's EGRESS, on vsock host port egressPort: TLS the guest runs end to end, to origins the guest's own
//     allowlist names (isolation/m2/egress). This host sees destinations, timing and volume, and records only the
//     guest's CID and an outcome code. It serves only CIDs of guests guestd launched (admitCID).
//
// The ticket arrives in one of two ways: in the create request, or later through POST /vms/<id>/ticket. The second is
// the one a supervisor should use: the guest dials the ticket service as it boots and guestd HOLDS that connection,
// reporting awaitingTicket, so the supervisor fetches the ticket (TTL 120 s at the relay) only once the guest is
// actually waiting, and no part of the TTL is spent building the image. A ticket that never arrives ends the guest:
// the hold times out, the connection closes, the front refuses to start the app, the guest powers off, and the
// launch fails through the lifecycle, returning the guest's reservation (pool.go).

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/release"
)

// egressPort is the host port of the egress server; it must equal the front's EgressPort (isolation/m2/front).
const egressPort = 9443

// The CIDs guestd gives its guests: the range m2/run-domain.sh draws from when it chooses one itself.
const cidBase, cidSpan = 65536, 65536

// pickCIDLocked chooses a vsock CID no guest this guestd holds uses - launched this run or ADOPTED from a previous
// one (their CIDs are restored with them, persist.go). Called with s.mu held.
func (s *server) pickCIDLocked() (uint32, error) {
	used := map[uint32]bool{}
	for _, v := range s.vms {
		if v.cid != 0 {
			used[v.cid] = true
		}
	}
	draw := s.drawCID
	if draw == nil {
		draw = func() uint32 {
			var b [4]byte
			_, _ = rand.Read(b[:])
			return cidBase + binary.LittleEndian.Uint32(b[:])%cidSpan
		}
	}
	for i := 0; i < 64; i++ {
		if c := draw(); c >= cidBase && c < cidBase+cidSpan && !used[c] {
			return c, nil
		}
	}
	return 0, errors.New("no free vsock CID")
}

// parseTicket is a ticket as the relay issues it: base64 of 32 bytes.
func parseTicket(s string) ([32]byte, error) {
	var t [32]byte
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(raw) != 32 {
		return t, errors.New("a ticket is base64 of 32 bytes")
	}
	copy(t[:], raw)
	return t, nil
}

// offerTicket fills a starting guest's one ticket slot. A guest reads exactly one ticket, at boot, so a second offer
// is refused rather than queued.
func (s *server) offerTicket(v *vm, t [32]byte) error {
	s.mu.Lock()
	ok := v.ticket != nil && v.Status == "starting" && v.lc.State() != contract.Ended
	s.mu.Unlock()
	if !ok {
		return errors.New("this instance is not a starting deployment guest that takes a ticket")
	}
	select {
	case v.ticket <- t:
		return nil
	default:
		return errors.New("a ticket is already pending for this instance")
	}
}

// takeTicket is what the ticket service does for the guest at CID cid: find the ONE instance guestd launched with
// that CID, wait (up to TicketHold) for its ticket, and return it bound to THAT instance's deployment. Another
// instance's ticket can never be returned: the slot read is the instance's own.
func (s *server) takeTicket(ctx context.Context, cid uint32) (release.Ticket, *vm, error) {
	var out release.Ticket
	s.mu.Lock()
	var v *vm
	for _, o := range s.vms {
		if o.cid == cid && cid != 0 && o.ticket != nil && o.Status == "starting" && o.lc.State() != contract.Ended {
			v = o
			break
		}
	}
	if v == nil {
		s.mu.Unlock()
		return out, nil, errors.New("no starting deployment guest has this CID")
	}
	hd, err := hex.DecodeString(v.HostData)
	if err != nil || len(hd) != 32 {
		s.mu.Unlock()
		return out, v, errors.New("the instance has no deployment id")
	}
	copy(out.ID[:], hd)
	v.awaitingTicket = true
	s.mu.Unlock()
	defer s.set(v, func() { v.awaitingTicket = false })

	hold := s.TicketHold
	if hold <= 0 {
		hold = 5 * time.Minute
	}
	timeout := time.NewTimer(hold)
	defer timeout.Stop()
	check := time.NewTicker(250 * time.Millisecond)
	defer check.Stop()
	for {
		select {
		case t := <-v.ticket:
			out.Ticket = t
			return out, v, nil
		case <-timeout.C:
			return out, v, errors.New("no ticket arrived for this guest")
		case <-ctx.Done():
			return out, v, ctx.Err()
		case <-check.C:
			if v.lc.State() == contract.Ended {
				return out, v, errors.New("the instance ended while its guest waited for a ticket")
			}
		}
	}
}

// serveTickets is the ticket service: one line per guest connection, then close. It logs the CID, the instance and
// the outcome, never a ticket.
func (s *server) serveTickets(ctx context.Context, l net.Listener, cidOf func(net.Conn) uint32, lg *log.Logger) error {
	if cidOf == nil {
		return errors.New("ticket service: cidOf is required (a ticket goes only to the guest guestd launched for it)")
	}
	go func() { <-ctx.Done(); l.Close() }()
	for {
		c, err := l.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		go func() {
			defer c.Close()
			cid := cidOf(c)
			t, v, err := s.takeTicket(ctx, cid)
			id := "-"
			if v != nil {
				id = v.ID
			}
			if err != nil {
				lg.Printf("guest %d (instance %s): no ticket: %v", cid, id, err)
				return
			}
			c.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := release.WriteTicket(c, t); err != nil {
				lg.Printf("guest %d (instance %s): the ticket was not delivered: %v", cid, id, err)
				return
			}
			lg.Printf("guest %d (instance %s): ticket delivered", cid, id)
		}()
	}
}

// admitCID is the egress server's Admit: only a guest this guestd launched for a deployment, while it lives.
func (s *server) admitCID(cid uint32) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, v := range s.vms {
		st := v.lc.State() // Starting or Running only: once its end is requested, its guest gets no new connection
		if v.cid == cid && cid != 0 && v.HostData != "" && (st == contract.Starting || st == contract.Running) &&
			(v.Status == "starting" || v.Status == "running") {
			return true
		}
	}
	return false
}

// postTicket is POST /vms/<id>/ticket {ticket}: the supervisor's late ticket, once the instance reports awaitingTicket.
func (s *server) postTicket(w http.ResponseWriter, r *http.Request, id string) {
	if !s.Release {
		s.json(w, 422, map[string]any{"error": "this guestd does not deliver release tickets (-release is off)"})
		return
	}
	var b struct {
		Ticket string `json:"ticket"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil {
		s.json(w, 400, map[string]any{"error": "bad request: " + err.Error()})
		return
	}
	t, err := parseTicket(b.Ticket)
	if err != nil {
		s.json(w, 422, map[string]any{"error": err.Error()})
		return
	}
	s.mu.Lock()
	v := s.vms[id]
	s.mu.Unlock()
	if v == nil {
		s.json(w, 404, map[string]any{"error": "no such instance"})
		return
	}
	if err := s.offerTicket(v, t); err != nil {
		s.json(w, 409, map[string]any{"error": err.Error()})
		return
	}
	s.json(w, 202, map[string]any{"id": v.ID, "ticket": "pending"})
}

// ticketFromRequest validates a create request's ticket: only with -release, and only for a deployment guest.
func (s *server) ticketFromRequest(req *Request, hostData string) (*[32]byte, error) {
	if req.Ticket == "" {
		return nil, nil
	}
	if !s.Release {
		return nil, errors.New("a release ticket: this guestd does not deliver them (-release is off)")
	}
	if hostData == "" {
		return nil, fmt.Errorf("a release ticket for %q, which is not a deployment id: the guest would have no HOST_DATA to check it against", req.Name)
	}
	t, err := parseTicket(req.Ticket)
	if err != nil {
		return nil, err
	}
	return &t, nil
}
