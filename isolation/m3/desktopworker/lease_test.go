package desktopworker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const wait = 2 * time.Second

var (
	testBinding = Binding{
		Boot:       "00112233445566778899aabbccddeeff",
		Claim:      strings.Repeat("ab", 32),
		AppID:      strings.Repeat("cd", 32),
		ProfileSHA: strings.Repeat("ef", 32),
		GPUMilli:   750,
	}
	testToken     = strings.Repeat("5a", 32)
	testClaimLine = "native-worker-v1 claim 00112233445566778899aabbccddeeff " +
		strings.Repeat("ab", 32) + " " + strings.Repeat("cd", 32) + " " +
		strings.Repeat("ef", 32) + " 750\n"
	testLeaseLine = "native-worker-v1 lease " + testToken + "\n"
	testOpenLine  = "native-worker-v1 open " + testToken + "\n"
	testStreamAck = "native-worker-v1 stream\n"
)

// fakeHost hands the server end of each net.Pipe to the test. Dials block
// until the test accepts or ctx ends, so pending dials are observable.
type fakeHost struct {
	conns   chan net.Conn
	entered chan struct{}
	dials   atomic.Int32
}

func newFakeHost() *fakeHost {
	return &fakeHost{conns: make(chan net.Conn), entered: make(chan struct{}, 64)}
}

func (h *fakeHost) dial(ctx context.Context) (net.Conn, error) {
	h.dials.Add(1)
	select {
	case h.entered <- struct{}{}:
	default:
	}
	c, s := net.Pipe()
	select {
	case h.conns <- s:
		return c, nil
	case <-ctx.Done():
		c.Close()
		s.Close()
		return nil, ctx.Err()
	}
}

func (h *fakeHost) accept(t *testing.T) net.Conn {
	t.Helper()
	select {
	case s := <-h.conns:
		t.Cleanup(func() { s.Close() })
		return s
	case <-time.After(wait):
		t.Fatal("timed out waiting for dial")
		return nil
	}
}

func readLine(t *testing.T, c net.Conn) string {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(wait))
	defer c.SetReadDeadline(time.Time{})
	var line []byte
	var b [1]byte
	for len(line) < maxLine {
		if _, err := c.Read(b[:]); err != nil {
			t.Fatalf("read line: %v", err)
		}
		line = append(line, b[0])
		if b[0] == '\n' {
			return string(line)
		}
	}
	t.Fatal("line too long")
	return ""
}

func write(t *testing.T, c net.Conn, s string) {
	t.Helper()
	c.SetWriteDeadline(time.Now().Add(wait))
	defer c.SetWriteDeadline(time.Time{})
	if _, err := io.WriteString(c, s); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// writeAsync is for responses the client may reject before reading fully.
func writeAsync(c net.Conn, s string) { go io.WriteString(c, s) }

type acquireResult struct {
	l   *Lease
	err error
}

func startAcquire(ctx context.Context, b Binding, dial Dial) <-chan acquireResult {
	ch := make(chan acquireResult, 1)
	go func() {
		l, err := Acquire(ctx, b, dial)
		ch <- acquireResult{l, err}
	}()
	return ch
}

func waitAcquire(t *testing.T, ch <-chan acquireResult) acquireResult {
	t.Helper()
	select {
	case r := <-ch:
		if r.l != nil {
			t.Cleanup(func() { r.l.Close() })
		}
		return r
	case <-time.After(wait):
		t.Fatal("Acquire did not return")
		return acquireResult{}
	}
}

func acquire(t *testing.T, ctx context.Context, h *fakeHost) (*Lease, net.Conn) {
	t.Helper()
	ch := startAcquire(ctx, testBinding, h.dial)
	ctrl := h.accept(t)
	if got := readLine(t, ctrl); got != testClaimLine {
		t.Fatalf("claim line = %q, want %q", got, testClaimLine)
	}
	write(t, ctrl, testLeaseLine)
	r := waitAcquire(t, ch)
	if r.err != nil {
		t.Fatalf("Acquire: %v", r.err)
	}
	return r.l, ctrl
}

type openResult struct {
	c   net.Conn
	err error
}

func startOpen(ctx context.Context, l *Lease) <-chan openResult {
	ch := make(chan openResult, 1)
	go func() {
		c, err := l.Open(ctx)
		ch <- openResult{c, err}
	}()
	return ch
}

func waitOpen(t *testing.T, ch <-chan openResult) openResult {
	t.Helper()
	select {
	case r := <-ch:
		if r.c != nil {
			t.Cleanup(func() { r.c.Close() })
		}
		return r
	case <-time.After(wait):
		t.Fatal("Open did not return")
		return openResult{}
	}
}

func openStream(t *testing.T, l *Lease, h *fakeHost) (net.Conn, net.Conn) {
	t.Helper()
	ch := startOpen(context.Background(), l)
	srv := h.accept(t)
	if got := readLine(t, srv); got != testOpenLine {
		t.Fatalf("open line = %q, want %q", got, testOpenLine)
	}
	write(t, srv, testStreamAck)
	r := waitOpen(t, ch)
	if r.err != nil {
		t.Fatalf("Open: %v", r.err)
	}
	return r.c, srv
}

func waitDone(t *testing.T, l *Lease) {
	t.Helper()
	select {
	case <-l.Done():
	case <-time.After(wait):
		t.Fatal("lease did not end")
	}
}

// expectPeerClosed asserts the other end of c was closed.
func expectPeerClosed(t *testing.T, c net.Conn) {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(wait))
	var b [1]byte
	if _, err := c.Read(b[:]); !errors.Is(err, io.EOF) {
		t.Fatalf("peer read err = %v, want EOF", err)
	}
}

