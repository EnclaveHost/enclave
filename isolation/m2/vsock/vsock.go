// Package vsock is the smallest AF_VSOCK stream binding the M2 front (in the domain) and forwarder
// (on the host) need, on the standard library alone: syscall has no sockaddr_vm, and net cannot adopt
// a vsock fd, so connections are pollable *os.File values behind net.Conn.
package vsock

import (
	"errors"
	"fmt"
	"net"
	"os"
	"syscall"
	"unsafe"
)

const (
	afVsock  = 40
	CIDAny   = 0xFFFFFFFF // listen on every CID this side has
	CIDLocal = 1          // vsock_loopback: host-to-host, for testing without a guest
)

type sockaddrVM struct {
	family    uint16
	reserved1 uint16
	port      uint32
	cid       uint32
	flags     uint8
	zero      [3]uint8
}

type Addr struct{ CID, Port uint32 }

func (a Addr) Network() string { return "vsock" }
func (a Addr) String() string  { return fmt.Sprintf("%d:%d", a.CID, a.Port) }

// Conn is a connected vsock stream: a non-blocking fd in an *os.File, which runs it through the
// runtime poller and supplies Close and the deadlines.
type Conn struct {
	*os.File
	local, remote Addr
}

func (c *Conn) LocalAddr() net.Addr  { return c.local }
func (c *Conn) RemoteAddr() net.Addr { return c.remote }

// Read and Write report errors the way package net does. *os.File returns *os.PathError, which is not
// a net.Error, so net/http and crypto/tls would take the deadline net/http sets to cancel its
// background read as a fatal error and drop every kept-alive connection after one response.
func (c *Conn) Read(b []byte) (int, error) {
	n, err := c.File.Read(b)
	return n, c.opErr("read", err)
}

func (c *Conn) Write(b []byte) (int, error) {
	n, err := c.File.Write(b)
	return n, c.opErr("write", err)
}

func (c *Conn) opErr(op string, err error) error {
	var pe *os.PathError
	if errors.As(err, &pe) {
		return &net.OpError{Op: op, Net: "vsock", Source: c.local, Addr: c.remote, Err: pe.Err}
	}
	return err
}

type Listener struct {
	f    *os.File
	addr Addr
}

func Listen(port uint32) (*Listener, error) {
	fd, err := syscall.Socket(afVsock, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("vsock socket: %w", err)
	}
	sa := sockaddrVM{family: afVsock, port: port, cid: CIDAny}
	if _, _, e := syscall.Syscall(syscall.SYS_BIND, uintptr(fd), uintptr(unsafe.Pointer(&sa)), unsafe.Sizeof(sa)); e != 0 {
		syscall.Close(fd)
		return nil, fmt.Errorf("vsock bind port %d: %w", port, e)
	}
	if err := syscall.Listen(fd, 128); err != nil {
		syscall.Close(fd)
		return nil, fmt.Errorf("vsock listen: %w", err)
	}
	if err := syscall.SetNonblock(fd, true); err != nil {
		syscall.Close(fd)
		return nil, err
	}
	return &Listener{f: os.NewFile(uintptr(fd), "vsock-listener"), addr: Addr{CIDAny, port}}, nil
}

func (l *Listener) Accept() (net.Conn, error) {
	rc, err := l.f.SyscallConn()
	if err != nil {
		return nil, err
	}
	var nfd int
	var aerr error
	var rsa sockaddrVM
	err = rc.Read(func(fd uintptr) bool {
		slen := uint32(unsafe.Sizeof(rsa))
		r, _, e := syscall.Syscall6(syscall.SYS_ACCEPT4, fd, uintptr(unsafe.Pointer(&rsa)),
			uintptr(unsafe.Pointer(&slen)), syscall.SOCK_CLOEXEC|syscall.SOCK_NONBLOCK, 0, 0)
		if e == syscall.EAGAIN {
			return false // wait for the poller
		}
		if e != 0 {
			aerr = e
		} else {
			nfd = int(r)
		}
		return true
	})
	if err != nil {
		return nil, err
	}
	if aerr != nil {
		return nil, aerr
	}
	return &Conn{File: os.NewFile(uintptr(nfd), "vsock"), local: l.addr, remote: Addr{rsa.cid, rsa.port}}, nil
}

func (l *Listener) Close() error   { return l.f.Close() }
func (l *Listener) Addr() net.Addr { return l.addr }

// Dial connects to (cid, port). The connect is non-blocking so a signal cannot interrupt it half way.
func Dial(cid, port uint32) (*Conn, error) {
	fd, err := syscall.Socket(afVsock, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC|syscall.SOCK_NONBLOCK, 0)
	if err != nil {
		return nil, fmt.Errorf("vsock socket: %w", err)
	}
	sa := sockaddrVM{family: afVsock, port: port, cid: cid}
	_, _, e := syscall.Syscall(syscall.SYS_CONNECT, uintptr(fd), uintptr(unsafe.Pointer(&sa)), unsafe.Sizeof(sa))
	f := os.NewFile(uintptr(fd), "vsock")
	if e != 0 && e != syscall.EINPROGRESS {
		f.Close()
		return nil, fmt.Errorf("vsock connect %d:%d: %w", cid, port, e)
	}
	if e == syscall.EINPROGRESS {
		rc, err := f.SyscallConn()
		if err != nil {
			f.Close()
			return nil, err
		}
		var serr error
		first := true
		werr := rc.Write(func(fd uintptr) bool {
			if first { // writability is only meaningful once the poller has reported it
				first = false
				return false
			}
			v, err := syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_ERROR)
			if err != nil {
				serr = err
			} else if v != 0 {
				serr = syscall.Errno(v)
			}
			return true
		})
		if werr == nil {
			werr = serr
		}
		if werr != nil {
			f.Close()
			return nil, fmt.Errorf("vsock connect %d:%d: %w", cid, port, werr)
		}
	}
	return &Conn{File: f, remote: Addr{cid, port}}, nil
}
