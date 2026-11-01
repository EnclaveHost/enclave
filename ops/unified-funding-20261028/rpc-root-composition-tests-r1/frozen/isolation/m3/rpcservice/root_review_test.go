//go:build linux && amd64

package rpcservice

import (
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

type stalledObservation struct {
	*fakeBackend
	entered, release chan struct{}
	once             sync.Once
}

func (f *stalledObservation) empty(r role) (bool, error) {
	if r == roleProbe {
		f.once.Do(func() { close(f.entered); <-f.release })
	}
	return f.fakeBackend.empty(r)
}
func TestCleanupCannotReleaseWhileProbeObservationUnresolved(t *testing.T) {
	f := &stalledObservation{fakeBackend: &fakeBackend{probe: probeReadyAfter(0)}, entered: make(chan struct{}), release: make(chan struct{})}
	tm := testTiming
	tm.cleanupBound = 40 * time.Millisecond
	s := newSupervisor(f, time.Now().Add(time.Second), tm)
	ch := runAsync(s)
	<-f.entered
	s.Stop()
	st := await(t, ch)
	wantFinal(t, st, OutcomeStopped, CleanupUncertain, false)
	close(f.release)
	eventually(t, "driver drains", func() bool { return f.allEmpty() })
	if s.State() != st {
		t.Fatal("late completion changed terminal outcome")
	}
	if strings.Contains(st.Reason, "still populated") {
		t.Fatal("test must catch in-flight observation even when groups are empty")
	}
}

type stalledKill struct {
	*fakeBackend
	release chan struct{}
	once    sync.Once
}

func (f *stalledKill) kill(r role) error {
	if r == roleEL {
		f.once.Do(func() { <-f.release })
	}
	return f.fakeBackend.kill(r)
}
func TestCleanupCallerBoundIncludesStalledKernelOperation(t *testing.T) {
	f := &stalledKill{fakeBackend: &fakeBackend{probe: probeReadyAfter(0)}, release: make(chan struct{})}
	tm := testTiming
	tm.cleanupBound = 40 * time.Millisecond
	s := newSupervisor(f, time.Now().Add(time.Second), tm)
	ch := runAsync(s)
	eventually(t, "clients", func() bool { return s.State().ClientsStarted })
	s.Stop()
	st := await(t, ch)
	wantFinal(t, st, OutcomeStopped, CleanupUncertain, true)
	close(f.release)
	eventually(t, "late cleanup", func() bool { return f.allEmpty() })
}

func TestLinuxBackendRejectsOrdinaryDirectory(t *testing.T) {
	f, err := os.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err = cgroupDir(f); err == nil {
		t.Fatal("ordinary directory accepted as kernel cgroup")
	}
}
func TestRoleCommandDropsPrivilegesAndHasNoFDTransport(t *testing.T) {
	for _, r := range allRoles {
		c := roleCommand(r, 23)
		a := c.SysProcAttr
		if a == nil || !a.UseCgroupFD || a.CgroupFD != 23 || a.Pdeathsig != syscall.SIGKILL || a.Credential == nil {
			t.Fatal("missing creation-time confinement")
		}
		wantUID := uint32(2101 + r)
		if r == roleFront {
			wantUID = 1053577
		}
		if a.Credential.Uid != wantUID || a.Credential.Gid != a.Credential.Uid || len(a.Credential.Groups) != 0 || a.Credential.NoSetGroups || len(a.AmbientCaps) != 0 {
			t.Fatal("role privilege reduction changed")
		}
		if len(c.ExtraFiles) != 0 || c.Stdin != nil || c.Stdout != nil || c.Stderr != nil {
			t.Fatal("unexpected inherited descriptors or pipes")
		}
	}
}
func TestInheritedRestrictionsRefuseMissingWeakOrDuplicate(t *testing.T) {
	good := "NoNewPrivs:\t1\nCapAmb:\t0000000000000000\nCapInh:\t0000000000000000\n"
	if !inheritedRestrictions(good) {
		t.Fatal("valid inherited restrictions refused")
	}
	for _, bad := range []string{"", strings.Replace(good, "NoNewPrivs:\t1", "NoNewPrivs:\t0", 1), strings.Replace(good, "CapAmb:\t0000000000000000", "CapAmb:\t0000000000000001", 1), good + "NoNewPrivs:\t1\n"} {
		if inheritedRestrictions(bad) {
			t.Fatal("unsafe inherited restrictions accepted")
		}
	}
}
