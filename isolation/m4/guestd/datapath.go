// datapath.go - enclave-splice/1, guestd's data plane: TLS ciphertext from the supervisor to ONE verified guest.
//
// THE PATH. A client's TLS session ends in the guest's own front (isolation/m2/front), never before it:
//
//	client --TLS--> relay (routes on SNI, terminates nothing) --> supervisor /x/<id>/https (splices, holds no key
//	for this app) --> THIS listener --> the guest's forwarder (m2/fwd, vsock) --> the guest front (TLS ends here)
//
// Every hop before the front moves bytes it cannot read. What any of them could still do is send a connection to
// the WRONG place, so each hop binds the route to an identity instead of to an address alone. Here a connection is
// admitted only if its first line names an instance that is running and states, field for field, the identity
// guestd verified for it when it started:
//
//	ENCLAVE-SPLICE/1 id=<instance> app=<AppID> measurement=<launch measurement> runtime=<RuntimeID> key=<sha256 of
//	the TLS key guestd's verifying handshake saw>
//
// answered "OK" (and from then on the connection is the guest's) or "NO <why>" and closed. A stale route - an
// instance that ended, a guest that restarted with a new key, an app or runtime that is not the one the caller
// expected - is refused here instead of being delivered to whatever now answers on that port.
//
// WHAT THIS IS NOT. It is not where a client's trust comes from, and nothing here claims to be. guestd runs on
// the host the design treats as untrusted, and so do this check and the forwarder behind it. The client verifies
// the guest ITSELF, over this same connection: it takes the key from its own handshake, fetches the guest's
// attestation document through the session that key protects, and checks the report binds that key, its nonce,
// the AppID and the runtime, under a measurement it recomputed from the pinned release. A host that lies here can
// deliver a connection to the wrong guest; it cannot make a verifying client accept it.
//
// The first line is deliberately NOT authenticated with the pairing key. Everything it could protect is already
// reachable on the host without it (each guest's forwarder listens on the host's loopback), and the bytes after it
// are TLS the host cannot read. Authenticating it would be a check that covers nothing.
//
// Bounds: the first line is at most 512 bytes and must arrive within PreambleTimeout; the guest must accept within
// DialTimeout; a connection with no bytes moving in either direction for Idle is closed; at most MaxPerGuest open
// splices per instance and MaxTotal overall, beyond which a connection is refused rather than queued. Bytes are
// copied through one 32 KiB buffer per direction with no other buffering, so a reader that stops reading stops the
// writer (TCP's own flow control), and the bytes held for a stalled peer are the sockets' kernel buffers.
//
// Ending: an instance's reclamation (delete, lease lapse, guest death, shutdown) closes every splice to it.
package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"enclave.host/isolation/contract"
)

const (
	spliceProto = "ENCLAVE-SPLICE/1"
	maxPreamble = 512
)

type dataPlane struct {
	s               *server
	PreambleTimeout time.Duration
	DialTimeout     time.Duration
	Idle            time.Duration
	MaxPerGuest     int
	MaxTotal        int
	total           atomic.Int64
	mu              sync.Mutex
	stats           map[string]int // outcome -> count, read by tests and the evidence writer
}

func newDataPlane(s *server) *dataPlane {
	return &dataPlane{s: s, PreambleTimeout: 5 * time.Second, DialTimeout: 5 * time.Second, Idle: 180 * time.Second,
		MaxPerGuest: 256, MaxTotal: 1024, stats: map[string]int{}}
}

func (d *dataPlane) count(outcome string) {
	d.mu.Lock()
	d.stats[outcome]++
	d.mu.Unlock()
}

// Stats is a copy of the outcome counts.
func (d *dataPlane) Stats() map[string]int {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make(map[string]int, len(d.stats))
	for k, v := range d.stats {
		out[k] = v
	}
	return out
}

// splice is one admitted connection and, once dialled, the guest's end of it. close ends both, once.
type splice struct {
	mu       sync.Mutex
	conns    []net.Conn
	closed   bool
	why      string
	released atomic.Bool
}

