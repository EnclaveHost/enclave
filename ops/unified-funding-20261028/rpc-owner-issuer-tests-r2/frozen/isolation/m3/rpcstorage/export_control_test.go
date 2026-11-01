//go:build linux && amd64

package rpcstorage

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/bootstrap"
)

type fixtureRoundTrip func(*http.Request) (*http.Response, error)

func (f fixtureRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Real Reader.Authorize and signatures, with explicitly mocked quorum replies.
// No private authorization fields are constructed by these transport tests.
func exportAuthorization(t *testing.T, request Request, binding *bootstrap.RPCExportBinding) (*bootstrap.Authorization, []byte) {
	auth, proof, _ := exportAuthorizationKeys(t, request, binding)
	return auth, proof
}
func exportAuthorizationKeys(t *testing.T, request Request, binding *bootstrap.RPCExportBinding) (*bootstrap.Authorization, []byte, [2]ed25519.PrivateKey) {
	t.Helper()
	raw, e := os.ReadFile("../../m2/bootstrap/testdata/vectors.json")
	if e != nil {
		t.Fatal(e)
	}
	var v struct{ ID, Ledger, Manifest, Row, Schema, SchemaSelector string }
	if e = json.Unmarshal(raw, &v); e != nil {
		t.Fatal(e)
	}
	var manifest bootstrap.Manifest
	json.Unmarshal([]byte(v.Manifest), &manifest)
	manifest.AppID = request.AppID
	manifest.Deployment = request.Deployment
	policy := bootstrap.RPCStorage{Schema: "enclave-rpc-storage-authorities/1"}
	var keys [2]ed25519.PrivateKey
	for i, a := range []*bootstrap.RPCStorageAuthority{&policy.L1, &policy.Base} {
		pub, key, e := ed25519.GenerateKey(rand.Reader)
		if e != nil {
			t.Fatal(e)
		}
		keys[i] = key
		a.PublicKey = hex.EncodeToString(pub)
		a.VolumeID = []string{request.L1Volume, request.BaseVolume}[i]
	}
	manifest.RPCStorage = &policy
	packageBytes, _ := json.Marshal(manifest)
	old := sha256.Sum256([]byte(v.Manifest))
	next := sha256.Sum256(packageBytes)
	from, to := hex.EncodeToString([]byte(hex.EncodeToString(old[:]))), hex.EncodeToString([]byte(hex.EncodeToString(next[:])))
	if !strings.Contains(v.Row, from) {
		t.Fatal("fixture commitment missing")
	}
	row := strings.Replace(v.Row, from, to, 1)
	row = strings.Replace(row, strings.TrimPrefix(v.ID, "0x"), strings.TrimPrefix(request.Deployment, "0x"), 1)
	transport := fixtureRoundTrip(func(req *http.Request) (*http.Response, error) {
		var call struct {
			Method string
			Params []json.RawMessage
		}
		if e := json.NewDecoder(req.Body).Decode(&call); e != nil {
			return nil, e
		}
		var result any
		switch call.Method {
		case "eth_chainId":
			result = "0x2105"
		case "eth_blockNumber":
			result = "0x64"
		case "eth_getBlockByNumber":
			var tag string
			json.Unmarshal(call.Params[0], &tag)
			result = map[string]string{"number": tag, "hash": "0x" + strings.Repeat("ab", 32), "timestamp": fmt.Sprintf("0x%x", time.Now().Unix())}
		case "eth_call":
			var data map[string]string
			json.Unmarshal(call.Params[0], &data)
			if data["data"] == v.SchemaSelector {
				result = v.Schema
			} else {
				result = row
			}
		default:
			return nil, fmt.Errorf("unexpected fixture method %s", call.Method)
		}
		encoded, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "result": result})
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(encoded)), Header: make(http.Header)}, nil
	})
	reader, e := bootstrap.NewReader(bootstrap.Config{ChainID: 8453, Ledger: v.Ledger, Confirmations: 2, MaxAge: 90 * time.Second,
		RPCs: []string{"https://one.rpc.example", "https://two.rpc.example", "https://three.rpc.example"}, Client: &http.Client{Transport: transport}})
	if e != nil {
		t.Fatal(e)
	}
	var id [32]byte
	decoded, _ := hex.DecodeString(request.Deployment[2:])
	copy(id[:], decoded)
	var loaded bootstrap.Identity
	loaded.AppID = contract.AppID(rpcBundle(t))
	decoded, _ = hex.DecodeString(manifest.RuntimeID)
	copy(loaded.RuntimeID[:], decoded)
	auth, e := reader.Authorize(context.Background(), id, packageBytes, loaded)
	if e != nil {
		t.Fatal(e)
	}
	l, b := strings.Repeat("d", 64), strings.Repeat("e", 64)
	proof := bootstrap.RPCStorageSignatures{Schema: "enclave-rpc-storage-consent/1", Export: binding}
	payloads, e := auth.RPCStorageSigningPayloads(rpcBundle(t), request, l, b)
	if binding != nil {
		proof.Schema = "enclave-rpc-storage-consent/2"
		payloads, e = auth.RPCExportSigningPayloads(rpcBundle(t), request, l, b, *binding)
	}
	if e != nil {
		t.Fatal(e)
	}
	proof.L1 = bootstrap.RPCStorageSignature{WriterEpoch: l, Signature: hex.EncodeToString(ed25519.Sign(keys[0], payloads[0]))}
	proof.Base = bootstrap.RPCStorageSignature{WriterEpoch: b, Signature: hex.EncodeToString(ed25519.Sign(keys[1], payloads[1]))}
	encoded, _ := json.Marshal(proof)
	return auth, encoded, keys
}

