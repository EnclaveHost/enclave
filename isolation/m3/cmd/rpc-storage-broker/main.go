//go:build linux && amd64

// rpc-storage-broker binds one monitor attempt to its storage-owner proof and
// authenticated export control. It does not grant writable roots. The accepted
// bootstrap must own the sockets, original deadline and independent guardian.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/bootstrap"
	"enclave.host/isolation/m3/rpcservice"
	"enclave.host/isolation/m3/rpcstorage"
)

type policy struct {
	Schema        string   `json:"schema"`
	Runtime       string   `json:"runtime"`
	BundleSHA256  string   `json:"bundleSha256"`
	Manifest      []byte   `json:"manifest"`
	ChainID       uint64   `json:"chainId"`
	Ledger        string   `json:"ledger"`
	RPCs          []string `json:"rpcs"`
	Confirmations uint64   `json:"confirmations"`
	MaxAgeSeconds uint64   `json:"maxAgeSeconds"`
}

func exactJSON(raw []byte, value any) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(value); err != nil {
		return err
	}
	typed, err := json.Marshal(value)
	if err != nil {
		return err
	}
	var normalized any
	d = json.NewDecoder(bytes.NewReader(typed))
	d.UseNumber()
	if err = d.Decode(&normalized); err != nil {
		return err
	}
	typed, err = json.Marshal(normalized)
	if err != nil || !bytes.Equal(bytes.TrimSpace(raw), typed) {
		return errors.New("complete canonical JSON required")
	}
	return nil
}

func privateInput(fd int, maximum int64) ([]byte, error) {
	var before, after syscall.Stat_t
	flags, _, e := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), syscall.F_GETFL, 0)
	if e != 0 || flags&syscall.O_ACCMODE != syscall.O_RDONLY || syscall.Fstat(fd, &before) != nil || before.Uid != 0 || before.Mode&syscall.S_IFMT != syscall.S_IFREG || before.Mode&07777 != 0600 || before.Nlink != 1 || before.Size <= 0 || before.Size > maximum {
		return nil, errors.New("held private root read-only input required")
	}
	raw := make([]byte, before.Size+1)
	n, err := syscall.Pread(fd, raw, 0)
	if err != nil {
		return nil, err
	}
	if int64(n) != before.Size || syscall.Fstat(fd, &after) != nil || before.Dev != after.Dev || before.Ino != after.Ino || before.Size != after.Size || before.Mode != after.Mode || before.Uid != after.Uid || before.Nlink != after.Nlink || before.Mtim != after.Mtim || before.Ctim != after.Ctim {
		return nil, errors.New("bootstrap input changed")
	}
	return raw[:n], nil
}

func envelope() error {
	if os.Geteuid() != 0 {
		return errors.New("guest bootstrap identity required")
	}
	group, e := os.ReadFile("/proc/self/cgroup")
	if e != nil {
		return e
	}
	line := strings.TrimSpace(string(group))
	if !strings.HasPrefix(line, "0::/") || strings.Contains(line, "\n") || line == "0::/" {
		return errors.New("dedicated broker cgroup required")
	}
	root := "/sys/fs/cgroup" + strings.TrimPrefix(line, "0::")
	for name, cap := range map[string]uint64{"memory.max": 128 << 20, "memory.swap.max": 0, "pids.max": 32} {
		b, e := os.ReadFile(root + "/" + name)
		if e != nil {
			return e
		}
		v, e := strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64)
		if e != nil || v > cap {
			return errors.New("broker kernel envelope mismatch")
		}
	}
	b, e := os.ReadFile(root + "/cpu.max")
	if e != nil {
		return e
	}
	f := strings.Fields(string(b))
	if len(f) != 2 {
		return errors.New("CPU envelope")
	}
	q, e := strconv.ParseUint(f[0], 10, 64)
	if e != nil {
		return e
	}
	period, e := strconv.ParseUint(f[1], 10, 64)
	if e != nil || period == 0 || q == 0 || q > period {
		return errors.New("CPU1 broker required")
	}
	return nil
}

func unixFD(fd int, network string) (*net.UnixConn, error) {
	f := os.NewFile(uintptr(fd), "accepted-bootstrap-socket")
	c, e := net.FileConn(f)
	if e != nil {
		return nil, e
	}
	f.Close()
	u, ok := c.(*net.UnixConn)
	if !ok || c.LocalAddr().Network() != network {
		c.Close()
		return nil, errors.New("exact bootstrap Unix socket type required")
	}
	return u, nil
}

