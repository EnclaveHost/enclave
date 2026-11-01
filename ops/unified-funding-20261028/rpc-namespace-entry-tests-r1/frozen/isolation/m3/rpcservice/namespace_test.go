//go:build linux && amd64

package rpcservice

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Only the bounded inert fixture runner sets this variable. No production
// entry has a test flag or accepts a caller-supplied root pathname.
func TestRPCNamespaceFixtureChild(t *testing.T) {
	mode := os.Getenv("RPC_NAMESPACE_FIXTURE")
	if mode == "" {
		t.Skip("subprocess helper")
	}
	fail := func(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(91) }
	root := os.Getenv("RPC_NAMESPACE_FIXTURE_ROOT")
	if os.Getpid() != 1 || root == "" {
		fail(fmt.Errorf("fixture not PID1"))
	}
	// Mounts affect only this child's CLONE_NEWNS namespace.
	if err := syscall.Mount("", "/", "", syscall.MS_PRIVATE|syscall.MS_REC, ""); err != nil {
		fail(err)
	}
	if err := syscall.Mount(root, root, "", syscall.MS_BIND, ""); err != nil {
		fail(err)
	}
	if mode != "writable" {
		if err := syscall.Mount("", root, "", syscall.MS_REMOUNT|syscall.MS_BIND|syscall.MS_RDONLY|syscall.MS_NOSUID|syscall.MS_NODEV, ""); err != nil {
			fail(err)
		}
	}
	f, err := os.Open(root)
	if err != nil {
		fail(err)
	}
	fd := int(f.Fd())
	err = enterNamespace(f)
	if mode != "success" {
		if err == nil {
			fail(fmt.Errorf("unsafe %s root accepted", mode))
		}
		fmt.Println("REFUSED " + mode)
		os.Exit(0)
	}
	if err != nil {
		fail(err)
	}
	var st syscall.Stat_t
	if syscall.Fstat(fd, &st) != syscall.EBADF {
		fail(fmt.Errorf("outside root descriptor retained"))
	}
	b, err := os.ReadFile("/sentinel")
	if err != nil || string(b) != "isolated fixture\n" {
		fail(fmt.Errorf("wrong root: %v", err))
	}
	if _, err = os.Stat("/home"); !os.IsNotExist(err) {
		fail(fmt.Errorf("ancestor root reachable"))
	}
	if err = os.WriteFile("/changed", []byte("x"), 0600); err == nil {
		fail(fmt.Errorf("root writable"))
	}
	var fs syscall.Statfs_t
	if syscall.Statfs("/proc", &fs) != nil || fs.Type != procMagic || fs.Flags&15 != 15 {
		fail(fmt.Errorf("proc flags/type"))
	}
	self, _ := os.Readlink("/proc/self/ns/pid")
	one, _ := os.Readlink("/proc/1/ns/pid")
	if self == "" || self != one {
		fail(fmt.Errorf("ancestor proc view"))
	}
	threads, err := os.ReadDir("/proc/self/task")
	if err != nil || len(threads) == 0 {
		fail(fmt.Errorf("missing tasks"))
	}
	for _, thread := range threads {
		b, err := os.ReadFile("/proc/self/task/" + thread.Name() + "/status")
		if err != nil || !strings.Contains(string(b), "NoNewPrivs:\t1\n") {
			fail(fmt.Errorf("thread without no_new_privs"))
		}
	}
	fmt.Println("PASS private PID1/root/proc/all-thread no_new_privs")
	os.Exit(0)
}

func TestActualRPCNamespaceRootSwitch(t *testing.T) {
	if os.Getuid() != 0 {
		t.Fatal("requires private user namespace fixture runner")
	}
	for _, mode := range []string{"success", "writable", "populated", "symlink"} {
		t.Run(mode, func(t *testing.T) {
			root, err := os.MkdirTemp("/tmp", "rpc-namespace-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(root)
			if err = os.WriteFile(filepath.Join(root, "sentinel"), []byte("isolated fixture\n"), 0444); err != nil {
				t.Fatal(err)
			}
			if mode == "symlink" {
				err = os.Symlink("/tmp", filepath.Join(root, "proc"))
			} else {
				err = os.Mkdir(filepath.Join(root, "proc"), 0555)
			}
			if err != nil {
				t.Fatal(err)
			}
			if mode == "populated" {
				if err = os.WriteFile(filepath.Join(root, "proc", "unexpected"), []byte("x"), 0444); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestRPCNamespaceFixtureChild$")
			cmd.Env = []string{"RPC_NAMESPACE_FIXTURE=" + mode, "RPC_NAMESPACE_FIXTURE_ROOT=" + root}
			cmd.SysProcAttr = &syscall.SysProcAttr{Cloneflags: syscall.CLONE_NEWNS | syscall.CLONE_NEWPID | syscall.CLONE_NEWIPC | syscall.CLONE_NEWUTS | syscall.CLONE_NEWNET}
			cmd.WaitDelay = 500 * time.Millisecond
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("%v: %s", err, out)
			}
			want := "REFUSED " + mode
			if mode == "success" {
				want = "PASS private PID1/root/proc/all-thread no_new_privs"
			}
			if strings.TrimSpace(string(out)) != want {
				t.Fatalf("unexpected result %q", out)
			}
		})
	}
}

func TestRPCNamespaceHostAndMissingRootRefused(t *testing.T) {
	if enterNamespace(nil) == nil || checkNamespaceRoot(nil) == nil {
		t.Fatal("host/nil accepted")
	}
	f, err := os.CreateTemp("/tmp", "rpc-root-file-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if checkNamespaceRoot(f) == nil {
		t.Fatal("ordinary file root accepted")
	}
}
