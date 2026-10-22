// libpvmcustody.so: the Android pVM's custody v2 release (isolation/m2/pvmcustody) as a C library the measured payload
// dlopens from the APK (shielded/anchor/avf/payload/anchor_payload.c custody_start), so it is inside the APK's code hash.
// Built with -buildmode=c-shared for android/arm64 (shielded/anchor/avf/build.sh pvmcustody).
//
//	int pvmc_start(const pvmc_host *host, const uint8_t deployment[32], const uint8_t *pkg, size_t pkg_len,
//	               const uint8_t app[32], const char *identity, const char *selftest, const uint8_t spki[44],
//	               const uint8_t instance_key[44], uint8_t *out, size_t out_cap, size_t *out_len, char *err, size_t err_cap)
//
// 0 and out = mode NUL resolved-config NUL then "K=V" NUL per value (the opened values never leave this process), or -1
// with the reason in err. resolved-config is the owner-committed config with $NAME resolved (pvmcustody Result.Resolved). The payload zeroes out after handing it to the runtime. Every host callback is the payload's:
//
//	dial(ctx, host, err, cap) -> a connected stream fd to host:443 (pvm-rt egress "CONNECT <host> 443"), or -1
//	attest(ctx, challenge[64], chain_out, cap, &len, sig_out[64], err, cap) -> 0: chain_out = (u32 BE length, DER)...,
//	       leaf first, from AVmPayload_requestAttestation; sig_out = the instance key's Ed25519 signature over
//	       "enclave-pvm-instance-sig-v1\n" || challenge
//	authorize(ctx, vault_hex, id_hex, binding_hex, out, cap, err, cap) -> 0: out = "<endpoint> <expiry> <sig>"
//	log(ctx, line)
package main

/*
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
typedef struct {
    int (*dial)(void *, const char *, char *, size_t);
    int (*attest)(void *, const uint8_t *, uint8_t *, size_t, size_t *, uint8_t *, char *, size_t);
    int (*authorize)(void *, const char *, const char *, const char *, char *, size_t, char *, size_t);
    void (*log)(void *, const char *);
    void *ctx;
} pvmc_host;
static int pvmc_call_dial(const pvmc_host *h, const char *host, char *err, size_t cap) { return h->dial(h->ctx, host, err, cap); }
static int pvmc_call_attest(const pvmc_host *h, const uint8_t *ch, uint8_t *out, size_t cap, size_t *len, uint8_t *sig, char *err, size_t ecap) {
    return h->attest(h->ctx, ch, out, cap, len, sig, err, ecap); }
static int pvmc_call_authorize(const pvmc_host *h, const char *v, const char *i, const char *b, char *out, size_t cap, char *err, size_t ecap) {
    return h->authorize(h->ctx, v, i, b, out, cap, err, ecap); }
static void pvmc_call_log(const pvmc_host *h, const char *l) { if (h->log) h->log(h->ctx, l); }
*/
import "C"

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"enclave.host/isolation/m2/pvmcustody"
)

func main() {}

type host struct{ h *C.pvmc_host }

func cErr(b []byte) string {
	if i := strings.IndexByte(string(b), 0); i >= 0 {
		b = b[:i]
	}
	return string(b)
}

// fileConn: a payload-opened stream (a vsock: net.FileConn does not know AF_VSOCK) as a net.Conn, deadlines through the
// runtime poller (the fd is set non-blocking first).
type fileConn struct{ *os.File }
type vsockAddr struct{}

func (vsockAddr) Network() string     { return "vsock" }
func (vsockAddr) String() string      { return "vsock:host" }
func (fileConn) LocalAddr() net.Addr  { return vsockAddr{} }
func (fileConn) RemoteAddr() net.Addr { return vsockAddr{} }

func (h host) Dial(ctx context.Context, name string) (net.Conn, error) {
	cs := C.CString(name)
	defer C.free(unsafe.Pointer(cs))
	eb := make([]byte, 256)
	fd := int(C.pvmc_call_dial(h.h, cs, (*C.char)(unsafe.Pointer(&eb[0])), C.size_t(len(eb))))
	if fd < 0 {
		return nil, fmt.Errorf("egress: %s", cErr(eb))
	}
	if err := syscall.SetNonblock(fd, true); err != nil {
		syscall.Close(fd)
		return nil, err
	}
	return fileConn{os.NewFile(uintptr(fd), "egress:"+name)}, nil
}

