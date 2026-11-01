//go:build linux && amd64

package rpcstorage

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// NBD fixed-newstyle constants (NetworkBlockDevice doc/proto.md).
const (
	nbdMagic         = 0x4e42444d41474943 // "NBDMAGIC"
	nbdOptMagic      = 0x49484156454f5054 // "IHAVEOPT"
	nbdReplyMagic    = 0x0003e889045565a9
	nbdFixedNewstyle = 1 << 0
	nbdNoZeroes      = 1 << 1
	nbdOptStartTLS   = 5
	nbdOptGo         = 7
	nbdRepAck        = 1
	nbdRepInfo       = 3
	nbdRepErrorBit   = 1 << 31
	nbdInfoExport    = 0
	nbdFlagHasFlags  = 1 << 0
	nbdFlagReadOnly  = 1 << 1
	nbdFlagFlush     = 1 << 2
	nbdFlagFUA       = 1 << 3
	nbdReplyLimit    = 64 << 10
	nbdBlockSize     = 4096
)

// Linux <linux/nbd.h> ioctls: _IO(0xab, nr).
const (
	nbdSetSock       = 0xab00
	nbdSetBlkSize    = 0xab01
	nbdDoIt          = 0xab03
	nbdClearSock     = 0xab04
	nbdClearQue      = 0xab05
	nbdSetSizeBlocks = 0xab07
	nbdSetTimeout    = 0xab09
	nbdSetFlags      = 0xab0a
	nbdMajor         = 43
)

// DataEndpoint is one owner-authenticated writable NBD export. This package
// never chooses it: the caller must obtain every field from the storage owner's
// authenticated channel. Address is a literal IP; there is no DNS authority.
type DataEndpoint struct {
	Role           string
	Address        netip.AddrPort
	ServerName     string
	ExportName     string
	Bytes          uint64
	FilesystemUUID [16]byte
	ServerCA       *x509.Certificate
}

func (ep DataEndpoint) validate() error {
	if ep.Role != "l1" && ep.Role != "base" {
		return errors.New("exact storage role required")
	}
	a := ep.Address.Addr()
	if !ep.Address.IsValid() || ep.Address.Port() < 1024 || a.IsUnspecified() || a.IsMulticast() || a.IsLinkLocalUnicast() || a.Zone() != "" {
		return errors.New("explicit unicast export endpoint required")
	}
	if ep.ServerName == "" || len(ep.ServerName) > 253 || ep.ExportName == "" || len(ep.ExportName) > 4096 || strings.ContainsRune(ep.ExportName, 0) {
		return errors.New("explicit export and certificate names required")
	}
	if ep.Bytes == 0 || ep.Bytes%nbdBlockSize != 0 || ep.FilesystemUUID == ([16]byte{}) || ep.ServerCA == nil {
		return errors.New("exact export size, filesystem identity and server authority required")
	}
	return nil
}

// negotiatedExport is the TLS transport after a successful NBD_OPT_GO. Only
// transmission-phase bytes may follow; no further options are possible.
type negotiatedExport struct {
	conn  *tls.Conn
	flags uint16
}