func (sp *splice) add(c net.Conn) bool {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if sp.closed {
		return false
	}
	sp.conns = append(sp.conns, c)
	return true
}

func (sp *splice) close(why string) {
	sp.mu.Lock()
	if sp.closed {
		sp.mu.Unlock()
		return
	}
	sp.closed, sp.why = true, why
	cs := sp.conns
	sp.mu.Unlock()
	for _, c := range cs {
		_ = c.Close()
	}
}

func (sp *splice) reason() string {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	return sp.why
}

// Serve accepts until the listener closes.
func (d *dataPlane) Serve(l net.Listener) error {
	for {
		c, err := l.Accept()
		if err != nil {
			return err
		}
		go d.handle(c)
	}
}

type spliceWant struct{ id, app, measurement, runtime, key string }

// parsePreamble is strict: the protocol word, then exactly these five fields in this order, each a lowercase hex
// value of its exact length. Anything else - a missing, extra, repeated or reordered field - is malformed.
func parsePreamble(line string) (spliceWant, error) {
	f := strings.Split(line, " ")
	if len(f) != 6 || f[0] != spliceProto {
		return spliceWant{}, errors.New("malformed: expected " + spliceProto + " id= app= measurement= runtime= key=")
	}
	var w spliceWant
	for i, spec := range []struct {
		name string
		n    int
		dst  *string
	}{{"id", 0, &w.id}, {"app", 32, &w.app}, {"measurement", 48, &w.measurement}, {"runtime", 32, &w.runtime},
		{"key", 32, &w.key}} {
		v, ok := strings.CutPrefix(f[i+1], spec.name+"=")
		if !ok {
			return spliceWant{}, fmt.Errorf("malformed: field %d is not %s=", i+1, spec.name)
		}
		if spec.n == 0 {
			if len(v) != 10 || v[0] < 'a' || v[0] > 'z' || v[1] < 'a' || v[1] > 'z' || !isHex(v[2:], 4) {
				return spliceWant{}, errors.New("malformed: id is not an instance id")
			}
		} else if !isHex(v, spec.n) {
			return spliceWant{}, fmt.Errorf("malformed: %s is not %d bytes of lowercase hex", spec.name, spec.n)
		}
		*spec.dst = v
	}
	return w, nil
}

