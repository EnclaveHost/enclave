//go:build linux && amd64

// rpc-storage-owner is a one-request storage-owner signing actor. It never
// opens a listener, starts an export, grants a volume or releases a reservation.
// Run only within the owner's independently bounded service. Fixed inherited
// FDs, not request pathnames, carry owner policy/journal/keys/contract/clock.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
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
	Schema        string                     `json:"schema"`
	Runtime       string                     `json:"runtime"`
	L1Volume      string                     `json:"l1Volume"`
	BaseVolume    string                     `json:"baseVolume"`
	ChainID       uint64                     `json:"chainId"`
	Ledger        string                     `json:"ledger"`
	RPCs          []string                   `json:"rpcs"`
	Confirmations uint64                     `json:"confirmations"`
	MaxAgeSeconds uint64                     `json:"maxAgeSeconds"`
	Export        bootstrap.RPCExportBinding `json:"export"`
}
type input struct {
	Bundle   []byte             `json:"bundle"`
	Manifest []byte             `json:"manifest"`
	Request  rpcstorage.Request `json:"request"`
}

// Machine input uses canonical JSON (sorted object keys). This rejects duplicate
// keys, aliases and alternate numeric encodings before typed decoding.
func decode(raw []byte, out any, exact bool) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var value any
	if err := d.Decode(&value); err != nil {
		return err
	}
	b, err := json.Marshal(value)
	if err != nil || !bytes.Equal(bytes.TrimSpace(raw), b) {
		return errors.New("canonical unique JSON required")
	}
	d = json.NewDecoder(bytes.NewReader(raw))
	if exact {
		d.DisallowUnknownFields()
	}
	if err := d.Decode(out); err != nil {
		return err
	}
	if exact {
		typed, err := json.Marshal(out)
		if err != nil {
			return err
		}
		normal := json.NewDecoder(bytes.NewReader(typed))
		normal.UseNumber()
		if err = normal.Decode(&value); err != nil {
			return err
		}
		typed, err = json.Marshal(value)
		if err != nil || !bytes.Equal(b, typed) {
			return errors.New("exact field names and complete canonical request required")
		}
	}
	return nil
}

func owned(fd int, max int64) ([]byte, error) {
	var before, after syscall.Stat_t
	flags, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), syscall.F_GETFL, 0)
	if errno != 0 || flags&syscall.O_ACCMODE != syscall.O_RDONLY || syscall.Fstat(fd, &before) != nil || before.Uid != 0 || before.Mode&syscall.S_IFMT != syscall.S_IFREG || before.Mode&07777 != 0600 || before.Nlink != 1 || before.Size <= 0 || before.Size > max {
		return nil, errors.New("held private root read-only input required")
	}
	raw := make([]byte, before.Size+1)
	n, err := syscall.Pread(fd, raw, 0)
	if err != nil {
		return nil, err
	}
	raw = raw[:n]
	if err != nil || int64(len(raw)) != before.Size || syscall.Fstat(fd, &after) != nil || before.Dev != after.Dev || before.Ino != after.Ino || before.Mode != after.Mode || before.Uid != after.Uid || before.Gid != after.Gid || before.Nlink != after.Nlink || before.Size != after.Size || before.Mtim != after.Mtim || before.Ctim != after.Ctim {
		return nil, errors.New("owner input changed")
	}
	return raw, nil
}

func envelope() error {
	if os.Geteuid() != 0 {
		return errors.New("owner service identity required")
	}
	group, e := os.ReadFile("/proc/self/cgroup")
	if e != nil {
		return e
	}
	line := strings.TrimSpace(string(group))
	if !strings.HasPrefix(line, "0::/") || strings.Contains(line, "\n") || line == "0::/" {
		return errors.New("dedicated unified cgroup required")
	}
	root := "/sys/fs/cgroup" + strings.TrimPrefix(line, "0::")
	for name, cap := range map[string]uint64{"memory.max": 128 << 20, "memory.swap.max": 0, "pids.max": 32} {
		b, e := os.ReadFile(root + "/" + name)
		if e != nil {
			return e
		}
		n, e := strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64)
		if e != nil || n > cap {
			return errors.New("owner service kernel envelope mismatch")
		}
	}
	b, e := os.ReadFile(root + "/cpu.max")
	if e != nil {
		return e
	}
	fields := strings.Fields(string(b))
	if len(fields) != 2 {
		return errors.New("CPU envelope")
	}
	q, e := strconv.ParseUint(fields[0], 10, 64)
	if e != nil {
		return e
	}
	period, e := strconv.ParseUint(fields[1], 10, 64)
	if e != nil || period == 0 || q == 0 || q > period {
		return errors.New("CPU1 envelope required")
	}
	return nil
}

