//go:build linux && amd64

package rpcservice

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"syscall"
	"time"
	"unsafe"

	"enclave.host/isolation/contract"
)

func approvalIdentity(bundle, runtime []byte, nonce [32]byte) ([]byte, error) {
	man, _, err := contract.ParseRPC(bundle)
	if err != nil {
		return nil, err
	}
	var rt contract.RuntimeIdentity
	d := json.NewDecoder(bytes.NewReader(runtime))
	d.DisallowUnknownFields()
	if err = d.Decode(&rt); err != nil {
		return nil, err
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return nil, errors.New("trailing runtime identity")
	}
	rid, err := contract.RuntimeID(rt)
	if err != nil {
		return nil, err
	}
	b := contract.RPCStartBinding{AppID: contract.AppID(bundle), RuntimeID: rid, Nonce: nonce}
	dep, err := hex.DecodeString(man.SecretDeployment[2:])
	if err != nil || len(dep) != 32 {
		return nil, errors.New("RPC deployment identity required")
	}
	copy(b.Deployment[:], dep)
	return b.Frame()
}

func sealedApproval(frame []byte) (*os.File, error) {
	if _, err := contract.ParseRPCStartBinding(frame); err != nil {
		return nil, err
	}
	name := []byte("enclave-rpc-owner-gate\x00")
	fd, _, e := syscall.Syscall(sysMemfdCreate, uintptr(unsafe.Pointer(&name[0])), 3, 0)
	if e != 0 {
		return nil, e
	}
	f := os.NewFile(fd, "rpc-owner-binding")
	fail := func(err error) (*os.File, error) { f.Close(); return nil, err }
	if n, err := f.Write(frame); err != nil {
		return fail(err)
	} else if n != len(frame) {
		return fail(io.ErrShortWrite)
	}
	if _, err := fcntl(fd, fAddSeals, entrySeals); err != nil {
		return fail(err)
	}
	return f, nil
}

func (b *osBackend) prepareApproval() error {
	bundle, err := immutableFile("/app.bundle", contract.MaxRPCControllerBytes+(1<<20))
	if err != nil {
		return err
	}
	rt, err := immutableFile("/plat/rt/runtime.json", 16384)
	if err != nil {
		return err
	}
	var nonce [32]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return err
	}
	frame, err := approvalIdentity(bundle, rt, nonce)
	if err != nil {
		return err
	}
	binding, err := sealedApproval(frame)
	if err != nil {
		return err
	}
	r, w, err := os.Pipe()
	if err != nil {
		binding.Close()
		return err
	}
	if err = syscall.SetNonblock(int(r.Fd()), true); err != nil {
		r.Close()
		w.Close()
		binding.Close()
		return err
	}
	b.approvalReader, b.approvalWriter, b.approvalBinding, b.approvalFrame = r, w, binding, frame
	return nil
}

// The sole writer goes only to the front created by this supervisor. The
// expected nonce cannot be selected through a host request or reused after an
// ambiguous start. The driver is drained before CleanupConfirmed; while a
// read/start is uncertain these handles remain retained until process exit.
func (b *osBackend) ownerApproval(ctx context.Context) error {
	if !b.approvalUsed.CompareAndSwap(false, true) || b.approvalReader == nil {
		return errors.New("owner gate missing or consumed")
	}
	return readApproval(ctx, b.approvalReader, b.approvalFrame)
}

func readApproval(ctx context.Context, r *os.File, expected []byte) error {
	if _, err := contract.ParseRPCStartBinding(expected); err != nil {
		return err
	}
	var st syscall.Stat_t
	if r == nil || syscall.Fstat(int(r.Fd()), &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFIFO {
		return errors.New("private approval reader required")
	}
	fd := int(r.Fd())
	if err := syscall.SetNonblock(fd, true); err != nil {
		return err
	}
	buf := make([]byte, contract.RPCStartFrameSize+1)
	used := 0
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, err := syscall.Read(fd, buf[used:])
		if n > 0 {
			used += n
			if used > contract.RPCStartFrameSize {
				return errors.New("oversized owner approval")
			}
		}
		if err == nil && n == 0 {
			if used != len(expected) || !bytes.Equal(buf[:used], expected) {
				return errors.New("owner approval missing or bound to another attempt")
			}
			return ctx.Err()
		}
		if err != nil && err != syscall.EAGAIN && err != syscall.EINTR {
			return err
		}
		if _, err = pollOwner(fd, 10*time.Millisecond); err != nil {
			return err
		}
	}
}

// InstalledRuntime reads the fixed immutable measured runtime identity, never a
// value selected by the host control channel or a bootstrap report document.
func InstalledRuntime() (contract.RuntimeIdentity, error) {
	var rt contract.RuntimeIdentity
	raw, err := immutableFile("/plat/rt/runtime.json", 16384)
	if err != nil {
		return rt, err
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err = d.Decode(&rt); err != nil {
		return rt, err
	}
	var trailing any
	if d.Decode(&trailing) != io.EOF {
		return rt, errors.New("trailing installed runtime")
	}
	return rt, rt.Validate()
}
