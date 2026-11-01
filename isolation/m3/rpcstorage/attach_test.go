//go:build linux && amd64

package rpcstorage

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// These tests run the real qemu-nbd TLS server on private loopback. They prove
// the guest negotiation and transmission path, not kernel NBD attachment or
// mounting, which require the measured guest kernel and are qualified there.

type nbdPKI struct {
	ca     *x509.Certificate
	caKey  *ecdsa.PrivateKey
	client tls.Certificate
}

func issue(t *testing.T, ca *x509.Certificate, caKey *ecdsa.PrivateKey, cn string, server bool) (*x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serial, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
	tpl := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: cn}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature}
	if ca == nil {
		tpl.IsCA, tpl.BasicConstraintsValid, tpl.KeyUsage = true, true, x509.KeyUsageCertSign|x509.KeyUsageDigitalSignature
	} else if server {
		tpl.ExtKeyUsage, tpl.DNSNames = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, []string{cn}
	} else {
		tpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
	}
	parent, signer := tpl, key
	if ca != nil {
		parent, signer = ca, caKey
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, parent, &key.PublicKey, signer)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return cert, key
}

func writePEM(t *testing.T, path, kind string, der []byte) {
	t.Helper()
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
}

func newPKI(t *testing.T, dir, serverName string) nbdPKI {
	ca, caKey := issue(t, nil, nil, "rpc-test-owner-ca", false)
	server, serverKey := issue(t, ca, caKey, serverName, true)
	client, clientKey := issue(t, ca, caKey, "rpc-client-test-l1", false)
	writePEM(t, filepath.Join(dir, "ca-cert.pem"), "CERTIFICATE", ca.Raw)
	writePEM(t, filepath.Join(dir, "server-cert.pem"), "CERTIFICATE", server.Raw)
	sk, _ := x509.MarshalPKCS8PrivateKey(serverKey)
	writePEM(t, filepath.Join(dir, "server-key.pem"), "PRIVATE KEY", sk)
	return nbdPKI{ca: ca, caKey: caKey, client: tls.Certificate{Certificate: [][]byte{client.Raw}, PrivateKey: clientKey}}
}

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// startQemuNBD serves one raw image; extra args select read-only/plain modes.
func startQemuNBD(t *testing.T, image, tlsDir, export, identity string, port int, extra ...string) {
	t.Helper()
	args := []string{"--bind", "127.0.0.1", "--port", strconv.Itoa(port), "--export-name", export, "--format", "raw", "--persistent", "--shared=1"}
	if tlsDir != "" {
		args = append(args, "--object", "tls-creds-x509,id=tls0,endpoint=server,dir="+tlsDir+",verify-peer=on",
			"--object", "authz-simple,id=auth0,identity="+identity, "--tls-creds", "tls0", "--tls-authz", "auth0")
	}
	args = append(append(args, extra...), image)
	cmd := exec.Command("/usr/sbin/qemu-nbd", args...)
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	for until := time.Now().Add(5 * time.Second); time.Now().Before(until); time.Sleep(20 * time.Millisecond) {
		if c, err := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(port)); err == nil {
			c.Close()
			return
		}
	}
	t.Fatal("qemu-nbd did not listen")
}

