// Disposable KVM cross-language/credential test. No GPU or production app.
package main

import (
	"bufio"
	"bytes"
	"context"
	"enclave.host/isolation/m2/shieldbridge"
	"enclave.host/isolation/m3/desktopworker"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

const socket = "/run/native-worker/gpu0"

func must(e error) {
	if e != nil {
		panic(e)
	}
}
func require(b bool, s string) {
	if !b {
		panic(s)
	}
}
func child(mode string) {
	c, e := net.Dial("unix", socket)
	must(e)
	defer c.Close()
	must(c.SetDeadline(time.Now().Add(10 * time.Second)))
	raw, e := c.(*net.UnixConn).SyscallConn()
	must(e)
	var cred *syscall.Ucred
	var inner error
	must(raw.Control(func(fd uintptr) {
		cred, inner = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}))
	must(inner)
	require(cred.Uid == 0, "server peer root")
	if mode == "denied" {
		b := make([]byte, 1)
		n, e := c.Read(b)
		require(n == 0 && e == io.EOF, "impostor rejected")
		return
	}
	require(os.Getuid() == 1001, "authorized role")
	payload := bytes.Repeat([]byte{0, 1, 255, 17, 42}, 8192)
	_, e = c.Write(payload)
	must(e)
	got := make([]byte, len(payload))
	_, e = io.ReadFull(c, got)
	must(e)
	require(bytes.Equal(payload, got), "opaque bytes preserved")
	if mode == "hold" {
		fmt.Println("STREAM_READY")
		b := make([]byte, 1)
		n, e := c.Read(b)
		require(n == 0 && e == io.EOF, "revocation closes client")
	}
}
func command(uid, gid uint32, mode string) *exec.Cmd {
	c := exec.Command("/lease-probe", mode)
	c.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uid, Gid: gid, Groups: []uint32{}}}
	c.Stderr = os.Stderr
	return c
}
func main() {
	var u syscall.Utsname
	must(syscall.Uname(&u))
	var release []byte
	for _, v := range u.Release {
		if v == 0 {
			break
		}
		release = append(release, byte(v))
	}
	require(string(release) == "6.6.87.2-enclave-kvm-box", "exact test kernel")
	if len(os.Args) == 2 && os.Args[1] == "--foreign" {
		require(os.Getuid() == 0 && os.Getppid() == 1, "foreign guest root")
		b := desktopworker.Binding{Boot: strings.Repeat("4", 32), Claim: strings.Repeat("5", 64), AppID: strings.Repeat("1", 64), ProfileSHA: strings.Repeat("2", 64), GPUMilli: 500}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		l, e := desktopworker.AcquireHost(ctx, b)
		if l != nil {
			l.Close()
		}
		require(e != nil, "foreign guest refused")
		fmt.Println("LEASE_KVM_FOREIGN_RESULT={\"passed\":true}")
		return
	}
	if len(os.Args) == 2 {
		child(os.Args[1])
		return
	}
	require(os.Getuid() == 0 && os.Getppid() == 1, "root guest init child")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	binding := desktopworker.Binding{Boot: strings.Repeat("4", 32), Claim: strings.Repeat("5", 64), AppID: strings.Repeat("1", 64), ProfileSHA: strings.Repeat("2", 64), GPUMilli: 500}
	l, e := desktopworker.AcquireHost(ctx, binding)
	must(e)
	defer l.Close()
	must(os.MkdirAll("/run/native-worker", 0755))
	ready := make(chan error, 1)
	done := make(chan error, 1)
	bridge := shieldbridge.Bridge{Path: socket, UID: 1001, RootOwnedSocket: true, Limit: 8, KeepIdleConnections: true, Dial: func(ctx context.Context) (net.Conn, error) {
		c, e := l.Open(ctx)
		if e != nil {
			fmt.Printf("LEASE_OPEN_FAILURE=%v\n", e)
		}
		return c, e
	}}
	go func() { done <- bridge.Serve(ctx, ready) }()
	must(<-ready)
	go func() { <-l.Done(); cancel() }()
	must(command(0, 0, "denied").Run())
	must(command(1000, 1001, "denied").Run())
	for i := 0; i < 32; i++ {
		must(command(1001, 1001, "echo").Run())
	}
	hold := command(1001, 1001, "hold")
	out, e := hold.StdoutPipe()
	must(e)
	must(hold.Start())
	line, e := bufio.NewReader(out).ReadString('\n')
	must(e)
	require(line == "STREAM_READY\n", "held stream ready")
	fmt.Println("LEASE_KVM_REQUEST_REVOKE")
	select {
	case <-l.Done():
	case <-time.After(10 * time.Second):
		panic("lease not revoked")
	}
	must(hold.Wait())
	select {
	case e := <-done:
		must(e)
	case <-time.After(5 * time.Second):
		panic("broker did not stop")
	}
	_, e = l.Open(context.Background())
	require(e != nil, "closed lease cannot reopen")
	result, _ := json.Marshal(map[string]any{"passed": true, "fixedHostVsock": true, "rootAndGroupImpostorsDenied": true, "authorizedUID": 1001, "opaqueBytes": 40960, "sequentialClients": 32, "revocationClosedClient": true, "productionAdmission": false, "gpuExecuted": false})
	fmt.Printf("LEASE_KVM_RESULT=%s\n", result)
}