// negotiateExport performs one fixed-newstyle handshake with mandatory
// STARTTLS before any export is named. It accepts only the exact size and a
// writable export advertising FLUSH and FUA. It never retries or downgrades.
func negotiateExport(raw net.Conn, ep DataEndpoint, client tls.Certificate, deadline time.Time) (*negotiatedExport, error) {
	if err := ep.validate(); err != nil {
		return nil, err
	}
	if err := raw.SetDeadline(deadline); err != nil {
		return nil, err
	}
	var hello [18]byte
	if _, err := io.ReadFull(raw, hello[:]); err != nil {
		return nil, err
	}
	if binary.BigEndian.Uint64(hello[0:]) != nbdMagic || binary.BigEndian.Uint64(hello[8:]) != nbdOptMagic {
		return nil, errors.New("fixed-newstyle NBD server required")
	}
	serverFlags := binary.BigEndian.Uint16(hello[16:])
	if serverFlags&nbdFixedNewstyle == 0 || serverFlags&nbdNoZeroes == 0 {
		return nil, errors.New("fixed-newstyle no-zeroes NBD server required")
	}
	if err := writeAll(raw, binary.BigEndian.AppendUint32(nil, nbdFixedNewstyle|nbdNoZeroes)); err != nil {
		return nil, err
	}
	if err := sendOption(raw, nbdOptStartTLS, nil); err != nil {
		return nil, err
	}
	typ, data, err := readOptionReply(raw, nbdOptStartTLS)
	if err != nil {
		return nil, err
	}
	if typ != nbdRepAck || len(data) != 0 {
		return nil, errors.New("NBD server refused mandatory TLS")
	}
	roots := x509.NewCertPool()
	roots.AddCert(ep.ServerCA)
	conn := tls.Client(raw, &tls.Config{
		MinVersion:   tls.VersionTLS13,
		ServerName:   ep.ServerName,
		RootCAs:      roots,
		Certificates: []tls.Certificate{client},
	})
	fail := func(e error) (*negotiatedExport, error) {
		raw.Close()
		return nil, e
	}
	if err = conn.Handshake(); err != nil {
		return fail(err)
	}
	opt := binary.BigEndian.AppendUint32(nil, uint32(len(ep.ExportName)))
	opt = append(opt, ep.ExportName...)
	opt = binary.BigEndian.AppendUint16(opt, 0) // no extra info requests
	if err = sendOption(conn, nbdOptGo, opt); err != nil {
		return fail(err)
	}
	var size uint64
	var flags uint16
	seen := false
	for i := 0; ; i++ {
		if i > 32 {
			return fail(errors.New("unbounded NBD info replies"))
		}
		typ, data, err = readOptionReply(conn, nbdOptGo)
		if err != nil {
			return fail(err)
		}
		if typ == nbdRepAck {
			if len(data) != 0 {
				return fail(errors.New("malformed NBD acknowledgement"))
			}
			break
		}
		if typ != nbdRepInfo || len(data) < 2 {
			return fail(fmt.Errorf("NBD export refused: reply %#x", typ))
		}
		if binary.BigEndian.Uint16(data) == nbdInfoExport {
			if seen || len(data) != 12 {
				return fail(errors.New("malformed or repeated NBD export info"))
			}
			size, flags, seen = binary.BigEndian.Uint64(data[2:]), binary.BigEndian.Uint16(data[10:]), true
		}
	}
	if !seen || size != ep.Bytes {
		return fail(errors.New("exact NBD export size required"))
	}
	if flags&nbdFlagHasFlags == 0 || flags&nbdFlagReadOnly != 0 || flags&nbdFlagFlush == 0 || flags&nbdFlagFUA == 0 {
		return fail(errors.New("writable NBD export with FLUSH and FUA required"))
	}
	if err = raw.SetDeadline(time.Time{}); err != nil {
		return fail(err)
	}
	return &negotiatedExport{conn: conn, flags: flags}, nil
}

func writeAll(w io.Writer, b []byte) error {
	n, err := w.Write(b)
	if err == nil && n != len(b) {
		err = io.ErrShortWrite
	}
	return err
}

func sendOption(w io.Writer, option uint32, data []byte) error {
	b := binary.BigEndian.AppendUint64(nil, nbdOptMagic)
	b = binary.BigEndian.AppendUint32(b, option)
	b = binary.BigEndian.AppendUint32(b, uint32(len(data)))
	return writeAll(w, append(b, data...))
}

func readOptionReply(r io.Reader, option uint32) (uint32, []byte, error) {
	var head [20]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return 0, nil, err
	}
	if binary.BigEndian.Uint64(head[0:]) != nbdReplyMagic || binary.BigEndian.Uint32(head[8:]) != option {
		return 0, nil, errors.New("malformed NBD option reply")
	}
	typ, length := binary.BigEndian.Uint32(head[12:]), binary.BigEndian.Uint32(head[16:])
	if length > nbdReplyLimit {
		return 0, nil, errors.New("oversized NBD option reply")
	}
	data := make([]byte, length)
	if _, err := io.ReadFull(r, data); err != nil {
		return 0, nil, err
	}
	if typ&nbdRepErrorBit != 0 {
		return typ, nil, fmt.Errorf("NBD option %d refused: %#x", option, typ)
	}
	return typ, data, nil
}