// expectLocalClosed asserts c itself was closed.
func expectLocalClosed(t *testing.T, c net.Conn) {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(wait))
	var b [1]byte
	if _, err := c.Read(b[:]); !errors.Is(err, io.ErrClosedPipe) && !errors.Is(err, net.ErrClosed) {
		t.Fatalf("local read err = %v, want closed connection", err)
	}
}

func activeCount(l *Lease) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.active)
}

func TestValidateBoundaries(t *testing.T) {
	for _, g := range []int{500, 1000} {
		b := testBinding
		b.GPUMilli = g
		if err := b.validate(); err != nil {
			t.Errorf("GPUMilli %d: %v", g, err)
		}
	}
}

func TestInvalidBindingRejectedBeforeDial(t *testing.T) {
	mut := func(f func(*Binding)) Binding {
		b := testBinding
		f(&b)
		return b
	}
	cases := map[string]Binding{
		"empty":           {},
		"boot short":      mut(func(b *Binding) { b.Boot = b.Boot[:31] }),
		"boot long":       mut(func(b *Binding) { b.Boot += "0" }),
		"boot upper":      mut(func(b *Binding) { b.Boot = strings.ToUpper(b.Boot) }),
		"boot zero":       mut(func(b *Binding) { b.Boot = strings.Repeat("0", 32) }),
		"claim nonhex":    mut(func(b *Binding) { b.Claim = strings.Repeat("g", 64) }),
		"claim space":     mut(func(b *Binding) { b.Claim = " " + b.Claim[1:] }),
		"app short":       mut(func(b *Binding) { b.AppID = b.AppID[:63] }),
		"app zero":        mut(func(b *Binding) { b.AppID = strings.Repeat("0", 64) }),
		"profile newline": mut(func(b *Binding) { b.ProfileSHA = b.ProfileSHA[:63] + "\n" }),
		"profile upper":   mut(func(b *Binding) { b.ProfileSHA = strings.ToUpper(b.ProfileSHA) }),
		"gpu zero":        mut(func(b *Binding) { b.GPUMilli = 0 }),
		"gpu low":         mut(func(b *Binding) { b.GPUMilli = 499 }),
		"gpu high":        mut(func(b *Binding) { b.GPUMilli = 1001 }),
	}
	for name, b := range cases {
		t.Run(name, func(t *testing.T) {
			var dialed atomic.Bool
			dial := func(context.Context) (net.Conn, error) {
				dialed.Store(true)
				return nil, errors.New("unexpected dial")
			}
			l, err := Acquire(context.Background(), b, dial)
			if l != nil || !errors.Is(err, ErrInvalidBinding) {
				t.Fatalf("Acquire = %v, %v; want ErrInvalidBinding", l, err)
			}
			if dialed.Load() {
				t.Fatal("dialed before validation")
			}
		})
	}
}

func TestExactLinesAndDuplex(t *testing.T) {
	h := newFakeHost()
	l, _ := acquire(t, context.Background(), h) // asserts exact claim line
	c, srv := openStream(t, l, h)               // asserts exact open line

	go io.WriteString(c, "ping")
	srv.SetReadDeadline(time.Now().Add(wait))
	buf := make([]byte, 4)
	if _, err := io.ReadFull(srv, buf); err != nil || string(buf) != "ping" {
		t.Fatalf("server read %q, %v", buf, err)
	}
	go io.WriteString(srv, "pong")
	c.SetReadDeadline(time.Now().Add(wait))
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "pong" {
		t.Fatalf("client read %q, %v", buf, err)
	}
}

