package tuna

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	nkn "github.com/nknorg/nkn-sdk-go"
	"github.com/nknorg/nkn/v2/crypto/ed25519"
	"github.com/nknorg/tuna/pb"
	"github.com/xtaci/smux"
)

type testUSDCController struct {
	mu         sync.Mutex
	transcript USDCTranscript
	session    *testUSDCSession
	reject     bool
}
type testUSDCSession struct {
	mu                sync.Mutex
	confirmed, closed bool
	bytes             int
	ticket            int
	reserved          map[string]int
}

func (c *testUSDCController) Open(_ context.Context, t USDCTranscript, proof json.RawMessage) (USDCSession, json.RawMessage, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.transcript = t
	if c.reject {
		return nil, nil, errors.New("unauthorized")
	}
	if t.Server && !bytes.Equal(proof, []byte(`"runner"`)) {
		return nil, nil, errors.New("wrong runner proof")
	}
	c.session = &testUSDCSession{reserved: map[string]int{}}
	if t.Server {
		return c.session, []byte(`"provider"`), nil
	}
	return c.session, []byte(`"runner"`), nil
}
func (s *testUSDCSession) Confirm(_ context.Context, p json.RawMessage) error {
	if p != nil && !bytes.Equal(p, []byte(`"provider"`)) {
		return errors.New("wrong provider proof")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.confirmed = true
	return nil
}
func (s *testUSDCSession) Reserve(_ context.Context, _ string, n int) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.confirmed || s.closed {
		return "", errors.New("not authorized")
	}
	s.ticket++
	key := time.Now().String()
	s.reserved[key] = n
	return key, nil
}
func (s *testUSDCSession) Commit(_ context.Context, t string, n int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.reserved[t]
	if !ok || n < 0 || n > r {
		return errors.New("bad reservation")
	}
	delete(s.reserved, t)
	s.bytes += n
	return nil
}
func (s *testUSDCSession) Remote(context.Context, json.RawMessage) (json.RawMessage, error) {
	return []byte(`{"signature":"test"}`), nil
}
func (s *testUSDCSession) Next(ctx context.Context) (string, json.RawMessage, error) {
	select {
	case <-ctx.Done():
		return "", nil, ctx.Err()
	case <-time.After(10 * time.Millisecond):
		return "id", []byte(`{"type":"snapshot"}`), nil
	}
}
func (s *testUSDCSession) Reply(_ context.Context, _ string, p json.RawMessage) error {
	if !bytes.Equal(p, []byte(`{"signature":"test"}`)) {
		return errors.New("bad reply")
	}
	return nil
}
func (s *testUSDCSession) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	return nil
}
func (s *testUSDCSession) total() int { s.mu.Lock(); defer s.mu.Unlock(); return s.bytes }
func testUSDCCommon(t *testing.T, server bool, controller USDCController) *Common {
	t.Helper()
	seed := bytes.Repeat([]byte{3}, 32)
	if server {
		seed = bytes.Repeat([]byte{4}, 32)
	}
	a, err := nkn.NewAccount(seed)
	if err != nil {
		t.Fatal(err)
	}
	w, err := nkn.NewWallet(a, nil)
	if err != nil {
		t.Fatal(err)
	}
	var sk [ed25519.PrivateKeySize]byte
	copy(sk[:], ed25519.GetPrivateKeyFromSeed(w.Seed()))
	return &Common{Wallet: w, IsServer: server, USDC: controller, encryptionAlgo: pb.EncryptionAlgo_ENCRYPTION_XSALSA20_POLY1305, curveSecretKey: ed25519.PrivateKeyToCurve25519PrivateKey(&sk), sharedKeys: make(map[string]*[sharedKeySize]byte), reverseBytesEntryToExit: map[string][]uint64{}, reverseBytesExitToEntry: map[string][]uint64{}, sessionsWaitGroup: &sync.WaitGroup{}}
}
func testUSDCPair(t *testing.T, client, server *Common) (net.Conn, net.Conn, error, error) {
	t.Helper()
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	type result struct {
		conn net.Conn
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		raw, err := listener.Accept()
		if err != nil {
			ch <- result{err: err}
			return
		}
		conn, _, err := server.wrapConn(raw, nil, nil)
		if err != nil {
			raw.Close()
		}
		ch <- result{conn, err}
	}()
	raw, e := net.Dial("tcp", listener.Addr().String())
	if e != nil {
		t.Fatal(e)
	}
	conn, _, err := client.wrapConn(raw, server.Wallet.PubKey(), nil)
	if err != nil {
		raw.Close()
	}
	remote := <-ch
	return conn, remote.conn, err, remote.err
}
func TestUSDCEncryptedMetering(t *testing.T) {
	a, b := &testUSDCController{}, &testUSDCController{}
	client, server := testUSDCCommon(t, false, a), testUSDCCommon(t, true, b)
	ca, cb, ea, eb := testUSDCPair(t, client, server)
	if ea != nil || eb != nil {
		t.Fatal(ea, eb)
	}
	defer ca.Close()
	defer cb.Close()
	if a.transcript.ClientKey != b.transcript.ClientKey || a.transcript.ProviderKey != b.transcript.ProviderKey || a.transcript.Nonce != b.transcript.Nonce || len(a.transcript.Nonce) != 64 {
		t.Fatal("unbound transcript")
	}
	if a.transcript.ClientKey != hex.EncodeToString(client.Wallet.PubKey()) {
		t.Fatal("wrong transport identity")
	}
	sc, e := smux.Client(ca, nil)
	if e != nil {
		t.Fatal(e)
	}
	ss, e := smux.Server(cb, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer sc.Close()
	defer ss.Close()
	client.bindUSDC(sc, ca)
	server.bindUSDC(ss, cb)
	ps, e := openPaymentStream(sc)
	if e != nil {
		t.Fatal(e)
	}
	controlDone := make(chan error, 1)
	controlReady := make(chan struct{})
	go func() {
		p, err := ss.AcceptStream()
		if err == nil {
			_, err = readStreamMetadata(p)
		}
		if err == nil {
			close(controlReady)
			err = server.serveUSDCPayment(ss, p)
		}
		controlDone <- err
	}()
	client.startUSDCPayment(sc, ps)
	<-controlReady
	stream, e := sc.OpenStream()
	if e != nil {
		t.Fatal(e)
	}
	remote, e := ss.AcceptStream()
	if e != nil {
		t.Fatal(e)
	}
	outgoing, incoming := client.serviceStream(sc, stream), server.serviceStream(ss, remote)
	payload := bytes.Repeat([]byte("guest-TLS-payload\x00\xff"), 2*1024*1024)
	done := make(chan error, 1)
	go func() { _, err := incoming.Write(payload); done <- err }()
	got := make([]byte, len(payload))
	if _, e = io.ReadFull(outgoing, got); e != nil {
		t.Fatal(e)
	}
	if e = <-done; e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(payload, got) {
		t.Fatal("payload changed")
	}
	if a.session.total() != len(payload) || b.session.total() != len(payload) {
		t.Fatalf("independent meters disagree: %d/%d", a.session.total(), b.session.total())
	}
	_ = sc.Close()
	_ = ss.Close()
	select {
	case <-controlDone:
	case <-time.After(time.Second):
		t.Fatal("control stream leaked")
	}
}
func TestUSDCRefusesDowngradeAndUnauthorizedPeer(t *testing.T) {
	for _, tc := range []struct {
		name string
		a, b USDCController
	}{{"legacy provider", &testUSDCController{}, nil}, {"legacy client", nil, &testUSDCController{}}, {"unauthorized", &testUSDCController{}, &testUSDCController{reject: true}}} {
		t.Run(tc.name, func(t *testing.T) {
			a, b := testUSDCCommon(t, false, tc.a), testUSDCCommon(t, true, tc.b)
			ca, cb, ea, eb := testUSDCPair(t, a, b)
			if ca != nil {
				ca.Close()
			}
			if cb != nil {
				cb.Close()
			}
			if ea == nil || eb == nil {
				t.Fatal("accepted missing authorization", ea, eb)
			}
		})
	}
}

// The Node integration test starts real proof-signing local controllers and
// invokes this test with their private loopback configuration.
func TestUSDCLocalControllerIntegration(t *testing.T) {
	raw := os.Getenv("ENCLAVE_USDC_TEST_CONTROLLERS")
	if raw == "" {
		t.Skip("local controller fixture not supplied")
	}
	var cfg struct{ Runner, Provider USDCLocalConfig }
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		t.Fatal(err)
	}
	a, err := NewLocalUSDCController(cfg.Runner)
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewLocalUSDCController(cfg.Provider)
	if err != nil {
		t.Fatal(err)
	}
	client, server := testUSDCCommon(t, false, a), testUSDCCommon(t, true, b)
	ca, cb, ea, eb := testUSDCPair(t, client, server)
	if ea != nil || eb != nil {
		t.Fatal(ea, eb)
	}
	defer ca.Close()
	defer cb.Close()
	sc, err := smux.Client(ca, nil)
	if err != nil {
		t.Fatal(err)
	}
	ss, err := smux.Server(cb, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer sc.Close()
	defer ss.Close()
	client.bindUSDC(sc, ca)
	server.bindUSDC(ss, cb)
	ps, err := openPaymentStream(sc)
	if err != nil {
		t.Fatal(err)
	}
	ready := make(chan struct{})
	go func() {
		p, e := ss.AcceptStream()
		if e == nil {
			_, e = readStreamMetadata(p)
		}
		close(ready)
		if e == nil {
			_ = server.serveUSDCPayment(ss, p)
		}
	}()
	client.startUSDCPayment(sc, ps)
	<-ready
	stream, err := sc.OpenStream()
	if err != nil {
		t.Fatal(err)
	}
	remote, err := ss.AcceptStream()
	if err != nil {
		t.Fatal(err)
	}
	outgoing, incoming := client.serviceStream(sc, stream), server.serviceStream(ss, remote)
	payload := bytes.Repeat([]byte("tls-passthrough\x00"), 128*1024)
	done := make(chan error, 1)
	go func() { _, e := outgoing.Write(payload); done <- e }()
	got := make([]byte, len(payload))
	if _, err = io.ReadFull(incoming, got); err != nil {
		t.Fatal(err)
	}
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(payload, got) {
		t.Fatal("payload differs")
	}
	// Allow the controller's one-second settlement tick to cross the encrypted
	// control stream after both independent meters have committed their bytes.
	wait := 1500
	if n, e := strconv.Atoi(os.Getenv("ENCLAVE_USDC_TEST_WAIT_MS")); e == nil && n >= 1500 && n <= 10000 {
		wait = n
	}
	time.Sleep(time.Duration(wait) * time.Millisecond)
}

// TLS terminates at the guest service. The provider carries the handshake and
// encrypted application records without a certificate or guest private key.
type tlsMeteredConn struct {
	net.Conn
	io.ReadWriteCloser
}

func (c tlsMeteredConn) Read(p []byte) (int, error)  { return c.ReadWriteCloser.Read(p) }
func (c tlsMeteredConn) Write(p []byte) (int, error) { return c.ReadWriteCloser.Write(p) }
func (c tlsMeteredConn) Close() error                { return c.ReadWriteCloser.Close() }
func TestUSDCTLSServiceHandler(t *testing.T) {
	guest := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil {
			t.Error("guest did not terminate TLS")
		}
		_, _ = io.WriteString(w, "guest TLS verified")
	}))
	defer guest.Close()
	address := guest.Listener.Addr().(*net.TCPAddr)
	a, b := &testUSDCController{}, &testUSDCController{}
	client, server := testUSDCCommon(t, false, a), testUSDCCommon(t, true, b)
	ca, cb, ea, eb := testUSDCPair(t, client, server)
	if ea != nil || eb != nil {
		t.Fatal(ea, eb)
	}
	defer ca.Close()
	defer cb.Close()
	sc, e := smux.Client(ca, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer sc.Close()
	ss, e := smux.Server(cb, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	client.bindUSDC(sc, ca)
	server.bindUSDC(ss, cb)
	// No NKN client is present: accidental NanoPay access fails the test.
	provider := &TunaExit{Common: server, config: &ExitConfiguration{DialTimeout: 5, Services: map[string]ExitServiceInfo{"guest": {Address: "127.0.0.1", Price: "0"}}}, services: []Service{{Name: "guest", TCP: []uint32{uint32(address.Port)}}}}
	done := make(chan struct{})
	go func() {
		provider.handleSession(ss, &pb.ConnectionMetadata{PublicKey: client.Wallet.PubKey(), Nonce: bytes.Repeat([]byte{1}, 32)})
		close(done)
	}()
	payment, e := openPaymentStream(sc)
	if e != nil {
		t.Fatal(e)
	}
	client.startUSDCPayment(sc, payment)
	stream, e := sc.OpenStream()
	if e != nil {
		t.Fatal(e)
	}
	if e = writeStreamMetadata(stream, &pb.StreamMetadata{ServiceId: 0, PortId: 0}); e != nil {
		t.Fatal(e)
	}
	roots := x509.NewCertPool()
	roots.AddCert(guest.Certificate())
	secure := tls.Client(tlsMeteredConn{Conn: stream, ReadWriteCloser: client.serviceStream(sc, stream)}, &tls.Config{RootCAs: roots, ServerName: "example.com", MinVersion: tls.VersionTLS12})
	_ = secure.SetDeadline(time.Now().Add(10 * time.Second))
	if e = secure.Handshake(); e != nil {
		t.Fatal(e)
	}
	if len(secure.ConnectionState().VerifiedChains) == 0 {
		t.Fatal("TLS certificate was not verified")
	}
	_, e = io.WriteString(secure, "GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n")
	if e != nil {
		t.Fatal(e)
	}
	response, e := http.ReadResponse(bufio.NewReader(secure), nil)
	if e != nil {
		t.Fatal(e)
	}
	body, e := io.ReadAll(response.Body)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	// Drain the guest's TLS close_notify so both ends have observed the same
	// final wire bytes, rather than comparing sent bytes to unread buffered data.
	if _, e = io.Copy(io.Discard, secure); e != nil {
		t.Fatal(e)
	}
	if string(body) != "guest TLS verified" {
		t.Fatalf("unexpected guest response: %q", body)
	}
	// Both peers record TLS wire bytes, not fabricated plaintext byte claims.
	if a.session.total() == 0 || a.session.total() != b.session.total() {
		t.Fatalf("TLS meters differ: %d/%d", a.session.total(), b.session.total())
	}
	_ = sc.Close()
	_ = ss.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("provider session leaked")
	}
}