// checkExt4Identity reads the primary ext4 superblock through the attached
// device. It binds the owner-selected filesystem UUID and that the filesystem
// fits inside the negotiated export; it is not a consistency check.
func checkExt4Identity(dev *os.File, ep DataEndpoint) error {
	sb := make([]byte, 1024)
	if n, err := dev.ReadAt(sb, 1024); err != nil || n != len(sb) {
		return errors.New("ext4 superblock unreadable")
	}
	if binary.LittleEndian.Uint16(sb[0x38:]) != 0xef53 {
		return errors.New("attached export is not ext4")
	}
	if !bytes.Equal(sb[0x68:0x78], ep.FilesystemUUID[:]) {
		return errors.New("attached filesystem UUID differs")
	}
	logBlock := binary.LittleEndian.Uint32(sb[0x18:])
	if logBlock > 6 {
		return errors.New("unsupported ext4 block size")
	}
	blocks := uint64(binary.LittleEndian.Uint32(sb[0x04:]))
	if binary.LittleEndian.Uint32(sb[0x60:])&0x80 != 0 { // INCOMPAT_64BIT
		blocks |= uint64(binary.LittleEndian.Uint32(sb[0x150:])) << 32
	}
	if blocks == 0 || blocks > ep.Bytes/(1024<<logBlock) {
		return errors.New("ext4 filesystem exceeds negotiated export")
	}
	return nil
}

// Attachment holds one kernel NBD device whose only transport is this
// process's TLS proxy. Loss closes when either proxy direction or the kernel
// DO_IT thread ends. Closing it cuts the transport: no further guest writes
// can reach the exporter. That is a local fence, not proof of clean settlement.
type Attachment struct {
	Role  string
	Root  *os.File
	dev   *os.File
	conn  *tls.Conn
	local net.Conn
	loss  chan struct{}
	once  sync.Once
}

func (a *Attachment) Loss() <-chan struct{} { return a.loss }

func (a *Attachment) Close() {
	a.once.Do(func() {
		a.conn.NetConn().Close()
		a.local.Close()
	})
}

func ioctl(f *os.File, req, arg uintptr) error {
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), req, arg); e != 0 {
		return e
	}
	return nil
}

// AttachExport dials, negotiates, hands the transmission phase to /dev/nbdN
// through a private socketpair, binds ext4 identity, and returns the writable
// root of a detached mount. The mount is reachable only through Root; no path
// is created in any namespace. Errors after kernel attachment retain nothing
// writable: the transport is cut and the device is left for the guest to drop.
func AttachExport(ctx context.Context, ep DataEndpoint, client tls.Certificate, device int, deadline time.Time) (a *Attachment, err error) {
	if err = ep.validate(); err != nil {
		return nil, err
	}
	if device < 0 || device > 15 {
		return nil, errors.New("fixed NBD device required")
	}
	dev, err := openIdleNBD(device)
	if err != nil {
		return nil, err
	}
	owned := false // after DO_IT starts, only its goroutine may close dev
	defer func() {
		if !owned {
			dev.Close()
		}
	}()
	dctx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	raw, err := (&net.Dialer{}).DialContext(dctx, "tcp", ep.Address.String())
	if err != nil {
		return nil, err
	}
	stop := context.AfterFunc(dctx, func() { raw.Close() })
	n, err := negotiateExport(raw, ep, client, deadline)
	if !stop() || err != nil {
		raw.Close()
		if err == nil {
			err = errors.New("original attachment deadline expired")
		}
		return nil, err
	}
	pair, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		raw.Close()
		return nil, err
	}
	kernel := os.NewFile(uintptr(pair[0]), "nbd-kernel-end")
	// The proxy end must be pollable so Close interrupts a blocked copy.
	var local net.Conn
	if err = syscall.SetNonblock(pair[1], true); err == nil {
		f := os.NewFile(uintptr(pair[1]), "nbd-proxy-end")
		local, err = net.FileConn(f)
		f.Close()
	} else {
		syscall.Close(pair[1])
	}
	if err != nil {
		kernel.Close()
		raw.Close()
		return nil, err
	}
	a = &Attachment{Role: ep.Role, dev: dev, conn: n.conn, local: local, loss: make(chan struct{})}
	for _, step := range [][2]uintptr{
		{nbdClearSock, 0},
		{nbdSetBlkSize, nbdBlockSize},
		{nbdSetSizeBlocks, uintptr(ep.Bytes / nbdBlockSize)},
		{nbdSetFlags, uintptr(n.flags)},
		{nbdSetTimeout, 10},
		{nbdSetSock, kernel.Fd()},
	} {
		if err = ioctl(dev, step[0], step[1]); err != nil {
			kernel.Close()
			a.Close()
			a = nil
			return nil, fmt.Errorf("NBD ioctl %#x: %w", step[0], err)
		}
	}
	owned = true
	a.start(kernel)
	fail := func(e error) (*Attachment, error) {
		a.Close()
		return nil, e
	}
	if err = checkExt4Identity(dev, ep); err != nil {
		return fail(err)
	}
	if !time.Now().Before(deadline) {
		return fail(errors.New("original attachment deadline expired"))
	}
	if a.Root, err = mountDetachedExt4(device); err != nil {
		return fail(err)
	}
	var st syscall.Stat_t
	var fs syscall.Statfs_t
	if syscall.Fstat(int(a.Root.Fd()), &st) != nil || st.Ino != 2 || st.Uid != 0 || st.Mode&0022 != 0 || syscall.Fstatfs(int(a.Root.Fd()), &fs) != nil || fs.Type != 0xef53 || fs.Flags&1 != 0 {
		a.Root.Close()
		return fail(errors.New("held writable ext4 filesystem root required"))
	}
	return a, nil
}