func TestStreamPreservesBufferedBytes(t *testing.T) {
	h := newFakeHost()
	l, _ := acquire(t, context.Background(), h)

	payload := "hello\x00\xff\nnative-worker-v1 stream\n world"
	ch := startOpen(context.Background(), l)
	srv := h.accept(t)
	readLine(t, srv)
	// Ack and payload in a single write so the client buffers the payload.
	write(t, srv, testStreamAck+payload)
	r := waitOpen(t, ch)
	if r.err != nil {
		t.Fatalf("Open: %v", r.err)
	}

	go io.WriteString(srv, "tail")
	r.c.SetReadDeadline(time.Now().Add(wait))
	got := make([]byte, len(payload)+4)
	if _, err := io.ReadFull(r.c, got); err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != payload+"tail" {
		t.Fatalf("stream bytes = %q, want %q", got, payload+"tail")
	}
}

func TestControlDisturbanceEndsLease(t *testing.T) {
	cases := map[string]func(net.Conn){
		"eof":        func(c net.Conn) { c.Close() },
		"unexpected": func(c net.Conn) { writeAsync(c, "x") },
	}
	for name, disturb := range cases {
		t.Run(name, func(t *testing.T) {
			h := newFakeHost()
			l, ctrl := acquire(t, context.Background(), h)
			c, srv := openStream(t, l, h)

			disturb(ctrl)
			waitDone(t, l)
			expectLocalClosed(t, c)
			expectPeerClosed(t, srv)

			dials := h.dials.Load()
			if _, err := l.Open(context.Background()); !errors.Is(err, ErrLeaseClosed) {
				t.Fatalf("Open after end = %v, want ErrLeaseClosed", err)
			}
			if h.dials.Load() != dials {
				t.Fatal("reconnected after lease ended")
			}
		})
	}
}

func TestAcquireContextBoundsLifetime(t *testing.T) {
	h := newFakeHost()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	l, ctrl := acquire(t, ctx, h)
	select {
	case <-l.Done():
		t.Fatal("lease ended when handshake context was released")
	default:
	}
	c, srv := openStream(t, l, h)

	cancel()
	waitDone(t, l)
	expectLocalClosed(t, c)
	expectPeerClosed(t, srv)
	expectPeerClosed(t, ctrl)
}

func TestCloseIdempotentNoReopen(t *testing.T) {
	h := newFakeHost()
	l, ctrl := acquire(t, context.Background(), h)
	c, _ := openStream(t, l, h)

	if err := l.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := l.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	waitDone(t, l)
	expectPeerClosed(t, ctrl)
	expectLocalClosed(t, c)
	if err := c.Close(); err != nil {
		t.Fatalf("stream Close after lease Close: %v", err)
	}

	dials := h.dials.Load()
	if _, err := l.Open(context.Background()); !errors.Is(err, ErrLeaseClosed) {
		t.Fatalf("Open after Close = %v, want ErrLeaseClosed", err)
	}
	if h.dials.Load() != dials {
		t.Fatal("dialed after Close")
	}
}

func TestMalformedLeaseResponse(t *testing.T) {
	cases := map[string]string{
		"wrong version": "native-worker-v2 lease " + testToken + "\n",
		"wrong verb":    "native-worker-v1 stream\n",
		"double space":  "native-worker-v1  lease " + testToken + "\n",
		"leading space": " " + testLeaseLine,
		"upper token":   "native-worker-v1 lease " + strings.ToUpper(testToken) + "\n",
		"short token":   "native-worker-v1 lease " + testToken[:63] + "\n",
		"long token":    "native-worker-v1 lease " + testToken + "0\n",
		"zero token":    "native-worker-v1 lease " + strings.Repeat("0", 64) + "\n",
		"crlf":          "native-worker-v1 lease " + testToken + "\r\n",
		"trailing tab":  "native-worker-v1 lease " + testToken + "\t\n",
		"extra bytes":   testLeaseLine + "x",
		"too long":      strings.Repeat("a", maxLine+10),
	}
	for name, resp := range cases {
		t.Run(name, func(t *testing.T) {
			h := newFakeHost()
			ctx, cancel := context.WithTimeout(context.Background(), wait)
			defer cancel()
			ch := startAcquire(ctx, testBinding, h.dial)
			srv := h.accept(t)
			readLine(t, srv)
			writeAsync(srv, resp)
			r := waitAcquire(t, ch)
			if r.l != nil || !errors.Is(r.err, ErrProtocol) {
				t.Fatalf("Acquire = %v, %v; want ErrProtocol", r.l, r.err)
			}
			if strings.Contains(r.err.Error(), testToken) {
				t.Fatal("error leaks token")
			}
			expectPeerClosed(t, srv)
		})
	}

	t.Run("eof", func(t *testing.T) {
		h := newFakeHost()
		ch := startAcquire(context.Background(), testBinding, h.dial)
		srv := h.accept(t)
		readLine(t, srv)
		srv.Close()
		if r := waitAcquire(t, ch); r.l != nil || r.err == nil {
			t.Fatalf("Acquire = %v, %v; want error", r.l, r.err)
		}
	})
}