func persistentFixture(t *testing.T) *os.File {
	t.Helper()
	root := os.Getenv("RPC_TEST_PERSISTENT_DIR")
	if root == "" {
		t.Fatal("disposable ext4 root required")
	}
	path, e := os.MkdirTemp(root, "export-journal-")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { os.RemoveAll(path) })
	d, e := os.Open(path)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

func testCredentials(t *testing.T) (string, []byte, tls.Certificate) {
	t.Helper()
	root, e := os.MkdirTemp(os.Getenv("RPC_TEST_PERSISTENT_DIR"), "control-pki-")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	pub, priv, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "inert fixture CA"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, e := x509.CreateCertificate(rand.Reader, ca, ca, pub, priv)
	if e != nil {
		t.Fatal(e)
	}
	write := func(name, kind string, b []byte) {
		if e := os.WriteFile(filepath.Join(root, name), pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: b}), 0600); e != nil {
			t.Fatal(e)
		}
	}
	write("ca-cert.pem", "CERTIFICATE", caDER)
	var serverDER []byte
	var client tls.Certificate
	for i, name := range []string{"server", "client"} {
		pub, key, e := ed25519.GenerateKey(rand.Reader)
		if e != nil {
			t.Fatal(e)
		}
		cert := &x509.Certificate{SerialNumber: big.NewInt(int64(i + 2)), Subject: pkix.Name{CommonName: "export.control.test"}, DNSNames: []string{"export.control.test"}, NotBefore: ca.NotBefore, NotAfter: ca.NotAfter, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
		if name == "client" {
			cert.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
		}
		der, e := x509.CreateCertificate(rand.Reader, cert, ca, pub, priv)
		if e != nil {
			t.Fatal(e)
		}
		keyDER, e := x509.MarshalPKCS8PrivateKey(key)
		if e != nil {
			t.Fatal(e)
		}
		write(name+"-cert.pem", "CERTIFICATE", der)
		write(name+"-key.pem", "PRIVATE KEY", keyDER)
		if name == "server" {
			serverDER = der
		} else {
			client = tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
		}
	}
	return root, serverDER, client
}
func sumHex(raw []byte) string { h := sha256.Sum256(raw); return hex.EncodeToString(h[:]) }
func bindFixture(port int, server []byte, client tls.Certificate) bootstrap.RPCExportBinding {
	return bootstrap.RPCExportBinding{Host: "127.0.0.1", Port: uint16(port), ServerName: "export.control.test", ServerCertificateSHA256: sumHex(server), ClientCertificateSHA256: sumHex(client.Certificate[0]), ContractSHA256: strings.Repeat("3", 64)}
}
func awaitFile(t *testing.T, path string) []byte {
	t.Helper()
	until := time.Now().Add(2 * time.Second)
	for time.Now().Before(until) {
		if raw, e := os.ReadFile(path); e == nil {
			return raw
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("fixture file did not arrive", path)
	return nil
}

func TestExportControlRealPythonGuardianStopsOnMonitorDeath(t *testing.T) {
	f, e := brokerFixtureStart(t, "valid", 0)
	if e != nil {
		t.Fatal(e)
	}
	root, server, client := testCredentials(t)
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	binding := bindFixture(port, server, client)
	auth, proof := exportAuthorization(t, f.session.Request(), &binding)
	journal := persistentFixture(t)
	intent, e := f.session.AuthenticateAndReserve(auth, rpcBundle(t), proof, journal)
	if e != nil {
		t.Fatal(e)
	}
	defer func() {
		for _, file := range intent.records {
			file.Close()
		}
	}()
	for _, volume := range []string{f.session.request.L1Volume, f.session.request.BaseVolume} {
		raw, e := os.ReadFile(filepath.Join(journal.Name(), volume))
		if e != nil {
			t.Fatal(e)
		}
		var record struct {
			Schema string
			Export bootstrap.RPCExportBinding
		}
		json.Unmarshal(raw, &record)
		if record.Schema != "enclave-rpc-storage-consumed/2" || record.Export != binding {
			t.Fatal("binding not persisted before dial")
		}
	}
	request, _ := json.Marshal(f.session.Request())
	config := map[string]any{"control": map[string]any{"schema": "enclave-rpc-export-control/1", "host": binding.Host, "port": binding.Port, "tls": root, "clientCertificateSha256": binding.ClientCertificateSHA256, "requestSha256": sumHex(request)}, "contract": binding.ContractSHA256, "deadline": float64(f.session.request.Origin)/1e9 + 5}
	raw, _ := json.Marshal(config)
	os.WriteFile(filepath.Join(root, "actor.json"), raw, 0600)
	actorPath := os.Getenv("RPC_CONTROL_ACTOR")
	if actorPath == "" {
		t.Fatal("pinned maintained actor path required")
	}
	actor := exec.Command("/usr/bin/python3", "-B", actorPath, root)
	var output bytes.Buffer
	actor.Stdout = &output
	actor.Stderr = &output
	if e = actor.Start(); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { actor.Process.Kill(); actor.Wait() })
	awaitFile(t, filepath.Join(root, "listening"))
	control, e := f.session.ConnectExportControl(server, client)
	if e != nil {
		t.Fatal(e, output.String())
	}
	if control.RequestSHA256() != sumHex(request) || control.ContractSHA256() != binding.ContractSHA256 {
		t.Fatal("wrong acknowledgement")
	}
	var rows []struct {
		PID   int
		Start string
	}
	if e = json.Unmarshal(awaitFile(t, filepath.Join(root, "workers.json")), &rows); e != nil || len(rows) != 2 {
		t.Fatal(e)
	}
	var held []brokerPoll
	for _, row := range rows {
		fd, _, eno := syscall.Syscall(434, uintptr(row.PID), 0, 0)
		if eno != 0 {
			t.Fatal(eno)
		}
		defer syscall.Close(int(fd))
		stat, e := os.ReadFile(fmt.Sprintf("/proc/%d/stat", row.PID))
		if e != nil {
			t.Fatal(e)
		}
		fields := strings.Fields(string(stat)[strings.LastIndex(string(stat), ")")+2:])
		if fields[19] != row.Start {
			t.Fatal("worker reused")
		}
		held = append(held, brokerPoll{int32(fd), 1, 0})
	}
	if event, e := pollBroker(held, 0); e != nil || event {
		t.Fatal("worker dead before loss", e)
	}
	start := time.Now()
	if e = f.process.Process.Kill(); e != nil {
		t.Fatal(e)
	}
	select {
	case <-control.Context().Done():
	case <-time.After(time.Second):
		t.Fatal("monitor loss not propagated")
	}
	if e = actor.Wait(); e != nil {
		t.Fatal(e, output.String())
	}
	for _, row := range held {
		if event, e := pollBroker([]brokerPoll{row}, 0); e != nil || !event {
			t.Fatal("held worker survives", e)
		}
	}
	if time.Since(start) > 1500*time.Millisecond {
		t.Fatal("control loss failed bounded death")
	}
	var result map[string]any
	json.Unmarshal(awaitFile(t, filepath.Join(root, "result.json")), &result)
	if result["reason"] != "app-control-lost" || result["released"] != true || result["ready"] != false || result["writersFenced"] != false {
		t.Fatal(result)
	}
	if _, e = f.session.ConnectExportControl(server, client); e == nil || !strings.Contains(e.Error(), "consumed") {
		t.Fatal("reconnect permitted", e)
	}
	for _, volume := range []string{f.session.request.L1Volume, f.session.request.BaseVolume} {
		if _, e = os.Stat(filepath.Join(journal.Name(), volume)); e != nil {
			t.Fatal("intent released")
		}
	}
	t.Logf("actual Go authorization/journal/TLS -> Python guard: exact two worker pidfds dead in %s", time.Since(start))
}

func TestExportControlRejectsBeforeDialAndConsumesFailure(t *testing.T) {
	for _, mode := range []string{"unauthenticated", "legacy", "server-bytes", "client-bytes"} {
		t.Run(mode, func(t *testing.T) {
			f, e := brokerFixtureStart(t, "valid", 0)
			if e != nil {
				t.Fatal(e)
			}
			_, server, client := testCredentials(t)
			listener, e := net.Listen("tcp", "127.0.0.1:0")
			if e != nil {
				t.Fatal(e)
			}
			defer listener.Close()
			binding := bindFixture(listener.Addr().(*net.TCPAddr).Port, server, client)
			if mode != "unauthenticated" {
				var b *bootstrap.RPCExportBinding = &binding
				if mode == "legacy" {
					b = nil
				}
				auth, proof := exportAuthorization(t, f.session.Request(), b)
				intent, e := f.session.AuthenticateAndReserve(auth, rpcBundle(t), proof, persistentFixture(t))
				if e != nil {
					t.Fatal(e)
				}
				defer func() {
					for _, f := range intent.records {
						f.Close()
					}
				}()
			}
			if mode == "server-bytes" {
				server = append(append([]byte(nil), server...), 0)
			}
			if mode == "client-bytes" {
				client.Certificate[0] = append(append([]byte(nil), client.Certificate[0]...), 0)
			}
			_, e = f.session.ConnectExportControl(server, client)
			if e == nil {
				t.Fatal("unapproved transport accepted")
			}
			want := map[string]string{"unauthenticated": "reservation required", "legacy": "historical consent", "server-bytes": "server certificate differs", "client-bytes": "client certificate differs"}[mode]
			if !strings.Contains(e.Error(), want) {
				t.Fatal("wrong refusal", e)
			}
			listener.(*net.TCPListener).SetDeadline(time.Now().Add(20 * time.Millisecond))
			if conn, e := listener.Accept(); e == nil {
				conn.Close()
				t.Fatal("dialed before authentication/pin checks")
			}
			if _, e = f.session.ConnectExportControl(server, client); e == nil || !strings.Contains(e.Error(), "consumed") {
				t.Fatal("failure was retried")
			}
		})
	}
}

func TestExportControlTLSNameAcknowledgementAndOriginalDeadline(t *testing.T) {
	for _, mode := range []string{"wrong-name", "bad-ack", "silent-ack", "extra-data"} {
		t.Run(mode, func(t *testing.T) {
			remaining := time.Duration(0)
			if mode == "silent-ack" {
				remaining = 800 * time.Millisecond
			}
			f, e := brokerFixtureStart(t, "valid", remaining)
			if e != nil {
				t.Fatal(e)
			}
			root, server, client := testCredentials(t)
			cert, e := tls.LoadX509KeyPair(filepath.Join(root, "server-cert.pem"), filepath.Join(root, "server-key.pem"))
			if e != nil {
				t.Fatal(e)
			}
			ca, e := os.ReadFile(filepath.Join(root, "ca-cert.pem"))
			if e != nil {
				t.Fatal(e)
			}
			roots := x509.NewCertPool()
			if !roots.AppendCertsFromPEM(ca) {
				t.Fatal("fixture CA")
			}
			listener, e := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{MinVersion: tls.VersionTLS13, MaxVersion: tls.VersionTLS13, Certificates: []tls.Certificate{cert}, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: roots})
			if e != nil {
				t.Fatal(e)
			}
			defer listener.Close()
			binding := bindFixture(listener.Addr().(*net.TCPAddr).Port, server, client)
			if mode == "wrong-name" {
				binding.ServerName = "wrong.control.test"
			}
			auth, proof := exportAuthorization(t, f.session.Request(), &binding)
			intent, e := f.session.AuthenticateAndReserve(auth, rpcBundle(t), proof, persistentFixture(t))
			if e != nil {
				t.Fatal(e)
			}
			defer func() {
				for _, f := range intent.records {
					f.Close()
				}
			}()
			done := make(chan error, 1)
			go func() {
				c, e := listener.Accept()
				if e != nil {
					done <- e
					return
				}
				defer c.Close()
				c.SetDeadline(time.Now().Add(2 * time.Second))
				if e = c.(*tls.Conn).Handshake(); e != nil {
					if mode == "wrong-name" {
						done <- nil
					} else {
						done <- e
					}
					return
				}
				frame := make([]byte, len(exportHello)+64)
				if _, e = io.ReadFull(c, frame); e != nil {
					done <- e
					return
				}
				request, _ := json.Marshal(f.session.Request())
				h := sha256.Sum256(request)
				contract, _ := hex.DecodeString(binding.ContractSHA256)
				expected := append([]byte(exportHello), h[:]...)
				expected = append(expected, contract...)
				if !bytes.Equal(frame, expected) {
					done <- fmt.Errorf("bad frame")
					return
				}
				if mode != "silent-ack" {
					h := sha256.Sum256(frame)
					reply := append([]byte(exportBound), h[:]...)
					if mode == "bad-ack" {
						reply[len(reply)-1] ^= 1
					}
					if mode == "extra-data" {
						reply = append(reply, 1)
					}
					if _, e = c.Write(reply); e != nil {
						done <- e
						return
					}
				}
				var one [1]byte
				_, e = c.Read(one[:])
				if e == nil {
					done <- fmt.Errorf("unexpected client retry")
				} else {
					done <- nil
				}
			}()
			began := time.Now()
			control, e := f.session.ConnectExportControl(server, client)
			if mode == "extra-data" && e == nil {
				select {
				case <-control.Context().Done():
				case <-time.After(time.Second):
					t.Fatal("extra server bytes ignored")
				}
			} else if e == nil {
				t.Fatal("bad connection succeeded", mode)
			}
			if mode == "wrong-name" && !strings.Contains(e.Error(), "certificate") {
				t.Fatal("TLS name check was not exercised", e)
			}
			if mode == "bad-ack" && !strings.Contains(e.Error(), "acknowledgement differs") {
				t.Fatal("wrong refusal", e)
			}
			if mode == "silent-ack" && time.Since(began) > time.Second {
				t.Fatal("original deadline replaced by handshake timeout")
			}
			if e = <-done; e != nil {
				t.Fatal(e)
			}
		})
	}
}
