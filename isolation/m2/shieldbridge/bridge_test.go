package shieldbridge

import (
	"context"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestPrivateRouteCopiesAndCancels(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	path := filepath.Join(t.TempDir(), "gpu0")
	var calls atomic.Int32
	b := Bridge{Path: path, UID: os.Getuid(), Dial: func(context.Context) (net.Conn, error) {
		calls.Add(1)
		a, z := net.Pipe()
		go func() { defer z.Close(); io.Copy(z, z) }()
		return a, nil
	}}
	ready := make(chan error, 1)
	done := make(chan error, 1)
	go func() { done <- b.Serve(ctx, ready) }()
	if err := <-ready; err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(path)
	if err != nil || st.Mode().Perm() != 0600 {
		t.Fatal("not private", st, err)
	}
	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(time.Second))
	sent := []byte{0, 1, 255, 42, 0}
	if _, err = c.Write(sent); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len(sent))
	if _, err = io.ReadFull(c, got); err != nil || string(got) != string(sent) {
		t.Fatal(got, err)
	}
	if calls.Load() != 1 {
		t.Fatal("wrong upstream count")
	}
	cancel()
	select {
	case err = <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation hung")
	}
}

func TestDoesNotReplaceAnExistingPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "gpu0")
	os.WriteFile(path, []byte("keep"), 0600)
	b := Bridge{Path: path, UID: os.Getuid(), Dial: func(context.Context) (net.Conn, error) { panic("must not dial") }}
	ready := make(chan error, 1)
	if b.Serve(context.Background(), ready) == nil {
		t.Fatal("accepted occupied path")
	}
	got, _ := os.ReadFile(path)
	if string(got) != "keep" {
		t.Fatal("replaced existing path")
	}
}

func TestCancellationWhileDialing(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	path := filepath.Join(t.TempDir(), "gpu0")
	dialing := make(chan struct{})
	b := Bridge{Path: path, UID: os.Getuid(), Dial: func(ctx context.Context) (net.Conn, error) {
		close(dialing)
		<-ctx.Done()
		return nil, ctx.Err()
	}}
	ready := make(chan error, 1)
	done := make(chan error, 1)
	go func() { done <- b.Serve(ctx, ready) }()
	if err := <-ready; err != nil {
		t.Fatal(err)
	}
	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	select {
	case <-dialing:
	case <-time.After(time.Second):
		t.Fatal("did not dial")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("pending dial blocked shutdown")
	}
}

func TestPeerIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "peer")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	peer, err := ln.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	if !peerUID(peer, os.Getuid()) || peerUID(peer, os.Getuid()+1) {
		t.Fatal("peer identity was not enforced")
	}
}

func TestActiveSessionOutlivesIdleTimeoutThenExpires(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	path := filepath.Join(t.TempDir(), "gpu")
	b := Bridge{Path: path, UID: os.Getuid(), IdleTimeout: 200 * time.Millisecond, Dial: func(context.Context) (net.Conn, error) {
		a, z := net.Pipe()
		go func() { defer z.Close(); io.Copy(z, z) }()
		return a, nil
	}}
	ready := make(chan error, 1)
	go b.Serve(ctx, ready)
	if e := <-ready; e != nil {
		t.Fatal(e)
	}
	c, e := net.Dial("unix", path)
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	for i := 0; i < 12; i++ {
		c.SetDeadline(time.Now().Add(time.Second))
		if _, e = c.Write([]byte{42}); e != nil {
			t.Fatal(e)
		}
		buf := make([]byte, 1)
		if _, e = io.ReadFull(c, buf); e != nil || buf[0] != 42 {
			t.Fatal(buf, e)
		}
		time.Sleep(40 * time.Millisecond)
	}
	c.SetReadDeadline(time.Now().Add(time.Second))
	buf := make([]byte, 1)
	if _, e = c.Read(buf); e == nil {
		t.Fatal("silent session not closed")
	}
}