func (h host) Attest(ch [64]byte) (*pvmcustody.Attested, error) {
	out := make([]byte, 64<<10)
	sig := make([]byte, 64)
	eb := make([]byte, 256)
	var n C.size_t
	if C.pvmc_call_attest(h.h, (*C.uint8_t)(unsafe.Pointer(&ch[0])), (*C.uint8_t)(unsafe.Pointer(&out[0])), C.size_t(len(out)), &n,
		(*C.uint8_t)(unsafe.Pointer(&sig[0])), (*C.char)(unsafe.Pointer(&eb[0])), C.size_t(len(eb))) != 0 {
		return nil, fmt.Errorf("attestation: %s", cErr(eb))
	}
	if int(n) > len(out) {
		return nil, errors.New("attestation: the chain overran its buffer")
	}
	a := &pvmcustody.Attested{InstanceSig: sig}
	for b := out[:n]; len(b) > 0; {
		if len(b) < 4 {
			return nil, errors.New("attestation: a truncated chain")
		}
		l := int(binary.BigEndian.Uint32(b))
		if l == 0 || l > len(b)-4 {
			return nil, errors.New("attestation: a malformed chain")
		}
		a.Chain = append(a.Chain, append([]byte(nil), b[4:4+l]...))
		b = b[4+l:]
	}
	return a, nil
}

func (h host) Authorize(_ context.Context, vault [20]byte, id, binding [32]byte) (string, string, int64, error) {
	v, i, b := C.CString("0x"+hex.EncodeToString(vault[:])), C.CString("0x"+hex.EncodeToString(id[:])), C.CString(hex.EncodeToString(binding[:]))
	defer C.free(unsafe.Pointer(v))
	defer C.free(unsafe.Pointer(i))
	defer C.free(unsafe.Pointer(b))
	out, eb := make([]byte, 1024), make([]byte, 256)
	if C.pvmc_call_authorize(h.h, v, i, b, (*C.char)(unsafe.Pointer(&out[0])), C.size_t(len(out)), (*C.char)(unsafe.Pointer(&eb[0])), C.size_t(len(eb))) != 0 {
		return "", "", 0, fmt.Errorf("the operator's authorization: %s", cErr(eb))
	}
	f := strings.Fields(cErr(out))
	if len(f) != 3 {
		return "", "", 0, errors.New("the operator's authorization is not <endpoint> <expiry> <sig>")
	}
	exp, err := strconv.ParseInt(f[1], 10, 64)
	if err != nil {
		return "", "", 0, errors.New("the operator's authorization has no expiry")
	}
	return f[0], f[2], exp, nil
}

func (h host) Logf(format string, args ...any) {
	l := C.CString(fmt.Sprintf(format, args...))
	defer C.free(unsafe.Pointer(l))
	C.pvmc_call_log(h.h, l)
}

func fail(err *C.char, cap C.size_t, e error) C.int {
	if cap > 0 {
		b := unsafe.Slice((*byte)(unsafe.Pointer(err)), int(cap))
		n := copy(b[:len(b)-1], e.Error())
		b[n] = 0
	}
	return -1
}

//export pvmc_start
func pvmc_start(h *C.pvmc_host, deployment *C.uint8_t, pkg *C.uint8_t, pkgLen C.size_t, app *C.uint8_t, identity, selftest *C.char,
	spki, instanceKey *C.uint8_t, out *C.uint8_t, outCap C.size_t, outLen *C.size_t, errOut *C.char, errCap C.size_t) C.int {
	if h == nil || deployment == nil || pkg == nil || app == nil || identity == nil || selftest == nil || spki == nil || instanceKey == nil || out == nil || outLen == nil {
		return fail(errOut, errCap, errors.New("pvmc_start: a required argument is null"))
	}
	var id [32]byte
	copy(id[:], unsafe.Slice((*byte)(unsafe.Pointer(deployment)), 32))
	vm := pvmcustody.VM{Identity: C.GoString(identity), Selftest: C.GoString(selftest),
		SPKI: C.GoBytes(unsafe.Pointer(spki), 44), InstanceKey: C.GoBytes(unsafe.Pointer(instanceKey), 44)}
	copy(vm.AppID[:], unsafe.Slice((*byte)(unsafe.Pointer(app)), 32))
	r, err := pvmcustody.Start(context.Background(), host{h}, vm, id, C.GoBytes(unsafe.Pointer(pkg), C.int(pkgLen)))
	if err != nil {
		return fail(errOut, errCap, err)
	}
	var b []byte
	b = append(append(b, r.SecretsMode...), 0)
	b = append(append(b, r.Resolved...), 0)
	for k, v := range r.Values {
		if strings.IndexByte(k, 0) >= 0 || strings.IndexByte(v, 0) >= 0 || strings.IndexByte(k, '=') >= 0 {
			return fail(errOut, errCap, errors.New("a value holds a NUL or a name holds '='"))
		}
		b = append(append(append(append(b, k...), '='), v...), 0)
	}
	defer func() {
		for i := range b {
			b[i] = 0
		}
	}()
	if len(b) > int(outCap) {
		return fail(errOut, errCap, fmt.Errorf("the result is %d bytes, over the payload's %d", len(b), int(outCap)))
	}
	copy(unsafe.Slice((*byte)(unsafe.Pointer(out)), int(outCap)), b)
	*outLen = C.size_t(len(b))
	return 0
}