// start runs DO_IT on a locked thread and proxies both directions. Any end
// closes the transport and signals loss exactly once.
func (a *Attachment) start(kernel *os.File) {
	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		runtime.LockOSThread()
		_ = ioctl(a.dev, nbdDoIt, 0)
		_ = ioctl(a.dev, nbdClearQue, 0)
		_ = ioctl(a.dev, nbdClearSock, 0)
		kernel.Close()
		a.Close()
		a.dev.Close()
	}()
	go func() { defer wg.Done(); io.Copy(a.conn, a.local); a.Close() }()
	go func() { defer wg.Done(); io.Copy(a.local, a.conn); a.Close() }()
	go func() { wg.Wait(); close(a.loss) }()
}

func openIdleNBD(device int) (*os.File, error) {
	name := fmt.Sprintf("nbd%d", device)
	size, err := os.ReadFile("/sys/class/block/" + name + "/size")
	if err != nil || string(size) != "0\n" {
		return nil, errors.New("idle preloaded NBD device required")
	}
	if _, err = os.Stat("/sys/class/block/" + name + "/pid"); !errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("NBD device already owned")
	}
	dev, err := os.OpenFile("/dev/"+name, os.O_RDWR|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	var st syscall.Stat_t
	if syscall.Fstat(int(dev.Fd()), &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFBLK || st.Uid != 0 || st.Rdev != uint64(nbdMajor<<8|device) {
		dev.Close()
		return nil, errors.New("exact NBD block device required")
	}
	return dev, nil
}

// x86_64 new mount API; a detached mount has no path in any mount namespace.
const (
	sysFsopen         = 430
	sysFsconfig       = 431
	sysFsmount        = 432
	fsconfigSetString = 1
	fsconfigCreate    = 6
	mountAttrNosuid   = 0x2
	mountAttrNodev    = 0x4
	mountAttrNoexec   = 0x8
)

func mountDetachedExt4(device int) (*os.File, error) {
	fstype := []byte("ext4\x00")
	fsfd, _, e := syscall.Syscall(sysFsopen, uintptr(unsafe.Pointer(&fstype[0])), 1, 0)
	if e != 0 {
		return nil, fmt.Errorf("fsopen: %w", e)
	}
	defer syscall.Close(int(fsfd))
	for _, kv := range [][2]string{{"source", fmt.Sprintf("/dev/nbd%d", device)}, {"errors", "remount-ro"}} {
		k, v := []byte(kv[0]+"\x00"), []byte(kv[1]+"\x00")
		if _, _, e = syscall.Syscall6(sysFsconfig, fsfd, fsconfigSetString, uintptr(unsafe.Pointer(&k[0])), uintptr(unsafe.Pointer(&v[0])), 0, 0); e != 0 {
			return nil, fmt.Errorf("fsconfig %s: %w", kv[0], e)
		}
	}
	if _, _, e = syscall.Syscall6(sysFsconfig, fsfd, fsconfigCreate, 0, 0, 0, 0); e != 0 {
		return nil, fmt.Errorf("ext4 mount refused: %w", e)
	}
	mfd, _, e := syscall.Syscall(sysFsmount, fsfd, 1, mountAttrNosuid|mountAttrNodev|mountAttrNoexec)
	if e != 0 {
		return nil, fmt.Errorf("fsmount: %w", e)
	}
	defer syscall.Close(int(mfd))
	dot := []byte(".\x00")
	fd, _, e := syscall.Syscall6(syscall.SYS_OPENAT, mfd, uintptr(unsafe.Pointer(&dot[0])), syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0, 0, 0)
	if e != 0 {
		return nil, fmt.Errorf("open detached root: %w", e)
	}
	return os.NewFile(fd, "rpc-state-root"), nil
}