// A resident reservation survives silence, but neither app disconnect nor
// broker shutdown may leak it. The configured short timeout would otherwise
// close the link before the second exchange.
func TestResidentSessionSurvivesSilenceAndReleases(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	path := filepath.Join(t.TempDir(), "gpu")
	closed := make(chan struct{}, 2)
	var calls atomic.Int32
	b := Bridge{Path: path, UID: os.Getuid(), Limit: 1,
		IdleTimeout: 40 * time.Millisecond, KeepIdleConnections: true,
		Dial: func(context.Context) (net.Conn, error) {
			calls.Add(1)
			a, z := net.Pipe()
			go func() { defer z.Close(); io.Copy(z, z); closed <- struct{}{} }()
			return a, nil
		}}
	ready := make(chan error, 1)
	done := make(chan error, 1)
	go func() { done <- b.Serve(ctx, ready) }()
	if err := <-ready; err != nil {
		t.Fatal(err)
	}
	connect := func() net.Conn {
		c, err := net.Dial("unix", path)
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	exchange := func(c net.Conn) {
		t.Helper()
		c.SetDeadline(time.Now().Add(time.Second))
		if _, err := c.Write([]byte{42}); err != nil {
			t.Fatal(err)
		}
		v := make([]byte, 1)
		if _, err := io.ReadFull(c, v); err != nil || v[0] != 42 {
			t.Fatal(v, err)
		}
	}
	waitClosed := func() {
		t.Helper()
		select {
		case <-closed:
		case <-time.After(time.Second):
			t.Fatal("reservation not released")
		}
	}
	c := connect()
	exchange(c)
	time.Sleep(160 * time.Millisecond)
	exchange(c)
	if calls.Load() != 1 {
		t.Fatal("resident connection was replaced")
	}
	// A resident connection must still consume a slot; a second one is refused.
	extra := connect()
	extra.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := extra.Read(make([]byte, 1)); err != io.EOF {
		t.Fatal("connection limit did not close the extra connection", err)
	}
	extra.Close()
	if calls.Load() != 1 {
		t.Fatal("limit allowed a second reservation")
	}
	c.Close()
	waitClosed()
	// The peer observes Close just before the broker releases its slot. Allow
	// that cleanup to finish without assuming a goroutine scheduling order.
	until := time.Now().Add(time.Second)
	for {
		c = connect()
		c.SetDeadline(until)
		_, err := c.Write([]byte{42})
		buf := make([]byte, 1)
		if err == nil {
			_, err = io.ReadFull(c, buf)
		}
		if err == nil && buf[0] == 42 {
			break
		}
		c.Close()
		if !time.Now().Before(until) {
			t.Fatal("released slot not reusable", err)
		}
		time.Sleep(time.Millisecond)
	}
	defer c.Close()
	if calls.Load() != 2 {
		t.Fatal("released slot not reused")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("resident shutdown hung")
	}
	waitClosed()
	c.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := c.Read(make([]byte, 1)); err == nil {
		t.Fatal("shutdown left app connection open")
	}
}

// Without the flag the socket keeps the historical metadata: mode 0600, owner
// UID, and whatever group a plain bind in the same directory receives.
func TestDefaultSocketMetadataUnchanged(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dir := t.TempDir()
	ref, err := net.ListenUnix("unix", &net.UnixAddr{Name: filepath.Join(dir, "ref"), Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer ref.Close()
	refSt, err := os.Stat(filepath.Join(dir, "ref"))
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "gpu")
	b := Bridge{Path: path, UID: os.Getuid(), Dial: func(context.Context) (net.Conn, error) { panic("must not dial") }}
	ready := make(chan error, 1)
	go b.Serve(ctx, ready)
	if err := <-ready; err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	sys := st.Sys().(*syscall.Stat_t)
	if st.Mode().Perm() != 0600 || int(sys.Uid) != os.Getuid() || sys.Gid != refSt.Sys().(*syscall.Stat_t).Gid {
		t.Fatal("default socket metadata changed", st.Mode(), sys.Uid, sys.Gid)
	}
}

// Invalid privileged configurations fail before any socket is created. This
// runs unprivileged; as root only the euid case is skipped.
func TestRootOwnedSocketValidation(t *testing.T) {
	dial := func(context.Context) (net.Conn, error) { panic("must not dial") }
	cases := map[string]int{"root peer": 0, "negative peer": -1}
	if os.Geteuid() != 0 {
		cases["unprivileged broker"] = os.Getuid()
	}
	for name, uid := range cases {
		path := filepath.Join(t.TempDir(), "gpu")
		b := Bridge{Path: path, UID: uid, Dial: dial, RootOwnedSocket: true}
		ready := make(chan error, 1)
		if b.Serve(context.Background(), ready) == nil || <-ready == nil {
			t.Fatal(name, "accepted")
		}
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatal(name, "created a filesystem entry", err)
		}
	}
}

// Privileged cases need euid 0 and are part of KVM qualification, not the
// ordinary unprivileged suite.
func requireRoot(t *testing.T) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("needs euid 0: run under KVM qualification")
	}
}

