//go:build linux && amd64

package rpcstorage

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"strings"
	"syscall"
	"time"

	"enclave.host/isolation/m3/rpcservice"
)

// AcceptBroker creates its own fixed per-boot listener. SO_PEERPIDFD will name
// THIS process, not a bootstrap parent that handed it an accepted connection.
// The caller must already have an independently bounded process and accepted
// policy/credential inputs. Listening is not authorization or a storage grant.
// ready is a one-shot inherited write pipe to the bootstrap, never a network
// endpoint. The protected namespace and consumed marker are never removed.
func AcceptBroker(clock, ready *os.File) (session *BrokerSession, receipts *os.File, err error) {
	if ready == nil {
		return nil, nil, errors.New("bootstrap readiness pipe required")
	}
	defer ready.Close()
	var st syscall.Stat_t
	readyFD := int(ready.Fd())
	flags, _, eno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(readyFD), syscall.F_GETFL, 0)
	if eno != 0 || flags&syscall.O_ACCMODE != syscall.O_WRONLY || syscall.Fstat(readyFD, &st) != nil || st.Uid != 0 || st.Mode&syscall.S_IFMT != syscall.S_IFIFO {
		return nil, nil, errors.New("held root write-only readiness pipe required")
	}
	if err = syscall.SetNonblock(readyFD, true); err != nil {
		return nil, nil, err
	}
	origin, err := rpcservice.OriginalEntryOrigin(clock)
	if err != nil {
		return nil, nil, err
	}
	before := time.Now()
	now, err := rpcservice.MonotonicNow()
	if err != nil || now < origin || now >= origin+uint64(rpcservice.StartupWindow) {
		return nil, nil, errors.New("original bootstrap window expired")
	}
	deadline := before.Add(time.Duration(origin + uint64(rpcservice.StartupWindow) - now))
	for _, path := range []string{"/", "/run"} {
		if syscall.Lstat(path, &st) != nil || st.Uid != 0 || st.Mode&syscall.S_IFMT != syscall.S_IFDIR || st.Mode&0022 != 0 {
			return nil, nil, errors.New("protected bootstrap ancestors required")
		}
	}
	// Exclusive even if a prior process died before binding. Never adopt/reuse an
	// existing directory, attempt marker, listener or owner receipt namespace.
	if err = os.Mkdir("/run/native-rpc-storage", 0700); err != nil {
		return nil, nil, err
	}
	receipts, err = os.Open("/run/native-rpc-storage")
	if err != nil {
		return nil, nil, err
	}
	defer func() {
		if err != nil {
			receipts.Close()
			receipts = nil
		}
	}()
	if err = bootJournal(receipts); err != nil {
		return nil, receipts, err
	}
	var held syscall.Stat_t
	if err = syscall.Fstat(int(receipts.Fd()), &held); err != nil {
		return nil, receipts, err
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return nil, receipts, err
	}
	row := map[string]any{"schema": "enclave-rpc-broker-listening/1", "boot": strings.TrimSpace(string(boot)), "pid": os.Getpid(), "originMonotonicNs": origin, "deadlineMonotonicNs": origin + uint64(rpcservice.StartupWindow), "rootsGranted": false, "rpcReady": false}
	raw, err := json.Marshal(row)
	if err != nil {
		return nil, receipts, err
	}
	marker, err := consumeRecord(receipts, "broker-started", raw)
	if err != nil {
		return nil, receipts, err
	}
	marker.Close()
	listener, err := net.ListenUnix("unixpacket", &net.UnixAddr{Name: socketPath, Net: "unixpacket"})
	if err != nil {
		return nil, receipts, err
	}
	listener.SetUnlinkOnClose(false) // Leave the consumed socket name on every exit.
	defer listener.Close()
	if err = os.Chmod(socketPath, 0600); err != nil {
		return nil, receipts, err
	}
	if err = protectedSocket(); err != nil {
		return nil, receipts, err
	}
	if syscall.Lstat("/run/native-rpc-storage", &st) != nil || st.Dev != held.Dev || st.Ino != held.Ino {
		return nil, receipts, errors.New("broker namespace replaced")
	}
	if err = receipts.Sync(); err != nil {
		return nil, receipts, err
	}
	if !time.Now().Before(deadline) {
		return nil, receipts, errors.New("late bootstrap listener")
	}
	if err = listener.SetDeadline(deadline); err != nil {
		return nil, receipts, err
	}
	raw = append(raw, '\n')
	// Small single nonblocking pipe write. A missing/stalled bootstrap never
	// turns listener publication into an unbounded native write.
	n, err := syscall.Write(readyFD, raw)
	if err != nil || n != len(raw) {
		return nil, receipts, errors.New("bootstrap readiness unacknowledged; namespace consumed")
	}
	ready.Close()
	conn, err := listener.AcceptUnix()
	if err != nil {
		return nil, receipts, err
	}
	// No accept loop: even a malformed peer consumes the only ingress.
	session, err = ReceiveBrokerSession(conn, clock)
	return session, receipts, err
}
