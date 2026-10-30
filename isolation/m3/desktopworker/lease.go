// Package desktopworker is the guest-side client for the native-worker-v1
// lease protocol.
//
// Trust model: the protocol targets the NucBox T0-hv operator-trusted host,
// reached through the kernel-authenticated fixed vsock CID (host 19595) and a
// per-VM pinned bridge. It is not a host-excluded (SNP) design. Dial is a
// trusted caller injection; production callers must bind it to that fixed
// vsock endpoint. This package does not authenticate arbitrary remote
// transports and does not prove GPU confidentiality or physical allocation.
// A root-only monitor holds the Lease; the masking service only sees a
// peer-UID authenticated Unix endpoint, and the untrusted worker only ever
// receives masked protocol bytes.
package desktopworker

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"time"
)

const (
	proto            = "native-worker-v1 "
	ackStream        = proto + "stream\n"
	maxLine          = 512
	handshakeTimeout = 5 * time.Second
	maxStreams       = 8
)

var (
	ErrInvalidBinding = errors.New("desktopworker: invalid binding")
	ErrProtocol       = errors.New("desktopworker: protocol violation")
	ErrLeaseClosed    = errors.New("desktopworker: lease closed")
	ErrStreamLimit    = errors.New("desktopworker: stream limit reached")
)

// Binding identifies the claim. All hex fields are lowercase, exact length
// and not all zero.
type Binding struct {
	Boot, Claim, AppID, ProfileSHA string
	GPUMilli                       int
}

// Dial opens a new connection to the host. It must honor ctx.
type Dial func(context.Context) (net.Conn, error)

// Lease is a granted claim. The control connection stays silent for the
// lease's lifetime; any byte, EOF or error on it ends the lease and closes
// every stream. There is no reconnect: the host refuses a second claim.
type Lease struct {
	ctx    context.Context // derived from the Acquire ctx; canceled on shutdown
	cancel context.CancelFunc
	dial   Dial
	ctrl   net.Conn
	done   chan struct{}

	mu      sync.Mutex
	closed  bool
	token   string
	nextID  uint64
	active  map[uint64]net.Conn // one entry per reserved slot; nil while dialing
	pending sync.WaitGroup      // Open operations must drain before Done closes
}

func (b Binding) validate() error {
	switch {
	case !isHex(b.Boot, 32):
		return fmt.Errorf("%w: Boot", ErrInvalidBinding)
	case !isHex(b.Claim, 64):
		return fmt.Errorf("%w: Claim", ErrInvalidBinding)
	case !isHex(b.AppID, 64):
		return fmt.Errorf("%w: AppID", ErrInvalidBinding)
	case !isHex(b.ProfileSHA, 64):
		return fmt.Errorf("%w: ProfileSHA", ErrInvalidBinding)
	case b.GPUMilli < 500 || b.GPUMilli > 1000:
		return fmt.Errorf("%w: GPUMilli", ErrInvalidBinding)
	}
	return nil
}

// isHex reports whether s is exactly n lowercase hex digits, not all zero.
func isHex(s string, n int) bool {
	if len(s) != n {
		return false
	}
	nonzero := false
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c == '0':
		case c >= '1' && c <= '9', c >= 'a' && c <= 'f':
			nonzero = true
		default:
			return false
		}
	}
	return nonzero
}

// Acquire claims the lease. The handshake is bounded by 5 seconds or ctx,
// whichever is sooner; the lease itself lives until ctx ends, Close is
// called, or the control connection is disturbed.
func Acquire(ctx context.Context, b Binding, dial Dial) (*Lease, error) {
	if dial == nil {
		return nil, errors.New("desktopworker: nil dial")
	}
	if err := b.validate(); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	line := proto + "claim " + b.Boot + " " + b.Claim + " " + b.AppID + " " +
		b.ProfileSHA + " " + strconv.Itoa(b.GPUMilli) + "\n"

	hctx, cancel := context.WithTimeout(ctx, handshakeTimeout)
	defer cancel()
	conn, err := dialConn(hctx, dial)
	if err != nil {
		return nil, err
	}
	resp, extra, err := handshake(hctx, conn, line)
	if err != nil {
		conn.Close()
		return nil, err
	}
	token, ok := parseLease(resp)
	if !ok || len(extra) > 0 {
		conn.Close()
		return nil, fmt.Errorf("%w: malformed lease response", ErrProtocol)
	}

	lctx, lcancel := context.WithCancel(ctx)
	l := &Lease{
		ctx:    lctx,
		cancel: lcancel,
		dial:   dial,
		ctrl:   conn,
		done:   make(chan struct{}),
		token:  token,
		active: make(map[uint64]net.Conn),
	}
	context.AfterFunc(lctx, l.shutdown)
	go l.monitor()
	return l, nil
}

func parseLease(resp string) (string, bool) {
	rest, ok := cutPrefix(resp, proto+"lease ")
	if !ok || len(rest) != 65 || rest[64] != '\n' {
		return "", false
	}
	token := rest[:64]
	return token, isHex(token, 64)
}

func cutPrefix(s, prefix string) (string, bool) {
	if len(s) < len(prefix) || s[:len(prefix)] != prefix {
		return "", false
	}
	return s[len(prefix):], true
}

// dialConn dials and closes any connection that arrives after ctx ended.
func dialConn(ctx context.Context, dial Dial) (net.Conn, error) {
	conn, err := dial(ctx)
	if err != nil {
		if conn != nil {
			conn.Close()
		}
		return nil, fmt.Errorf("desktopworker: dial: %w", err)
	}
	if conn == nil {
		return nil, errors.New("desktopworker: dial returned nil connection")
	}
	if err := ctx.Err(); err != nil {
		conn.Close()
		return nil, fmt.Errorf("desktopworker: dial: %w", err)
	}
	return conn, nil
}