func run() error {
	if len(os.Args) != 1 {
		return errors.New("no arguments or override selectors accepted")
	}
	clock := os.NewFile(3, "original-guest-clock")
	origin, e := rpcservice.OriginalEntryOrigin(clock)
	if e != nil {
		return e
	}
	before := time.Now()
	now, e := rpcservice.MonotonicNow()
	if e != nil || now < origin || now >= origin+uint64(rpcservice.StartupWindow) {
		return errors.New("original broker deadline expired")
	}
	deadline := before.Add(time.Duration(origin + uint64(rpcservice.StartupWindow) - now))
	// Supplementary only. Accepted bootstrap's independently enforced cutoff must
	// already cover process setup, every FD read, auth, relay and blocked calls.
	timer := time.AfterFunc(time.Until(deadline), func() { os.Exit(124) })
	defer timer.Stop()
	if e = envelope(); e != nil {
		return e
	}
	monitor, e := unixFD(4, "unixpacket")
	if e != nil {
		return e
	}
	session, e := rpcstorage.ReceiveBrokerSession(monitor, clock)
	if e != nil {
		return e
	}
	defer session.Stop()
	if e = session.Acknowledge(); e != nil {
		return e
	}
	raw, e := privateInput(5, 2<<20)
	if e != nil {
		return e
	}
	var p policy
	if e = exactJSON(raw, &p); e != nil {
		return e
	}
	if p.Schema != "enclave-rpc-broker-policy/1" || !contract.NonzeroHash(p.Runtime) || !contract.NonzeroHash(p.BundleSHA256) || len(p.Manifest) == 0 || len(p.Manifest) > 65536 || p.MaxAgeSeconds == 0 || p.MaxAgeSeconds > 120 {
		return errors.New("explicit accepted broker policy required")
	}
	bundle, e := privateInput(6, 2<<20)
	if e != nil {
		return e
	}
	sum := sha256.Sum256(bundle)
	if hex.EncodeToString(sum[:]) != p.BundleSHA256 {
		return errors.New("accepted bundle pin differs")
	}
	req := session.Request()
	if req.AppID != hex.EncodeToString(sum[:]) {
		return errors.New("monitor app differs from accepted bundle")
	}
	reader, e := bootstrap.NewReader(bootstrap.Config{ChainID: p.ChainID, Ledger: p.Ledger, RPCs: p.RPCs, Confirmations: p.Confirmations, MaxAge: time.Duration(p.MaxAgeSeconds) * time.Second})
	if e != nil {
		return e
	}
	var loaded bootstrap.Identity
	loaded.AppID = contract.AppID(bundle)
	runtime, _ := hex.DecodeString(p.Runtime)
	copy(loaded.RuntimeID[:], runtime)
	var deployment [32]byte
	id, _ := hex.DecodeString(req.Deployment[2:])
	copy(deployment[:], id)
	ctx, cancel := context.WithDeadline(session.Context(), deadline)
	defer cancel()
	auth, e := reader.Authorize(ctx, deployment, p.Manifest, loaded)
	if e != nil {
		return e
	}
	// Validate the actual owner-committed volume identities before even asking
	// the relay. The relay cannot construct Authorization or change this policy.
	if _, e = auth.RPCStorageAuthorities(bundle, req); e != nil {
		return e
	}
	relay, e := unixFD(7, "unix")
	if e != nil {
		return e
	}
	receipts := os.NewFile(11, "guest-one-shot-receipts")
	response, e := session.ExchangeOwner(relay, bundle, p.Manifest, receipts)
	if e != nil {
		return e
	}
	var reply struct {
		Schema                string          `json:"schema"`
		Attempt               string          `json:"attempt"`
		Proof                 json.RawMessage `json:"proof"`
		Exporter              json.RawMessage `json:"exporter"`
		RPCReady              bool            `json:"rpcReady"`
		WritersFenced         bool            `json:"writersFenced"`
		ReservationMayRelease bool            `json:"reservationMayRelease"`
	}
	if e = exactJSON(response, &reply); e != nil {
		return e
	}
	if reply.Schema != "enclave-rpc-owner-dispatched/1" || reply.RPCReady || reply.WritersFenced || reply.ReservationMayRelease {
		return errors.New("unqualified owner response cannot grant serving or release")
	}
	// Exporter/attempt metadata is retained as untrusted transport evidence. Only
	// the independently checked proof authorizes the subsequent control dial.
	if e = session.AuthenticateRemoteReservation(auth, bundle, reply.Proof, receipts); e != nil {
		return e
	}
	server, e := privateInput(8, 16384)
	if e != nil {
		return e
	}
	cert, e := privateInput(9, 65536)
	if e != nil {
		return e
	}
	key, e := privateInput(10, 16384)
	if e != nil {
		return e
	}
	client, e := tls.X509KeyPair(cert, key)
	clear(key)
	if e != nil {
		return e
	}
	control, e := session.ConnectExportControl(server, client)
	if e != nil {
		return e
	}
	result := map[string]any{"schema": "enclave-rpc-broker-control-bound/1", "requestSha256": control.RequestSHA256(), "contractSha256": control.ContractSHA256(), "rpcReady": false, "rootsGranted": false, "writersFenced": false, "reservationMayRelease": false}
	raw, e = json.Marshal(result)
	if e != nil {
		return e
	}
	raw = append(raw, '\n')
	n, e := os.Stdout.Write(raw)
	if e != nil || n != len(raw) {
		return errors.New("broker receipt write failed")
	}
	// Acceptance keeps the original acquisition window, but is no root grant.
	// Qualified attachment/guardian integration is still required before serving.
	<-control.Context().Done()
	return errors.New("broker control lifetime ended; owner reservations retained")
}
func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, "RPC storage broker refused:", e)
		os.Exit(1)
	}
}