func TestUSDCConcurrentProviderHandlers(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, e := listener.Accept()
			if e != nil {
				return
			}
			go func() { defer conn.Close(); _, _ = io.Copy(conn, conn) }()
		}
	}()
	server := testUSDCCommon(t, true, &testUSDCController{})
	provider := &TunaExit{Common: server, config: &ExitConfiguration{DialTimeout: 5, Services: map[string]ExitServiceInfo{"echo": {Address: "127.0.0.1", Price: "0"}}}, services: []Service{{Name: "echo", TCP: []uint32{uint32(listener.Addr().(*net.TCPAddr).Port)}}}}
	for i := 0; i < 8; i++ {
		t.Run(strconv.Itoa(i), func(t *testing.T) {
			t.Parallel()
			client := testUSDCCommon(t, false, &testUSDCController{})
			ca, cb, ea, eb := testUSDCPair(t, client, server)
			if ea != nil || eb != nil {
				t.Fatal(ea, eb)
			}
			defer ca.Close()
			defer cb.Close()
			sc, e := smux.Client(ca, nil)
			if e != nil {
				t.Fatal(e)
			}
			defer sc.Close()
			ss, e := smux.Server(cb, nil)
			if e != nil {
				t.Fatal(e)
			}
			defer ss.Close()
			client.bindUSDC(sc, ca)
			server.bindUSDC(ss, cb)
			done := make(chan struct{})
			go func() {
				provider.handleSession(ss, &pb.ConnectionMetadata{PublicKey: client.Wallet.PubKey(), Nonce: bytes.Repeat([]byte{byte(i + 1)}, 32)})
				close(done)
			}()
			raw, e := sc.OpenStream()
			if e != nil {
				t.Fatal(e)
			}
			_ = raw.SetDeadline(time.Now().Add(5 * time.Second))
			if e = writeStreamMetadata(raw, &pb.StreamMetadata{ServiceId: 0, PortId: 0}); e != nil {
				t.Fatal(e)
			}
			stream := client.serviceStream(sc, raw)
			payload := bytes.Repeat([]byte{byte(i)}, 32768)
			if _, e = stream.Write(payload); e != nil {
				t.Fatal(e)
			}
			got := make([]byte, len(payload))
			if _, e = io.ReadFull(stream, got); e != nil {
				t.Fatal(e)
			}
			if !bytes.Equal(payload, got) {
				t.Fatal("concurrent traffic mixed")
			}
			_ = sc.Close()
			_ = ss.Close()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("concurrent handler leaked")
			}
		})
	}
}