func TestMalformedStreamAck(t *testing.T) {
	cases := map[string]string{
		"wrong verb":    "native-worker-v1 streams\n",
		"trailing sp":   "native-worker-v1 stream \n",
		"lease line":    testLeaseLine,
		"crlf":          "native-worker-v1 stream\r\n",
		"too long":      strings.Repeat("s", maxLine+1),
		"wrong version": "native-worker-v0 stream\n",
	}
	for name, resp := range cases {
		t.Run(name, func(t *testing.T) {
			h := newFakeHost()
			l, _ := acquire(t, context.Background(), h)
			ch := startOpen(context.Background(), l)
			srv := h.accept(t)
			readLine(t, srv)
			writeAsync(srv, resp)
			r := waitOpen(t, ch)
			if r.c != nil || !errors.Is(r.err, ErrProtocol) {
				t.Fatalf("Open = %v, %v; want ErrProtocol", r.c, r.err)
			}
			if strings.Contains(r.err.Error(), testToken) {
				t.Fatal("error leaks token")
			}
			expectPeerClosed(t, srv)
			if n := activeCount(l); n != 0 {
				t.Fatalf("slot leak: %d active", n)
			}
			select {
			case <-l.Done():
				t.Fatal("failed Open ended lease")
			default:
			}
		})
	}
}

func TestCanceledAcquireHandshake(t *testing.T) {
	t.Run("cancel during read", func(t *testing.T) {
		h := newFakeHost()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		ch := startAcquire(ctx, testBinding, h.dial)
		srv := h.accept(t)
		readLine(t, srv) // host stays silent
		cancel()
		if r := waitAcquire(t, ch); r.l != nil || !errors.Is(r.err, context.Canceled) {
			t.Fatalf("Acquire = %v, %v; want Canceled", r.l, r.err)
		}
		expectPeerClosed(t, srv)
	})
	t.Run("deadline during write", func(t *testing.T) {
		h := newFakeHost()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
		defer cancel()
		ch := startAcquire(ctx, testBinding, h.dial)
		srv := h.accept(t) // host never reads the claim line
		if r := waitAcquire(t, ch); r.l != nil || !errors.Is(r.err, context.DeadlineExceeded) {
			t.Fatalf("Acquire = %v, %v; want DeadlineExceeded", r.l, r.err)
		}
		expectPeerClosed(t, srv)
	})
	t.Run("late dial closed", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
		defer cancel()
		late := make(chan net.Conn, 1)
		dial := func(ctx context.Context) (net.Conn, error) {
			<-ctx.Done()
			c, s := net.Pipe()
			late <- s
			return c, nil // succeeds despite cancellation
		}
		if r := waitAcquire(t, startAcquire(ctx, testBinding, dial)); r.l != nil || r.err == nil {
			t.Fatalf("Acquire = %v, %v; want error", r.l, r.err)
		}
		s := <-late
		defer s.Close()
		expectPeerClosed(t, s)
	})
}