const (
	testAppUID   = 61000
	testOtherUID = 61001
)

func serveRootOwned(t *testing.T, ctx context.Context, path string, calls *atomic.Int32) {
	t.Helper()
	b := Bridge{Path: path, UID: testAppUID, RootOwnedSocket: true, Dial: func(context.Context) (net.Conn, error) {
		calls.Add(1)
		a, z := net.Pipe()
		go func() { defer z.Close(); io.Copy(z, z) }()
		return a, nil
	}}
	ready := make(chan error, 1)
	childCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- b.Serve(childCtx, ready) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(time.Second):
			t.Error("broker cleanup timed out")
		}
	})
	if err := <-ready; err != nil {
		t.Fatal(err)
	}
}

func TestRootOwnedSocketMetadata(t *testing.T) {
	requireRoot(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	path := filepath.Join(t.TempDir(), "gpu")
	var calls atomic.Int32
	serveRootOwned(t, ctx, path, &calls)
	st, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	sys := st.Sys().(*syscall.Stat_t)
	if st.Mode()&os.ModeSocket == 0 || st.Mode().Perm() != 0660 || sys.Uid != 0 || sys.Gid != testAppUID {
		t.Fatal("wrong root-owned metadata", st.Mode(), sys.Uid, sys.Gid)
	}
}

// Real child processes exercise kernel peer credentials with all real,
// effective and saved IDs dropped, without mutating Go runtime threads.
func runPeer(t *testing.T, path string, uid, gid int, want string) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestRootOwnedPeerHelper$")
	cmd.Env = []string{"SHIELDBRIDGE_PEER_HELPER=1", "SHIELDBRIDGE_PEER_PATH=" + path, "SHIELDBRIDGE_PEER_WANT=" + want}
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid), Groups: []uint32{}}}
	if out, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("peer uid=%d gid=%d: %v: %s", uid, gid, e, out)
	}
}

func TestRootOwnedPeerHelper(t *testing.T) {
	if os.Getenv("SHIELDBRIDGE_PEER_HELPER") != "1" {
		return
	}
	c, err := net.Dial("unix", os.Getenv("SHIELDBRIDGE_PEER_PATH"))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if !peerUID(c.(*net.UnixConn), 0) {
		t.Fatal("native client did not authenticate root broker")
	}
	c.SetDeadline(time.Now().Add(time.Second))
	want := os.Getenv("SHIELDBRIDGE_PEER_WANT")
	if want == "refused" {
		if _, err := c.Read(make([]byte, 1)); err != io.EOF {
			t.Fatal("unauthorized peer not refused", err)
		}
		return
	}
	if want != "accepted" {
		t.Fatal("invalid helper expectation")
	}
	if _, err = c.Write([]byte{42}); err != nil {
		t.Fatal(err)
	}
	v := make([]byte, 1)
	if _, err = io.ReadFull(c, v); err != nil || v[0] != 42 {
		t.Fatal(v, err)
	}
}

func TestRootOwnedSocketPeerAuthorization(t *testing.T) {
	requireRoot(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dir := t.TempDir()
	// Test-only stand-in for the caller's directory obligation: non-root peers
	// must be able to traverse to the socket.
	for _, d := range []string{filepath.Dir(dir), dir} {
		if err := os.Chmod(d, 0711); err != nil {
			t.Fatal(err)
		}
	}
	path := filepath.Join(dir, "gpu")
	var calls atomic.Int32
	serveRootOwned(t, ctx, path, &calls)
	// Root bypasses filesystem permissions, but has no peer-UID exception.
	runPeer(t, path, 0, 0, "refused")
	// A same-group peer reaches the socket but cannot reach the upstream.
	runPeer(t, path, testOtherUID, testAppUID, "refused")
	if calls.Load() != 0 {
		t.Fatal("unauthorized peer reached the worker")
	}
	runPeer(t, path, testAppUID, testAppUID, "accepted")
	if calls.Load() != 1 {
		t.Fatal("authorized peer not routed once")
	}
}