// isHex: exactly n bytes of LOWERCASE hex, so one identity has one spelling.
func isHex(s string, n int) bool {
	if len(s) != 2*n {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// readLine reads one \n-terminated line a byte at a time, so nothing after it is consumed: the bytes that follow
// belong to the guest. More than max bytes without a newline is an error.
func readLine(c net.Conn, max int) (string, error) {
	b := make([]byte, 0, 128)
	one := make([]byte, 1)
	for len(b) <= max {
		if _, err := io.ReadFull(c, one); err != nil {
			return "", err
		}
		if one[0] == '\n' {
			return string(b), nil
		}
		b = append(b, one[0])
	}
	return "", errOversized
}

var errOversized = errors.New("the first line exceeds its bound")

func (d *dataPlane) refuse(c net.Conn, outcome, why string) {
	d.count(outcome)
	_ = c.SetWriteDeadline(time.Now().Add(2 * time.Second))
	_, _ = io.WriteString(c, "NO "+why+"\n")
	_ = c.Close()
}

// admit judges the instance against what the caller expects. Called with s.mu held.
func (d *dataPlane) admit(v *vm, w spliceWant) (outcome, why string) {
	switch {
	case v == nil:
		return "refused:no-instance", "no such instance"
	case v.Status != "running" || v.lc.State() != contract.Running:
		return "refused:not-running", "the instance is " + v.Status
	case d.s.RuntimeID == "":
		return "refused:no-runtime-pin", "this guestd pins no runtime identity"
	case w.app != v.AppID:
		return "refused:identity", "the instance is not that app"
	case w.measurement != v.Measurement:
		return "refused:identity", "the instance was not launched with that measurement"
	case w.runtime != d.s.RuntimeID:
		return "refused:identity", "the instance does not carry that runtime"
	case w.key != v.TransportKeySha256:
		return "refused:identity", "the instance's verified transport key is not that key"
	case len(v.splices) >= d.MaxPerGuest || d.total.Load() >= int64(d.MaxTotal):
		return "refused:busy", "too many open connections"
	}
	return "", ""
}

func (d *dataPlane) release(v *vm, sp *splice) {
	if !sp.released.CompareAndSwap(false, true) {
		return
	}
	d.total.Add(-1)
	d.s.mu.Lock()
	if v.splices != nil {
		delete(v.splices, sp)
	}
	d.s.mu.Unlock()
}

func (d *dataPlane) handle(c net.Conn) {
	_ = c.SetDeadline(time.Now().Add(d.PreambleTimeout))
	line, err := readLine(c, maxPreamble)
	if err != nil {
		switch {
		case errors.Is(err, errOversized):
			d.refuse(c, "refused:oversized", "the first line is too long")
		case isTimeout(err):
			d.count("closed:preamble-timeout")
			_ = c.Close()
		default:
			d.count("closed:preamble-incomplete")
			_ = c.Close()
		}
		return
	}
	w, err := parsePreamble(line)
	if err != nil {
		d.refuse(c, "refused:malformed", err.Error())
		return
	}
	s := d.s
	s.mu.Lock()
	v := s.vms[w.id]
	if outcome, why := d.admit(v, w); outcome != "" {
		s.mu.Unlock()
		d.refuse(c, outcome, why)
		return
	}
	sp := &splice{conns: []net.Conn{c}}
	if v.splices == nil {
		v.splices = map[*splice]struct{}{}
	}
	v.splices[sp] = struct{}{}
	d.total.Add(1)
	port := v.HostPort
	s.mu.Unlock()
	defer d.release(v, sp)

	g, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), d.DialTimeout)
	if err != nil {
		d.refuse(c, "refused:guest-unreachable", "the guest's endpoint did not answer")
		return
	}
	if !sp.add(g) { // the instance ended while this was dialling: its reclamation already closed the client end
		_ = g.Close()
		d.count("closed:instance-ended")
		return
	}
	_ = c.SetDeadline(time.Time{})
	_ = c.SetWriteDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.WriteString(c, "OK\n"); err != nil {
		sp.close("the caller left before the splice opened")
		d.count("closed:caller-gone")
		return
	}
	_ = c.SetWriteDeadline(time.Time{})
	d.count("spliced")
	d.pump(sp, c, g)
	if why := sp.reason(); why != "" {
		d.count("closed:" + why)
	} else {
		d.count("closed:ended")
	}
}

// pump copies both ways until both directions end, either side fails, the idle watchdog fires, or the instance's
// reclamation closes the splice. An EOF from one side half-closes the other, so a request body can end while the
// answer keeps streaming.
func (d *dataPlane) pump(sp *splice, c, g net.Conn) {
	var last atomic.Int64
	last.Store(time.Now().UnixNano())
	done := make(chan error, 2)
	cp := func(dst, src net.Conn) {
		buf := make([]byte, 32<<10)
		for {
			n, err := src.Read(buf)
			if n > 0 {
				last.Store(time.Now().UnixNano())
				if _, werr := dst.Write(buf[:n]); werr != nil {
					done <- werr
					return
				}
				last.Store(time.Now().UnixNano())
			}
			if err != nil {
				if errors.Is(err, io.EOF) {
					if cw, ok := dst.(interface{ CloseWrite() error }); ok {
						_ = cw.CloseWrite()
					}
					done <- nil
				} else {
					done <- err
				}
				return
			}
		}
	}
	go cp(g, c)
	go cp(c, g)
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		t := time.NewTicker(d.Idle / 4)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case now := <-t.C:
				if now.Sub(time.Unix(0, last.Load())) > d.Idle {
					sp.close("idle")
					return
				}
			}
		}
	}()
	for ended := 0; ended < 2; ended++ {
		if err := <-done; err != nil {
			sp.close("")
			<-done
			return
		}
	}
	sp.close("")
}

func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}
