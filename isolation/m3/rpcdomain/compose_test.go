//go:build linux && amd64

package rpcdomain

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

func TestCompositionFailureConsumesPreparation(t *testing.T) {
	p := &Prepared{}
	if _, err := p.ComposeCommand(nil, StateVolume{}, StateVolume{}); err == nil {
		t.Fatal("invalid preparation accepted")
	}
	if p.composition == nil {
		t.Fatal("failed composition not retained")
	}
	if _, err := p.Take(); err == nil {
		t.Fatal("partial composition transferred")
	}
	if err := p.Abandon(); err == nil {
		t.Fatal("in-flight composition closed")
	}
	if _, err := p.ComposeCommand(nil, StateVolume{}, StateVolume{}); err == nil {
		t.Fatal("retried composition")
	}
}

func TestCompositionSourceAndStateRefusals(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "data"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "data", "value"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("data", filepath.Join(root, "alias")); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	c := &Composition{}
	defer func() {
		for _, h := range c.held {
			h.Close()
		}
	}()
	if _, err = c.source(f, "data/value", false); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"../data", "alias/value", "data/../value", "/data", "data//value"} {
		if _, err = c.source(f, path, false); err == nil {
			t.Fatalf("accepted escaped/symlink source %s", path)
		}
	}
	for _, role := range []string{"l1", "base", "unknown"} {
		if _, _, err = c.state(StateVolume{LogicalID: strings.Repeat("a", 64), Root: f}, role); err == nil {
			t.Fatal("ordinary temp directory accepted as dedicated ext4", role)
		}
	}
	if _, _, err = c.state(StateVolume{}, "l1"); err == nil {
		t.Fatal("nil state accepted")
	}
	if _, err = boundedImmutable(f, 1024); err == nil {
		t.Fatal("directory accepted as platform file")
	}
}

func TestCompositionDirectoriesAndExclusiveMetadata(t *testing.T) {
	c := &Composition{Path: t.TempDir()}
	// Parent modes are explicit, even when already created under umask 0077.
	if err := os.Mkdir(c.at("etc"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := c.directories("etc/enclave-rpc"); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"etc", "etc/enclave-rpc"} {
		st, err := os.Stat(c.at(p))
		if err != nil || st.Mode().Perm() != 0755 {
			t.Fatal(p, st, err)
		}
	}
	if err := c.write("etc/enclave-rpc/public-fixture", []byte("not a credential"), 0444, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
	if err := c.write("etc/enclave-rpc/public-fixture", []byte("overwrite"), 0444, os.Getuid(), os.Getgid()); err == nil {
		t.Fatal("metadata replaced")
	}
	if err := os.Symlink("etc", c.at("alias")); err != nil {
		t.Fatal(err)
	}
	if err := c.directories("alias"); err == nil {
		t.Fatal("symlink directory accepted")
	}
}

func TestCompositionMountFixture(t *testing.T) {
	root := os.Getenv("RPC_COMPOSE_FIXTURE")
	if root == "" {
		t.Skip("private namespace child only")
	}
	fail := func(e interface{}) { fmt.Fprintln(os.Stderr, e); os.Exit(91) }
	if os.Getpid() != 1 {
		fail("fixture not private PID1")
	}
	if err := syscall.Mount("", "/", "", syscall.MS_PRIVATE|syscall.MS_REC, ""); err != nil {
		fail(err)
	}
	c := &Composition{Path: filepath.Join(root, "view")}
	src, err := os.Open(filepath.Join(root, "source"))
	if err != nil {
		fail(err)
	}
	child, err := os.Open(filepath.Join(root, "source", "data"))
	if err != nil {
		fail(err)
	}
	if err = c.bind(src, "srv/state", true, true); err != nil {
		fail(err)
	}
	if err = c.bind(child, "srv/state/data", true, false); err != nil {
		fail(err)
	}
	var fs syscall.Statfs_t
	if syscall.Statfs(c.at("srv/state"), &fs) != nil || fs.Flags&15 != 15 {
		fail("root mount flags")
	}
	if syscall.Statfs(c.at("srv/state/data"), &fs) != nil || fs.Flags&15 != 14 {
		fail("child mount flags")
	}
	if err = os.WriteFile(c.at("srv/state/forbidden"), []byte("x"), 0600); err == nil {
		fail("root writable")
	}
	if err = os.WriteFile(c.at("srv/state/data/allowed"), []byte("dummy only"), 0600); err != nil {
		fail(err)
	}
	if err = os.WriteFile(filepath.Join(root, "source", "source-still-writable"), []byte("x"), 0600); err != nil {
		fail("source mount changed")
	}
	if len(c.Mounts) != 2 {
		fail("mount bookkeeping")
	}
	fmt.Println("PASS read-only root, writable child, exact inode and unchanged source")
	os.Exit(0)
}

func TestActualCompositionBindings(t *testing.T) {
	if os.Getuid() != 0 {
		t.Fatal("requires bounded private user namespace runner")
	}
	root := t.TempDir()
	for _, p := range []string{"source/data", "view/srv"} {
		if err := os.MkdirAll(filepath.Join(root, p), 0700); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestCompositionMountFixture$")
	cmd.Env = []string{"RPC_COMPOSE_FIXTURE=" + root}
	cmd.SysProcAttr = &syscall.SysProcAttr{Cloneflags: syscall.CLONE_NEWNS | syscall.CLONE_NEWPID}
	b, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(b), "PASS read-only root") {
		t.Fatalf("%v %s", err, b)
	}
	if _, err = os.Stat(filepath.Join(root, "view/srv/state/data/allowed")); !os.IsNotExist(err) {
		t.Fatal("child mount escaped namespace", err)
	}
	b, err = os.ReadFile(filepath.Join(root, "source/data/allowed"))
	if err != nil || string(b) != "dummy only" {
		t.Fatal("not actual source binding", err)
	}
}