func ownerDeadline(clock []byte, pin string, created, wallDeadline uint64, actorDeadline time.Time) (time.Time, error) {
	sum := sha256.Sum256(clock)
	if hex.EncodeToString(sum[:]) != pin {
		return time.Time{}, errors.New("original clock pin differs")
	}
	var k struct {
		Schema  string
		Boot    string `json:"bootId"`
		Origin  uint64 `json:"originMonotonicNs"`
		D       uint64 `json:"deadlineMonotonicNs"`
		Created uint64 `json:"createdUtcNs"`
		WallD   uint64 `json:"deadlineUtcNs"`
	}
	if err := decode(clock, &k, false); err != nil {
		return time.Time{}, err
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return time.Time{}, err
	}
	anchor := time.Now()
	mono, err := rpcservice.MonotonicNow()
	if err != nil {
		return time.Time{}, err
	}
	if k.Schema != "owned-rpc-startup-clock/1" || k.Boot != strings.TrimSpace(string(boot)) || k.Origin > math.MaxInt64-contract.RPCStartupNanoseconds || k.Created > math.MaxInt64-contract.RPCStartupNanoseconds || k.D != k.Origin+contract.RPCStartupNanoseconds || k.WallD != k.Created+contract.RPCStartupNanoseconds || k.Created != created || k.WallD != wallDeadline || mono < k.Origin || mono >= k.D || anchor.UnixNano() < int64(k.Created) || anchor.UnixNano() >= int64(k.WallD) {
		return time.Time{}, errors.New("original owner clock expired or substituted")
	}
	drift := (anchor.UnixNano() - int64(k.Created)) - int64(mono-k.Origin)
	if drift < -2_000_000_000 || drift > 2_000_000_000 {
		return time.Time{}, errors.New("owner clock relationship changed")
	}
	remaining := time.Duration(k.D - mono)
	if wall := time.Duration(int64(k.WallD) - anchor.UnixNano()); wall < remaining {
		remaining = wall
	}
	deadline := anchor.Add(remaining)
	if actorDeadline.Before(deadline) {
		deadline = actorDeadline
	}
	if !time.Now().Before(deadline) {
		return time.Time{}, errors.New("original actor deadline expired")
	}
	return deadline, nil
}

func run() error {
	if len(os.Args) != 1 {
		return errors.New("no path/endpoint/deadline arguments accepted")
	}
	actorDeadline := time.Now().Add(20 * time.Second)
	// Independent service manager must also enforce the 20-second actor cap.
	// This timer is supplementary; it is not proof of death under a kernel stall.
	timer := time.AfterFunc(time.Until(actorDeadline), func() { os.Exit(124) })
	defer timer.Stop()
	if err := envelope(); err != nil {
		return err
	}
	config, err := owned(3, 16384)
	if err != nil {
		return err
	}
	var p policy
	if err = decode(config, &p, true); err != nil {
		return err
	}
	if p.Schema != "enclave-rpc-storage-owner/1" || !contract.NonzeroHash(p.Runtime) || p.MaxAgeSeconds == 0 || p.MaxAgeSeconds > 120 {
		return errors.New("explicit owner service policy required")
	}
	contractBytes, err := owned(7, 65536)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(contractBytes)
	if hex.EncodeToString(sum[:]) != p.Export.ContractSHA256 {
		return errors.New("owner export contract pin differs")
	}
	var c struct {
		Created  uint64 `json:"createdUtcNs"`
		Deadline uint64 `json:"deadlineUtcNs"`
		Clock    struct {
			SHA256 string `json:"sha256"`
		} `json:"startupClock"`
		Control struct {
			Schema, Host string
			Port         uint16
			Client       string `json:"clientCertificateSha256"`
			Request      string `json:"requestSha256"`
		} `json:"appControl"`
	}
	if err = decode(contractBytes, &c, false); err != nil {
		return err
	}
	clock, err := owned(8, 65536)
	if err != nil {
		return err
	}
	deadline, err := ownerDeadline(clock, c.Clock.SHA256, c.Created, c.Deadline, actorDeadline)
	if err != nil {
		return err
	}
	timer.Reset(time.Until(deadline))
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 4<<20+1))
	if err != nil || len(raw) > 4<<20 {
		return errors.New("bounded one-shot request required")
	}
	var in input
	if err = decode(raw, &in, true); err != nil {
		return err
	}
	if err = in.Request.Validate(); err != nil {
		return err
	}
	requestBytes, _ := json.Marshal(in.Request)
	sum = sha256.Sum256(requestBytes)
	if c.Control.Schema != "enclave-rpc-export-control/1" || c.Control.Host != p.Export.Host || c.Control.Port != p.Export.Port || c.Control.Client != p.Export.ClientCertificateSHA256 || c.Control.Request != hex.EncodeToString(sum[:]) {
		return errors.New("owner contract does not select this exact request/control binding")
	}
	reader, err := bootstrap.NewReader(bootstrap.Config{ChainID: p.ChainID, Ledger: p.Ledger, RPCs: p.RPCs, Confirmations: p.Confirmations, MaxAge: time.Duration(p.MaxAgeSeconds) * time.Second})
	if err != nil {
		return err
	}
	var loaded bootstrap.Identity
	loaded.AppID = contract.AppID(in.Bundle)
	runtime, _ := hex.DecodeString(p.Runtime)
	copy(loaded.RuntimeID[:], runtime)
	var deployment [32]byte
	id, _ := hex.DecodeString(in.Request.Deployment[2:])
	copy(deployment[:], id)
	auth, err := reader.Authorize(ctx, deployment, in.Manifest, loaded)
	if err != nil {
		return err
	}
	var seeds [2][]byte
	defer func() {
		for _, seed := range seeds {
			clear(seed)
		}
	}()
	for i := range seeds {
		seeds[i], err = owned(5+i, 32)
		if err != nil {
			return err
		}
	}
	issuer, err := rpcstorage.NewOwnerIssuer(os.NewFile(4, "authoritative-owner-journal"), seeds, [2]string{p.L1Volume, p.BaseVolume}, p.Export, deadline)
	if err != nil {
		return err
	}
	proof, err := issuer.Issue(ctx, auth, in.Bundle, in.Request)
	if err != nil {
		return err
	}
	// A short write or lost response is ambiguous. Never resubmit this actor.
	n, err := os.Stdout.Write(proof)
	if err != nil {
		return err
	}
	if n != len(proof) {
		return io.ErrShortWrite
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "RPC storage-owner request refused:", err)
		os.Exit(1)
	}
}