func TestCanceledOpenHandshake(t *testing.T) {
	h := newFakeHost()
	l, _ := acquire(t, context.Background(), h)

	ctx, cancel := context.WithCancel(context.Background())
	ch := startOpen(ctx, l)
	srv := h.accept(t)
	readLine(t, srv) // host stays silent
	cancel()
	if r := waitOpen(t, ch); r.c != nil || !errors.Is(r.err, context.Canceled) {
		t.Fatalf("Open = %v, %v; want Canceled", r.c, r.err)
	}
	expectPeerClosed(t, srv)
	if n := activeCount(l); n != 0 {
		t.Fatalf("slot leak: %d active", n)
	}

	// A late successful dial after the deadline is closed and its slot freed.
	late := make(chan net.Conn, 1)
	l.dial = func(ctx context.Context) (net.Conn, error) {
		<-ctx.Done()
		c, s := net.Pipe()
		late <- s
		return c, nil
	}
	sctx, scancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer scancel()
	if _, err := l.Open(sctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Open = %v, want DeadlineExceeded", err)
	}
	s := <-late
	defer s.Close()
	expectPeerClosed(t, s)
	if n := activeCount(l); n != 0 {
		t.Fatalf("slot leak: %d active", n)
	}
}

func TestStreamLimitAndReuse(t *testing.T) {
	h := newFakeHost()
	l, _ := acquire(t, context.Background(), h)

	var streams []net.Conn
	for i := 0; i < maxStreams; i++ {
		c, _ := openStream(t, l, h)
		streams = append(streams, c)
	}
	// The limit is checked before Dial, so Open fails without blocking.
	dials := h.dials.Load()
	if _, err := l.Open(context.Background()); !errors.Is(err, ErrStreamLimit) {
		t.Fatalf("9th Open = %v, want ErrStreamLimit", err)
	}
	if h.dials.Load() != dials {
		t.Fatal("dialed beyond limit")
	}

	// Double close must release exactly one slot.
	streams[0].Close()
	streams[0].Close()
	openStream(t, l, h)
	if _, err := l.Open(context.Background()); !errors.Is(err, ErrStreamLimit) {
		t.Fatalf("Open after reuse = %v, want ErrStreamLimit", err)
	}
	if n := activeCount(l); n != maxStreams {
		t.Fatalf("active = %d, want %d", n, maxStreams)
	}
}

func TestPendingOpensCountAndCloseCancels(t *testing.T) {
	h := newFakeHost()
	l, _ := acquire(t, context.Background(), h)
	<-h.entered // the Acquire dial

	errs := make(chan error, maxStreams)
	for i := 0; i < maxStreams; i++ {
		go func() {
			_, err := l.Open(context.Background())
			errs <- err
		}()
	}
	for i := 0; i < maxStreams; i++ {
		select {
		case <-h.entered: // slot is reserved before Dial is entered
		case <-time.After(wait):
			t.Fatal("pending dials not reached")
		}
	}
	if _, err := l.Open(context.Background()); !errors.Is(err, ErrStreamLimit) {
		t.Fatalf("Open with 8 pending = %v, want ErrStreamLimit", err)
	}

	l.Close()
	for i := 0; i < maxStreams; i++ {
		select {
		case err := <-errs:
			if !errors.Is(err, ErrLeaseClosed) {
				t.Fatalf("pending Open = %v, want ErrLeaseClosed", err)
			}
		case <-time.After(wait):
			t.Fatal("pending Open not interrupted by Close")
		}
	}
}

func TestCloseInterruptsPendingHandshake(t *testing.T) {
	h := newFakeHost()
	l, _ := acquire(t, context.Background(), h)
	ch := startOpen(context.Background(), l)
	srv := h.accept(t)
	readLine(t, srv) // host stays silent
	l.Close()
	if r := waitOpen(t, ch); !errors.Is(r.err, ErrLeaseClosed) {
		t.Fatalf("Open = %v, %v; want ErrLeaseClosed", r.c, r.err)
	}
	expectPeerClosed(t, srv)
}

func serveStream(s net.Conn) {
	var b [1]byte
	var line []byte
	for len(line) < maxLine {
		if _, err := s.Read(b[:]); err != nil {
			return
		}
		line = append(line, b[0])
		if b[0] == '\n' {
			break
		}
	}
	if string(line) != testOpenLine {
		s.Close()
		return
	}
	io.WriteString(s, testStreamAck)
}