func nbdCommand(t *testing.T, c io.ReadWriter, typ, flags uint16, handle, offset uint64, data []byte, length uint32) []byte {
	t.Helper()
	b := binary.BigEndian.AppendUint32(nil, 0x25609513)
	b = binary.BigEndian.AppendUint16(b, flags)
	b = binary.BigEndian.AppendUint16(b, typ)
	b = binary.BigEndian.AppendUint64(b, handle)
	b = binary.BigEndian.AppendUint64(b, offset)
	b = binary.BigEndian.AppendUint32(b, length)
	if err := writeAll(c, append(b, data...)); err != nil {
		t.Fatal(err)
	}
	var reply [16]byte
	if _, err := io.ReadFull(c, reply[:]); err != nil {
		t.Fatal(err)
	}
	if binary.BigEndian.Uint32(reply[0:]) != 0x67446698 || binary.BigEndian.Uint32(reply[4:]) != 0 || binary.BigEndian.Uint64(reply[8:]) != handle {
		t.Fatalf("NBD command %d failed: %x", typ, reply)
	}
	if typ != 0 {
		return nil
	}
	out := make([]byte, length)
	if _, err := io.ReadFull(c, out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestNegotiateExportAgainstQemuNBD(t *testing.T) {
	const size = 64 << 20
	const export = "rpc-test-l1"
	const serverName = "rpc-storage-test-l1"
	for _, mode := range []string{"valid", "wrong-export", "wrong-server-name", "unauthorized-client", "foreign-ca", "read-only", "wrong-size", "plaintext-server", "stalled-server"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			tlsDir := filepath.Join(dir, "tls")
			os.Mkdir(tlsDir, 0700)
			pki := newPKI(t, tlsDir, serverName)
			image := filepath.Join(dir, "state.raw")
			if err := os.WriteFile(image, nil, 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.Truncate(image, size); err != nil {
				t.Fatal(err)
			}
			port := freePort(t)
			identity := "CN=rpc-client-test-l1"
			switch mode {
			case "unauthorized-client":
				identity = "CN=rpc-client-other-l1"
			}
			var extra []string
			if mode == "read-only" {
				extra = []string{"--read-only"}
			}
			switch mode {
			case "plaintext-server":
				startQemuNBD(t, image, "", export, "", port)
			case "stalled-server":
				l, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
				if err != nil {
					t.Fatal(err)
				}
				defer l.Close()
				go func() {
					c, err := l.Accept()
					if err == nil {
						defer c.Close()
						time.Sleep(3 * time.Second)
					}
				}()
			default:
				startQemuNBD(t, image, tlsDir, export, identity, port, extra...)
			}
			ep := DataEndpoint{Role: "l1", Address: netip.AddrPortFrom(netip.MustParseAddr("127.0.0.1"), uint16(port)), ServerName: serverName, ExportName: export, Bytes: size, FilesystemUUID: [16]byte{1}, ServerCA: pki.ca}
			switch mode {
			case "wrong-export":
				ep.ExportName = "rpc-other-l1"
			case "wrong-server-name":
				ep.ServerName = "rpc-storage-other-l1"
			case "foreign-ca":
				ep.ServerCA, _ = issue(t, nil, nil, "foreign-ca", false)
			case "wrong-size":
				ep.Bytes = size - nbdBlockSize
			}
			raw, err := net.Dial("tcp", ep.Address.String())
			if err != nil {
				t.Fatal(err)
			}
			defer raw.Close()
			started := time.Now()
			n, err := negotiateExport(raw, ep, pki.client, time.Now().Add(time.Second))
			if mode != "valid" {
				if err == nil {
					t.Fatal("accepted", mode)
				}
				if time.Since(started) > 1500*time.Millisecond {
					t.Fatal("refusal not bounded by deadline", time.Since(started))
				}
				t.Log(mode, "refused:", err)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if n.flags&nbdFlagReadOnly != 0 || n.flags&nbdFlagFlush == 0 || n.flags&nbdFlagFUA == 0 {
				t.Fatalf("unexpected flags %#x", n.flags)
			}
			// Transmission phase over the same TLS stream: FUA write, flush, readback.
			n.conn.SetDeadline(time.Now().Add(3 * time.Second))
			block := []byte(strings.Repeat("enclave-rpc-nbd!", nbdBlockSize/16))
			nbdCommand(t, n.conn, 1, 1, 7, 1<<20, block, uint32(len(block)))
			nbdCommand(t, n.conn, 3, 0, 8, 0, nil, 0)
			if got := nbdCommand(t, n.conn, 0, 0, 9, 1<<20, nil, uint32(len(block))); string(got) != string(block) {
				t.Fatal("readback differs")
			}
			// NBD_CMD_DISC has no reply; send it raw and expect clean EOF.
			disc := binary.BigEndian.AppendUint32(nil, 0x25609513)
			disc = binary.BigEndian.AppendUint32(disc, 2)
			disc = append(disc, make([]byte, 20)...)
			if err = writeAll(n.conn, disc); err != nil {
				t.Fatal(err)
			}
			if _, err = n.conn.Read(make([]byte, 1)); err != io.EOF {
				t.Fatal("server did not close after disconnect", err)
			}
		})
	}
}

func TestExt4IdentityBinding(t *testing.T) {
	uuid := [16]byte{0xa2, 0xf2, 0xa8, 0xb5, 6, 0xac, 0x46, 0x12, 0x95, 0xa0, 0xf4, 0x8a, 0, 0xa7, 0xf6, 0xe0}
	build := func(magic uint16, id [16]byte, blocks uint64, logBlock uint32, wide bool) *os.File {
		sb := make([]byte, 2048)
		s := sb[1024:]
		binary.LittleEndian.PutUint32(s[0x04:], uint32(blocks))
		binary.LittleEndian.PutUint32(s[0x18:], logBlock)
		binary.LittleEndian.PutUint16(s[0x38:], magic)
		if wide {
			binary.LittleEndian.PutUint32(s[0x60:], 0x80)
			binary.LittleEndian.PutUint32(s[0x150:], uint32(blocks>>32))
		}
		copy(s[0x68:], id[:])
		f, err := os.CreateTemp(t.TempDir(), "sb")
		if err != nil {
			t.Fatal(err)
		}
		f.Write(sb)
		t.Cleanup(func() { f.Close() })
		return f
	}
	ep := DataEndpoint{Bytes: 4_000_000_000_000, FilesystemUUID: uuid}
	cases := []struct {
		name string
		f    *os.File
		ok   bool
	}{
		{"exact", build(0xef53, uuid, ep.Bytes/4096, 2, true), true},
		{"wrong-magic", build(0xef52, uuid, 1000, 2, false), false},
		{"wrong-uuid", build(0xef53, [16]byte{1}, 1000, 2, false), false},
		{"exceeds-export", build(0xef53, uuid, ep.Bytes/4096+1, 2, true), false},
		{"high-bits-ignored-without-64bit", build(0xef53, uuid, 1<<32|5, 2, false), true},
		{"zero-blocks", build(0xef53, uuid, 0, 2, false), false},
		{"bad-block-size", build(0xef53, uuid, 1000, 9, false), false},
	}
	for _, c := range cases {
		err := checkExt4Identity(c.f, ep)
		if (err == nil) != c.ok {
			t.Fatal(c.name, err)
		}
	}
}

func TestGrantRootsRefusesBeforeAuthorityAndIsOneShot(t *testing.T) {
	f, err := brokerFixtureStart(t, "valid", 0)
	if err != nil {
		t.Fatal(err)
	}
	root, err := os.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if err = f.session.GrantRoots(root, root); err == nil || !strings.Contains(err.Error(), "bound export required") {
		t.Fatal("granted without acknowledged reserved bound export", err)
	}
	select {
	case <-f.session.ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("failed grant did not close the session")
	}
	if err = f.session.GrantRoots(root, root); err == nil || !strings.Contains(err.Error(), "already consumed") {
		t.Fatal("grant replay", err)
	}

	g, err := brokerFixtureStart(t, "valid", 0)
	if err != nil {
		t.Fatal(err)
	}
	g.session.mu.Lock()
	g.session.accepted, g.session.reserved, g.session.exportBound = true, true, true
	g.session.mu.Unlock()
	// A temporary directory is not a held ext4 filesystem root (inode 2).
	if err = g.session.GrantRoots(root, root); err == nil || !strings.Contains(err.Error(), "ext4 filesystem roots") {
		t.Fatal("non-root directory granted", err)
	}
	if err = g.session.GrantRoots(root, root); err == nil || !strings.Contains(err.Error(), "already consumed") {
		t.Fatal("grant replay after refusal", err)
	}
}
