// snpkey: the custody v2 custodian's sealing key (docs/security/secret-custody-v2.md §8.1), from INSIDE an SEV-SNP guest.
//
//	snpkey derive    prints the 32-byte key the PSP derives for this guest, hex
//
// MSG_KEY_REQ through /dev/sev-guest (SNP_GET_DERIVED_KEY): root key VCEK (this chip), mixing the guest POLICY and the
// launch MEASUREMENT (guest_field_select bits 0 and 3), VMPL 0. Only the same code, launched with the same policy, on the
// same chip, gets the same key. TCB is NOT mixed: a microcode update must not erase a custodian's share; the custodian
// checks its own fresh report against the TCB floor instead (§8.2).
package main

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

const (
	snpGetDerivedKey = 0xC0205301 // _IOWR('S', 0x1, struct snp_guest_request_ioctl), 32 bytes
	fieldPolicy      = 1 << 0
	fieldMeasurement = 1 << 3
)

type guestRequest struct {
	MsgVersion uint8
	_          [7]byte
	ReqData    uint64
	RespData   uint64
	ExitInfo2  uint64
}

type derivedKeyReq struct {
	RootKeySelect    uint32
	Rsvd             uint32
	GuestFieldSelect uint64
	VMPL             uint32
	GuestSVN         uint32
	TCBVersion       uint64
}

func derive() ([]byte, error) {
	f, err := os.OpenFile("/dev/sev-guest", os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	req := derivedKeyReq{RootKeySelect: 0, GuestFieldSelect: fieldPolicy | fieldMeasurement}
	var resp [64]byte
	g := guestRequest{MsgVersion: 1, ReqData: uint64(uintptr(unsafe.Pointer(&req))), RespData: uint64(uintptr(unsafe.Pointer(&resp)))}
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), snpGetDerivedKey, uintptr(unsafe.Pointer(&g))); e != 0 {
		return nil, fmt.Errorf("SNP_GET_DERIVED_KEY: %v (fw_error 0x%x vmm_error 0x%x)", e, uint32(g.ExitInfo2), uint32(g.ExitInfo2>>32))
	}
	if st := binary.LittleEndian.Uint32(resp[0:4]); st != 0 {
		return nil, fmt.Errorf("MSG_KEY_RSP status 0x%x", st)
	}
	key := make([]byte, 32)
	copy(key, resp[32:64])
	allZero := true
	for _, b := range key {
		allZero = allZero && b == 0
	}
	if allZero {
		return nil, fmt.Errorf("the PSP returned an all-zero key")
	}
	return key, nil
}

func main() {
	if len(os.Args) != 2 || os.Args[1] != "derive" {
		fmt.Fprintln(os.Stderr, "usage: snpkey derive")
		os.Exit(2)
	}
	k, err := derive()
	if err != nil {
		fmt.Fprintln(os.Stderr, "snpkey:", err)
		os.Exit(1)
	}
	fmt.Println(hex.EncodeToString(k))
}
