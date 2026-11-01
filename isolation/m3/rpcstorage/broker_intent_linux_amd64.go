//go:build linux && amd64

package rpcstorage

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"syscall"

	"enclave.host/isolation/m2/bootstrap"
)

// BrokerIntent is an exclusive durable reservation, NOT an export grant. All
// acquired records stay on disk after every error. No release/delete/retry API
// exists. The service must still arm its independent guardian and obtain exact
// storage-owner fencing before sending writable roots to the monitor.
type BrokerIntent struct{ records []*os.File }

// ReserveBrokerIntent consumes BOTH logical volume identities in the storage
// owner's private, persistent journal before any possibly submitted export.
// The same journal namespace must be used by every writer for those volumes;
// a caller-selected fresh directory cannot establish global exclusivity.
// Accepted bootstrap, not host JSON, supplies that namespace authority.
func ReserveBrokerIntent(c *bootstrap.RPCStorageConsent, r Request, journal *os.File) (*BrokerIntent, error) {
	if err := r.Validate(); err != nil {
		return nil, err
	}
	l, b, err := c.WriterEpochs(r)
	if err != nil {
		return nil, err
	}
	record := struct {
		Schema    string  `json:"schema"`
		Request   Request `json:"request"`
		L1Epoch   string  `json:"l1Epoch"`
		BaseEpoch string  `json:"baseEpoch"`
	}{"enclave-rpc-storage-consumed/1", r, l, b}
	raw, err := json.Marshal(record)
	if err != nil {
		return nil, err
	}
	return reserveRecords(journal, [2]string{r.L1Volume, r.BaseVolume}, raw)
}
func reserveRecords(journal *os.File, volumes [2]string, raw []byte) (*BrokerIntent, error) {
	intent := &BrokerIntent{}
	var st syscall.Stat_t
	var fs syscall.Statfs_t
	if journal == nil || syscall.Fstat(int(journal.Fd()), &st) != nil || st.Uid != 0 || st.Mode&syscall.S_IFMT != syscall.S_IFDIR || st.Mode&07777 != 0700 || syscall.Fstatfs(int(journal.Fd()), &fs) != nil || fs.Type != 0xef53 || fs.Flags&1 != 0 {
		return intent, errors.New("storage owner's held private writable ext4 journal required")
	}
	// Fixed lexical ordering prevents two concurrent pair reservations from
	// making progress in opposite orders. A partial reservation remains held.
	if volumes[1] < volumes[0] {
		volumes[0], volumes[1] = volumes[1], volumes[0]
	}
	for _, v := range volumes {
		f, err := consumeRecord(journal, v, raw)
		if f != nil {
			intent.records = append(intent.records, f)
		}
		if err != nil {
			return intent, err
		}
	}
	return intent, nil
}
func consumeRecord(d *os.File, name string, raw []byte) (*os.File, error) {
	fd, err := syscall.Openat(int(d.Fd()), name, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), "consumed-volume-writer")
	defer f.Close()
	// Persist even a partial record/name on failure. Never compensate by unlink.
	n, writeErr := f.Write(raw)
	modeErr := f.Chmod(0400)
	syncErr := f.Sync()
	dirErr := d.Sync()
	if writeErr != nil {
		return nil, writeErr
	}
	if n != len(raw) {
		return nil, io.ErrShortWrite
	}
	if modeErr != nil {
		return nil, modeErr
	}
	if syncErr != nil {
		return nil, syncErr
	}
	if dirErr != nil {
		return nil, dirErr
	}
	var before, after syscall.Stat_t
	if err = syscall.Fstat(fd, &before); err != nil {
		return nil, err
	}
	ro, err := syscall.Openat(int(d.Fd()), name, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	held := os.NewFile(uintptr(ro), "retained-volume-writer-intent")
	fail := func(e error) (*os.File, error) { held.Close(); return nil, e }
	if syscall.Fstat(ro, &after) != nil || after.Dev != before.Dev || after.Ino != before.Ino || after.Uid != 0 || after.Nlink != 1 || after.Mode&07777 != 0400 || after.Mode&syscall.S_IFMT != syscall.S_IFREG {
		return fail(errors.New("persistent writer intent identity changed"))
	}
	read, e := io.ReadAll(io.LimitReader(held, int64(len(raw)+1)))
	if e != nil || !bytes.Equal(raw, read) {
		return fail(errors.New("persistent writer intent readback mismatch"))
	}
	return held, nil
}