// handshake writes line and reads one response line. Cancellation of ctx
// closes conn, interrupting any blocked I/O. It returns any bytes that were
// buffered beyond the response line.
func handshake(ctx context.Context, conn net.Conn, line string) (string, []byte, error) {
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	resp, extra, err := exchange(conn, line)
	if !stop() {
		return "", nil, fmt.Errorf("desktopworker: handshake: %w", ctx.Err())
	}
	return resp, extra, err
}

func exchange(conn net.Conn, line string) (string, []byte, error) {
	if n, err := io.WriteString(conn, line); err != nil {
		return "", nil, fmt.Errorf("desktopworker: handshake write: %w", err)
	} else if n != len(line) {
		return "", nil, io.ErrShortWrite
	}
	r := bufio.NewReaderSize(conn, maxLine)
	raw, err := r.ReadSlice('\n')
	if errors.Is(err, bufio.ErrBufferFull) {
		return "", nil, fmt.Errorf("%w: response line too long", ErrProtocol)
	}
	if err != nil {
		return "", nil, fmt.Errorf("desktopworker: handshake read: %w", err)
	}
	resp := string(raw)
	var extra []byte
	if n := r.Buffered(); n > 0 {
		peek, _ := r.Peek(n)
		extra = append([]byte(nil), peek...)
	}
	return resp, extra, nil
}

// monitor ends the lease on the first byte, EOF or error from the control
// connection, which must stay silent.
func (l *Lease) monitor() {
	var b [1]byte
	io.ReadFull(l.ctrl, b[:])
	l.shutdown()
}

func (l *Lease) shutdown() {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return
	}
	l.closed = true
	l.token = ""
	conns := []net.Conn{l.ctrl}
	for _, c := range l.active {
		if c != nil {
			conns = append(conns, c)
		}
	}
	l.active = nil
	l.mu.Unlock()

	l.cancel()
	for _, c := range conns {
		c.Close()
	}
	l.pending.Wait()
	close(l.done)
}

// Close ends the lease and closes the control connection, every stream and
// every pending stream handshake. It is idempotent.
func (l *Lease) Close() error {
	l.shutdown()
	<-l.done
	return nil
}

// Done is closed once the lease has ended and its connections are closed.
func (l *Lease) Done() <-chan struct{} { return l.done }

func (l *Lease) String() string   { return "desktopworker.Lease{token:redacted}" }
func (l *Lease) GoString() string { return l.String() }

// Open dials a new worker stream. At most 8 streams, including pending
// ones, may exist per lease; Open fails fast with ErrStreamLimit beyond that.
func (l *Lease) Open(ctx context.Context) (net.Conn, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return nil, ErrLeaseClosed
	}
	if len(l.active) >= maxStreams {
		l.mu.Unlock()
		return nil, ErrStreamLimit
	}
	l.nextID++
	id := l.nextID
	l.active[id] = nil
	l.pending.Add(1)
	line := proto + "open " + l.token + "\n"
	l.mu.Unlock()
	defer l.pending.Done()

	octx, cancel := context.WithTimeout(ctx, handshakeTimeout)
	defer cancel()
	stopLink := context.AfterFunc(l.ctx, cancel)
	defer stopLink()

	conn, err := dialConn(octx, l.dial)
	if err != nil {
		return nil, l.fail(id, nil, err)
	}
	if !l.track(id, conn) {
		return nil, l.fail(id, conn, ErrLeaseClosed)
	}
	resp, extra, err := handshake(octx, conn, line)
	if err == nil && resp != ackStream {
		err = fmt.Errorf("%w: malformed stream acknowledgment", ErrProtocol)
	}
	if err == nil && !l.track(id, conn) {
		err = ErrLeaseClosed
	}
	if err != nil {
		return nil, l.fail(id, conn, err)
	}
	s := &stream{Conn: conn, lease: l, id: id, pending: extra}
	if !l.track(id, s) {
		return nil, l.fail(id, s, ErrLeaseClosed)
	}
	return s, nil
}

// track records conn for slot id so shutdown closes it. It reports false if
// the lease has closed (which also drops the slot).
func (l *Lease) track(id uint64, conn net.Conn) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.active[id]; !ok || l.closed {
		return false
	}
	l.active[id] = conn
	return true
}

// release frees slot id. Deleting a missing entry is a no-op, so a slot can
// never be released twice.
func (l *Lease) release(id uint64) {
	l.mu.Lock()
	delete(l.active, id)
	l.mu.Unlock()
}

func (l *Lease) fail(id uint64, conn net.Conn, err error) error {
	if conn != nil {
		conn.Close()
	}
	l.release(id)
	l.mu.Lock()
	closed := l.closed
	l.mu.Unlock()
	if closed {
		return ErrLeaseClosed
	}
	return err
}

// stream is an opaque worker connection. Bytes the host sent together with
// the acknowledgment are returned first, unmodified.
type stream struct {
	net.Conn
	lease *Lease
	id    uint64

	mu      sync.Mutex
	pending []byte
	closed  bool

	once sync.Once
	err  error
}

func (s *stream) Read(p []byte) (int, error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return 0, net.ErrClosed
	}
	if len(s.pending) > 0 {
		n := copy(p, s.pending)
		s.pending = s.pending[n:]
		s.mu.Unlock()
		return n, nil
	}
	s.mu.Unlock()
	return s.Conn.Read(p)
}

func (s *stream) Close() error {
	s.once.Do(func() {
		s.mu.Lock()
		s.closed = true
		s.pending = nil
		s.mu.Unlock()
		s.err = s.Conn.Close()
		s.lease.release(s.id)
	})
	return s.err
}
