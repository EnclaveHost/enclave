// Package shieldbridge carries the existing masked worker protocol between a
// private guest-local socket and one fixed untrusted worker. It owns no app data,
// TLS key, masks, or inference state. WASI exposes no Unix socket API to apps.
package shieldbridge

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

type Bridge struct {
	Path        string
	UID         int
	Dial        func(context.Context) (net.Conn, error)
	Limit       int
	IdleTimeout time.Duration
	// KeepIdleConnections ties a private GPU reservation to the app connection's
	// lifetime, rather than evicting it merely because inference is idle.
	// Peer checks, connection limits, disconnect cleanup and cancellation still apply.
	KeepIdleConnections bool
}

func (b Bridge) Serve(ctx context.Context, ready chan<- error) error {
	if !filepath.IsAbs(b.Path) || b.UID < 0 || b.Dial == nil {
		err := errors.New("invalid shield broker configuration")
		ready <- err
		return err
	}
	// Never unlink an existing endpoint; two brokers must not steal a route.
	if _, err := os.Lstat(b.Path); !os.IsNotExist(err) {
		err = errors.New("shield broker path already exists or cannot be inspected")
		ready <- err
		return err
	}
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: b.Path, Net: "unix"})
	if err != nil {
		ready <- err
		return err
	}
	defer ln.Close()
	if err = os.Chmod(b.Path, 0600); err == nil {
		err = os.Chown(b.Path, b.UID, -1)
	}
	if err != nil {
		ready <- err
		return err
	}
	limit := b.Limit
	if limit <= 0 {
		limit = 32
	}
	idle := b.IdleTimeout
	if idle <= 0 {
		idle = 10 * time.Minute
	}
	slots := make(chan struct{}, limit)
	var wg sync.WaitGroup
	ctx, cancel := context.WithCancel(ctx)
	defer func() { cancel(); wg.Wait() }()
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			ln.Close()
		case <-done:
		}
	}()
	ready <- nil
	for {
		c, err := ln.AcceptUnix()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if !peerUID(c, b.UID) {
			c.Close()
			continue
		}
		select {
		case slots <- struct{}{}:
		default:
			c.Close()
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-slots }()
			defer c.Close()
			up, err := b.Dial(ctx)
			if err != nil {
				return
			}
			defer up.Close()
			end := make(chan struct{}, 2)
			// Timed routes bound silence, not a session's age. Both directions
			// share the deadline. Resident routes wait for disconnect/cancellation.
			touch := func() {
				if !b.KeepIdleConnections {
					until := time.Now().Add(idle)
					c.SetDeadline(until)
					up.SetDeadline(until)
				}
			}
			touch()
			down := &activityConn{Conn: c, touch: touch}
			worker := &activityConn{Conn: up, touch: touch}
			go func() { io.Copy(worker, down); end <- struct{}{} }()
			go func() { io.Copy(down, worker); end <- struct{}{} }()
			select {
			case <-ctx.Done():
			case <-end:
			}
		}()
	}
}

func peerUID(c *net.UnixConn, uid int) bool {
	raw, err := c.SyscallConn()
	if err != nil {
		return false
	}
	var cred *syscall.Ucred
	var inner error
	err = raw.Control(func(fd uintptr) {
		cred, inner = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	})
	return err == nil && inner == nil && cred != nil && int(cred.Uid) == uid
}

// Wrapping Conn also avoids io.Copy's raw-socket fast path skipping activity.
type activityConn struct {
	net.Conn
	touch func()
}

func (c *activityConn) Read(p []byte) (int, error) {
	n, e := c.Conn.Read(p)
	if n > 0 {
		c.touch()
	}
	return n, e
}
func (c *activityConn) Write(p []byte) (int, error) {
	n, e := c.Conn.Write(p)
	if n > 0 {
		c.touch()
	}
	return n, e
}
