//go:build linux && amd64

package rpcdomain

import (
	"os"
	"reflect"
	"syscall"
	"testing"

	"enclave.host/isolation/m3/rpcservice"
)

func TestRPCMonitorCommandTransfersExactCapabilities(t *testing.T) {
	files := make([]*os.File, 12)
	for i := range files {
		f, err := os.CreateTemp("/tmp", "rpc-command-")
		if err != nil {
			t.Fatal(err)
		}
		files[i] = f
		defer os.Remove(f.Name())
		defer f.Close()
	}
	c := Capabilities{Owner: files[0], Deadline: files[1], Groups: rpcservice.Groups{Parent: files[2], EL: files[3], CL: files[4], Base: files[5], Probe: files[6], Controller: files[8], Front: files[9]}, Control: files[7], Entry: files[11]}
	l := command(c, files[10])
	cmd := l.Cmd
	if cmd.Path != "/proc/self/fd/14" || !reflect.DeepEqual(cmd.Args, []string{"rpc-native-init"}) || !reflect.DeepEqual(cmd.ExtraFiles, files) {
		t.Fatal("mutable path/arguments or descriptor order changed")
	}
	if !reflect.DeepEqual(cmd.Env, []string{"PATH=/usr/bin:/bin", "LANG=C.UTF-8"}) || cmd.Stdin != nil || cmd.Stdout != nil || cmd.Stderr != nil {
		t.Fatal("ambient input or output channel")
	}
	a := cmd.SysProcAttr
	if a.Cloneflags != syscall.CLONE_NEWNS|syscall.CLONE_NEWPID|syscall.CLONE_NEWNET|syscall.CLONE_NEWIPC|syscall.CLONE_NEWUTS || !a.UseCgroupFD || a.CgroupFD != int(c.Control.Fd()) || a.Chroot != "" || a.Pdeathsig != 0 {
		t.Fatal("namespace/cgroup launch changed")
	}
	if l.Capabilities.Entry != c.Entry || l.NamespaceRoot != files[10] {
		t.Fatal("capabilities not retained")
	}
}

func TestRPCMonitorCommandRejectsUnpreparedRootBeforeTransfer(t *testing.T) {
	p := &Prepared{}
	if _, err := p.Command(nil); err == nil || p.taken {
		t.Fatal("missing root accepted or preparation consumed")
	}
	f, err := os.Open(claimTempDir(t))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err = p.Command(f); err == nil || p.taken {
		t.Fatal("writable root accepted or preparation consumed")
	}
}