func TestConcurrentOpenClose(t *testing.T) {
	h := newFakeHost()
	l, _ := acquire(t, context.Background(), h)

	var srvMu sync.Mutex
	var srvConns []net.Conn
	stop := make(chan struct{})
	var hostWG sync.WaitGroup
	hostWG.Add(1)
	go func() {
		defer hostWG.Done()
		for {
			select {
			case s := <-h.conns:
				srvMu.Lock()
				srvConns = append(srvConns, s)
				srvMu.Unlock()
				go serveStream(s)
			case <-stop:
				return
			}
		}
	}()
	defer func() {
		srvMu.Lock()
		for _, s := range srvConns {
			s.Close()
		}
		srvMu.Unlock()
	}()

	var (
		mu         sync.Mutex
		streams    []net.Conn
		unexpected []error
		once       sync.Once
		wg         sync.WaitGroup
	)
	firstOK := make(chan struct{})
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
				c, err := l.Open(ctx)
				cancel()
				mu.Lock()
				switch {
				case err == nil:
					if (i+j)%2 == 0 {
						c.Close()
					} else {
						streams = append(streams, c)
					}
					once.Do(func() { close(firstOK) })
				case errors.Is(err, ErrStreamLimit), errors.Is(err, ErrLeaseClosed),
					errors.Is(err, context.DeadlineExceeded):
				default:
					unexpected = append(unexpected, err)
				}
				mu.Unlock()
			}
		}(i)
	}

	select {
	case <-firstOK:
	case <-time.After(wait):
		l.Close()
		wg.Wait()
		close(stop)
		hostWG.Wait()
		t.Fatal("no Open succeeded")
	}
	if err := l.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	wg.Wait()
	close(stop)
	hostWG.Wait()

	for _, err := range unexpected {
		t.Errorf("unexpected Open error: %v", err)
	}
	for _, c := range streams {
		expectLocalClosed(t, c)
		c.Close()
	}
	if n := activeCount(l); n != 0 {
		t.Fatalf("active after Close = %d", n)
	}
	if _, err := l.Open(context.Background()); !errors.Is(err, ErrLeaseClosed) {
		t.Fatalf("Open after Close = %v, want ErrLeaseClosed", err)
	}
}

func TestTokenNotExposed(t *testing.T) {
	h := newFakeHost()
	l, _ := acquire(t, context.Background(), h)
	s := fmt.Sprintf("%v|%+v|%#v|%s", l, l, l, l)
	if strings.Contains(s, testToken) {
		t.Fatalf("formatted lease leaks token: %s", s)
	}
}

func TestShutdownDiscardsBufferedStreamBytes(t *testing.T) {
	for _, wholeLease := range []bool{false, true} {
		t.Run(fmt.Sprint(wholeLease), func(t *testing.T) {
			h := newFakeHost()
			l, _ := acquire(t, context.Background(), h)
			ch := startOpen(context.Background(), l)
			srv := h.accept(t)
			readLine(t, srv)
			writeAsync(srv, testStreamAck+"buffered worker output")
			r := waitOpen(t, ch)
			if r.err != nil {
				t.Fatal(r.err)
			}
			if wholeLease {
				l.Close()
			} else {
				r.c.Close()
			}
			b := make([]byte, 32)
			n, err := r.c.Read(b)
			if n != 0 || !errors.Is(err, net.ErrClosed) {
				t.Fatalf("read after shutdown = %d, %v", n, err)
			}
		})
	}
}

func TestCloseDrainsLateSuccessfulDial(t *testing.T) {
	h := newFakeHost()
	l, _ := acquire(t, context.Background(), h)
	entered, release := make(chan struct{}), make(chan struct{})
	client, server := net.Pipe()
	defer server.Close()
	l.dial = func(ctx context.Context) (net.Conn, error) { close(entered); <-release; return client, nil }
	open := startOpen(context.Background(), l)
	<-entered
	closed := make(chan struct{})
	go func() { l.Close(); close(closed) }()
	<-l.ctx.Done()
	select {
	case <-closed:
		t.Fatal("Close returned while dial still owned a connection")
	default:
	}
	select {
	case <-l.Done():
		t.Fatal("Done closed before pending dial drained")
	default:
	}
	close(release)
	if r := waitOpen(t, open); !errors.Is(r.err, ErrLeaseClosed) {
		t.Fatal(r.err)
	}
	select {
	case <-closed:
	case <-time.After(wait):
		t.Fatal("Close did not finish")
	}
	expectPeerClosed(t, server)
}

type shortWriter struct{ net.Conn }

func (shortWriter) Write(b []byte) (int, error) { return len(b) - 1, nil }
func TestShortHandshakeWriteFailsClosed(t *testing.T) {
	client, server := net.Pipe()
	defer server.Close()
	l, err := Acquire(context.Background(), testBinding, func(context.Context) (net.Conn, error) { return shortWriter{client}, nil })
	if l != nil || !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("Acquire=%v,%v", l, err)
	}
	expectPeerClosed(t, server)
}
