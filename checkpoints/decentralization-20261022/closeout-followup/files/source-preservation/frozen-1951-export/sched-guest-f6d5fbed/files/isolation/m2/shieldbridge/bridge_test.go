package shieldbridge

import (
	"context"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
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
