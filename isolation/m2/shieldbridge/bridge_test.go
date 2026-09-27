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
