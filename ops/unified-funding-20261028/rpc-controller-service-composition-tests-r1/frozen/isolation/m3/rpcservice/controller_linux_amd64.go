//go:build linux && amd64

package rpcservice

import (
	"bytes"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"syscall"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m3/rpcplatform"
)

// This is an additional loaded-code check inside the namespace, before any
// controller/client launch. It does not replace the monitor's accepted runtime,
// wallet, storage, namespace or independently armed guardian obligations.
func verifyInstalledController() error {
	bundle, err := immutableFile("/app.bundle", contract.MaxRPCControllerBytes+(1<<20))
	if err != nil {
		return err
	}
	wasm, err := immutableFile(controllerWasm, contract.MaxRPCControllerBytes)
	if err != nil {
		return err
	}
	stated, err := immutableFile("/app.sha256", 65)
	if err != nil {
		return err
	}
	profile, err := immutableFile("/plat/native-rpc/profile.json", 16384)
	if err != nil {
		return err
	}
	return controllerIdentity(bundle, wasm, stated, profile)
}
func controllerIdentity(bundle, wasm, stated, profile []byte) error {
	man, loaded, err := contract.ParseRPC(bundle)
	if err != nil {
		return err
	}
	if !bytes.Equal(loaded, wasm) {
		return errors.New("RPC controller differs from bound component")
	}
	id := contract.AppID(bundle)
	// Accept the canonical statement with or without its trailing newline only.
	if !bytes.Equal(stated, []byte(hex.EncodeToString(id[:]))) && !bytes.Equal(stated, []byte(hex.EncodeToString(id[:])+"\n")) {
		return errors.New("RPC app statement differs from loaded bundle")
	}
	p, _, err := rpcplatform.ParseProfile(profile)
	if err != nil {
		return err
	}
	return p.CheckBundle(man, wasm)
}
func immutableFile(path string, limit int64) ([]byte, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	var st syscall.Stat_t
	var fs syscall.Statfs_t
	if syscall.Fstat(fd, &st) != nil || syscall.Fstatfs(fd, &fs) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Uid != 0 || st.Mode&0222 != 0 || st.Size < 1 || st.Size > limit || fs.Flags&stRdonly == 0 {
		return nil, errors.New("bounded immutable RPC app file required")
	}
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) != st.Size {
		return nil, errors.New("RPC app file changed while reading")
	}
	return b, nil
}
