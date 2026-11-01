//go:build linux && amd64

package rpcstorage

import (
	"os"
	"strings"
	"syscall"
	"testing"

	"enclave.host/isolation/m2/bootstrap"
	"enclave.host/isolation/m3/rpcservice"
)

func TestBrokerRefusesUnsignedAndUnsealedAuthority(t *testing.T) {
	now, e := rpcservice.MonotonicNow()
	if e != nil {
		t.Fatal(e)
	}
	bundle := rpcBundle(t)
	r, e := NewRequest(bundle, now)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = AuthorizeBrokerRequest(&bootstrap.Authorization{}, bundle, r, []byte(`{}`), nil); e == nil {
		t.Fatal("missing original clock accepted")
	}
	if _, e = ReserveBrokerIntent(&bootstrap.RPCStorageConsent{}, r, nil); e == nil {
		t.Fatal("fabricated consent accepted")
	}
	if _, e = ReserveBrokerIntent(nil, r, nil); e == nil {
		t.Fatal("nil consent accepted")
	}
}
func TestPersistentRecordExclusiveReadbackAndCrashHold(t *testing.T) {
	// The atomic record primitive is exercised on a real disposable filesystem.
	// reserveRecords additionally requires ext4; tmpfs is deliberately not a
	// production durable journal. No process/power-loss durability is inferred.
	d, e := os.Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer d.Close()
	name := strings.Repeat("a", 64)
	raw := []byte(`{"fixture":"consumed-before-export"}`)
	f, e := consumeRecord(d, name, raw)
	if e != nil {
		t.Fatal(e)
	}
	var st syscall.Stat_t
	if e = syscall.Fstat(int(f.Fd()), &st); e != nil || st.Mode&0777 != 0400 || st.Nlink != 1 {
		t.Fatal(st, e)
	}
	if _, e = f.Write([]byte("changed")); e == nil {
		t.Fatal("retained record is writable")
	}
	f.Close()
	if _, e = consumeRecord(d, name, raw); e == nil {
		t.Fatal("closed handle permitted replay")
	}
	b, e := os.ReadFile(d.Name() + "/" + name)
	if e != nil || string(b) != string(raw) {
		t.Fatal("retained record changed", e)
	}
	// Simulate an interrupted writer that left only its exclusive name. The
	// next invocation must hold that uncertainty, never overwrite or resume it.
	name2 := strings.Repeat("b", 64)
	if e = os.WriteFile(d.Name()+"/"+name2, nil, 0400); e != nil {
		t.Fatal(e)
	}
	if _, e = consumeRecord(d, name2, raw); e == nil {
		t.Fatal("partial record was reused")
	}
}
func TestBrokerRefusesVolatileJournalAndSymlink(t *testing.T) {
	d, e := os.Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer d.Close()
	var fs syscall.Statfs_t
	if e = syscall.Fstatfs(int(d.Fd()), &fs); e != nil {
		t.Fatal(e)
	}
	if fs.Type != 0x01021994 {
		t.Fatal("qualification requires private tmpfs")
	}
	names := [2]string{strings.Repeat("a", 64), strings.Repeat("b", 64)}
	if _, e = reserveRecords(d, names, []byte("fixture")); e == nil {
		t.Fatal("tmpfs treated as persistent")
	}
	target := d.Name() + "/target"
	if e = os.WriteFile(target, []byte("untouched"), 0600); e != nil {
		t.Fatal(e)
	}
	if e = os.Symlink(target, d.Name()+"/"+names[0]); e != nil {
		t.Fatal(e)
	}
	if _, e = consumeRecord(d, names[0], []byte("bad")); e == nil {
		t.Fatal("symlink followed")
	}
	b, _ := os.ReadFile(target)
	if string(b) != "untouched" {
		t.Fatal("symlink target modified")
	}
}

func TestActualExt4PairAndPartialReservation(t *testing.T) {
	root := os.Getenv("RPC_TEST_PERSISTENT_DIR")
	if root == "" {
		t.Fatal("explicit disposable ext4 qualification root required")
	}
	for _, partial := range []bool{false, true} {
		path, e := os.MkdirTemp(root, "broker-journal-")
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(func() { os.RemoveAll(path) })
		if e = os.Chmod(path, 0700); e != nil {
			t.Fatal(e)
		}
		d, e := os.Open(path)
		if e != nil {
			t.Fatal(e)
		}
		defer d.Close()
		names := [2]string{strings.Repeat("a", 64), strings.Repeat("b", 64)}
		if partial {
			if e = os.WriteFile(path+"/"+names[1], []byte("prior-uncertain-attempt"), 0400); e != nil {
				t.Fatal(e)
			}
		}
		i, e := reserveRecords(d, names, []byte("inert-authenticated-attempt-fixture"))
		if partial {
			if e == nil || len(i.records) != 1 {
				t.Fatal("partial pair lost hold", e)
			}
		} else {
			if e != nil || len(i.records) != 2 {
				t.Fatal("ext4 pair", e)
			}
		}
		for _, f := range i.records {
			f.Close()
		}
		if _, e = reserveRecords(d, names, []byte("repeat")); e == nil {
			t.Fatal("persistent pair was replayed")
		}
		if partial {
			b, _ := os.ReadFile(path + "/" + names[1])
			if string(b) != "prior-uncertain-attempt" {
				t.Fatal("uncertain prior record overwritten")
			}
		}
	}
}
