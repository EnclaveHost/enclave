//go:build linux && amd64

package rpcstorage

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"syscall"
	"time"

	"enclave.host/isolation/m3/rpcservice"
)

// GrantRoots sends the single final ENCLAVE-RPC-STORAGE/1 grant with the two
// held writable ext4 roots in L1/Base order. It requires the acknowledged,
// owner-reserved session with its export control bound, and is consumed even
// on failure: an ambiguous send closes the session and is never repeated. A
// grant is storage access for the exact monitor attempt, not RPC readiness.
func (s *BrokerSession) GrantRoots(l1, base *os.File) (err error) {
	s.mu.Lock()
	used, ready := s.rootsGranted, s.accepted && s.reserved && s.exportBound
	s.rootsGranted = true
	s.mu.Unlock()
	defer func() {
		if err != nil {
			s.lose()
		}
	}()
	if used {
		return errors.New("storage root grant already consumed")
	}
	if !ready {
		return errors.New("acknowledged reserved session with bound export required before root grant")
	}
	for _, f := range []*os.File{l1, base} {
		var st syscall.Stat_t
		var fs syscall.Statfs_t
		if f == nil || syscall.Fstat(int(f.Fd()), &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFDIR || st.Ino != 2 || st.Uid != 0 || st.Mode&0022 != 0 || syscall.Fstatfs(int(f.Fd()), &fs) != nil || fs.Type != 0xef53 || fs.Flags&1 != 0 {
			return errors.New("held writable ext4 filesystem roots required")
		}
	}
	if err = s.alive(); err != nil {
		return err
	}
	raw, err := json.Marshal(s.request)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(raw)
	packet := []byte(replyPrefix + hex.EncodeToString(sum[:]) + "\n")
	before := time.Now()
	now, err := rpcservice.MonotonicNow()
	if err != nil || now >= s.request.Deadline {
		return errors.New("late storage root grant")
	}
	remaining := time.Duration(s.request.Deadline - now)
	if remaining > 3*time.Second {
		remaining = 3 * time.Second
	}
	if err = s.conn.SetWriteDeadline(before.Add(remaining)); err != nil {
		return err
	}
	n, on, err := s.conn.WriteMsgUnix(packet, syscall.UnixRights(int(l1.Fd()), int(base.Fd())), nil)
	if err != nil || n != len(packet) || on != syscall.CmsgSpace(8) {
		return errors.New("ambiguous storage root grant; held")
	}
	if err = s.conn.SetWriteDeadline(time.Time{}); err != nil {
		return err
	}
	return s.alive()
}
