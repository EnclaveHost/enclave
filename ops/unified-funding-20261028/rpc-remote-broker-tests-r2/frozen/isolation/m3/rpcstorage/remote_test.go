//go:build linux && amd64

package rpcstorage

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"enclave.host/isolation/m2/bootstrap"
)

func guestReceipts(t *testing.T) *os.File {
	t.Helper()
	p, e := os.MkdirTemp("/tmp", "rpc-remote-")
	if e != nil {
		t.Fatal(e)
	}
	d, e := os.Open(p)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { d.Close(); os.RemoveAll(p) })
	return d
}
func relayPair(t *testing.T) (*net.UnixConn, *net.UnixConn) {
	t.Helper()
	dir := t.TempDir()
	l, e := net.ListenUnix("unix", &net.UnixAddr{Name: filepath.Join(dir, "relay"), Net: "unix"})
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	c, e := net.DialUnix("unix", nil, l.Addr().(*net.UnixAddr))
	if e != nil {
		t.Fatal(e)
	}
	a, e := l.AcceptUnix()
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { c.Close(); a.Close() })
	return c, a
}
func remoteIssuer(t *testing.T, s *BrokerSession, binding bootstrap.RPCExportBinding) (*bootstrap.Authorization, []byte, *os.File) {
	t.Helper()
	a, _, keys := exportAuthorizationKeys(t, s.Request(), &binding)
	journal := persistentFixture(t)
	seeds := [2][]byte{keys[0].Seed(), keys[1].Seed()}
	issuer, e := NewOwnerIssuer(journal, seeds, [2]string{s.request.L1Volume, s.request.BaseVolume}, binding, time.Now().Add(5*time.Second))
	if e != nil {
		t.Fatal(e)
	}
	proof, e := issuer.Issue(context.Background(), a, rpcBundle(t), s.Request())
	for _, seed := range seeds {
		clear(seed)
	}
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		for _, f := range issuer.intent.records {
			f.Close()
		}
		issuer.proof.Close()
	})
	// This verifies the real owner actor committed both records and its exact
	// response before exposing the proof; the guest never receives the journal.
	for _, v := range []string{s.request.L1Volume, s.request.BaseVolume} {
		if _, e = os.Stat(filepath.Join(journal.Name(), v)); e != nil {
			t.Fatal(e)
		}
	}
	req, _ := json.Marshal(s.Request())
	got, e := os.ReadFile(filepath.Join(journal.Name(), "proof-"+sumHex(req)))
	if e != nil || !bytes.Equal(got, proof) {
		t.Fatal("owner response not durable", e)
	}
	return a, proof, journal
}
func TestRemoteProofKeepsJournalAtOwnerAndGuestOnlyReceipt(t *testing.T) {
	f, e := brokerFixtureStart(t, "valid", 0)
	if e != nil {
		t.Fatal(e)
	}
	binding := bootstrap.RPCExportBinding{Host: "127.0.0.1", Port: 12345, ServerName: "storage.example", ServerCertificateSHA256: strings.Repeat("1", 64), ClientCertificateSHA256: strings.Repeat("2", 64), ContractSHA256: strings.Repeat("3", 64)}
	auth, proof, owner := remoteIssuer(t, f.session, binding)
	guest := guestReceipts(t)
	if e = f.session.AuthenticateRemoteReservation(auth, rpcBundle(t), proof, guest); e != nil {
		t.Fatal(e)
	}
	if f.session.intent != nil || f.session.remoteReceipt == nil {
		t.Fatal("guest manufactured authoritative intent")
	}
	rows, e := os.ReadDir(guest.Name())
	if e != nil || len(rows) != 1 || rows[0].Name() != "owner-response" {
		t.Fatal("guest journal contains writer authority", e)
	}
	f.session.Stop()
	if _, e = os.Stat(filepath.Join(owner.Name(), f.session.request.L1Volume)); e != nil {
		t.Fatal("owner reservation lost", e)
	}
	if e = f.session.AuthenticateRemoteReservation(auth, rpcBundle(t), proof, guest); e == nil {
		t.Fatal("session replay accepted")
	}
}
func TestRemoteProofRefusesForgeryLegacyAndWrongFilesystem(t *testing.T) {
	for _, mode := range []string{"forged", "legacy", "persistent-guest", "existing-receipt"} {
		t.Run(mode, func(t *testing.T) {
			f, e := brokerFixtureStart(t, "valid", 0)
			if e != nil {
				t.Fatal(e)
			}
			binding := bootstrap.RPCExportBinding{Host: "127.0.0.1", Port: 12345, ServerName: "storage.example", ServerCertificateSHA256: strings.Repeat("1", 64), ClientCertificateSHA256: strings.Repeat("2", 64), ContractSHA256: strings.Repeat("3", 64)}
			auth, proof, _ := remoteIssuer(t, f.session, binding)
			guest := guestReceipts(t)
			switch mode {
			case "forged":
				var sig bootstrap.RPCStorageSignatures
				json.Unmarshal(proof, &sig)
				sig.Base.Signature = strings.Repeat("0", 128)
				proof, _ = json.Marshal(sig)
			case "legacy":
				auth, proof = exportAuthorization(t, f.session.Request(), nil)
			case "persistent-guest":
				guest = persistentFixture(t)
			case "existing-receipt":
				os.WriteFile(filepath.Join(guest.Name(), "owner-response"), []byte("consumed"), 0400)
			}
			if e = f.session.AuthenticateRemoteReservation(auth, rpcBundle(t), proof, guest); e == nil {
				t.Fatal("invalid remote proof accepted")
			}
			if f.session.Context().Err() == nil {
				t.Fatal("failed proof did not close gate")
			}
		})
	}
}
func TestOwnerRelayLargeRequestOneShotAndLoss(t *testing.T) {
	for _, mode := range []string{"valid", "extra-fd", "oversized", "eof", "monitor-loss"} {
		t.Run(mode, func(t *testing.T) {
			f, e := brokerFixtureStart(t, "valid", 0)
			if e != nil {
				t.Fatal(e)
			}
			client, server := relayPair(t)
			guest := guestReceipts(t)
			// Above Unix seqpacket limits; the production protocol is a bounded stream.
			bundle := bytes.Repeat([]byte("b"), 300000)
			reply := []byte(`{"proof":"untrusted bytes only"}`)
			received := make(chan error, 1)
			go func() {
				var length [4]byte
				if _, e := io.ReadFull(server, length[:]); e != nil {
					received <- e
					return
				}
				size := binary.BigEndian.Uint32(length[:])
				data := make([]byte, size)
				_, e := io.ReadFull(server, data)
				if e != nil {
					received <- e
					return
				}
				var wire struct {
					Bundle   []byte
					Manifest []byte
					Request  Request
				}
				e = json.Unmarshal(data, &wire)
				if e != nil || !bytes.Equal(wire.Bundle, bundle) || wire.Request != f.session.Request() {
					received <- io.ErrUnexpectedEOF
					return
				}
				if _, e = os.Stat(filepath.Join(guest.Name(), "owner-submit")); e != nil {
					received <- e
					return
				}
				switch mode {
				case "monitor-loss":
					f.process.Process.Kill()
					received <- nil
					return
				case "eof":
					server.Close()
				case "extra-fd":
					binary.BigEndian.PutUint32(length[:], uint32(len(reply)))
					_, _, e = server.WriteMsgUnix(length[:], syscall.UnixRights(int(f.clock.Fd())), nil)
				case "oversized":
					binary.BigEndian.PutUint32(length[:], 65537)
					_, e = server.Write(length[:])
				default:
					binary.BigEndian.PutUint32(length[:], uint32(len(reply)))
					_, e = server.Write(append(length[:], reply...))
				}
				received <- e
			}()
			got, e := f.session.ExchangeOwner(client, bundle, []byte("public manifest"), guest)
			if mode == "valid" {
				if e != nil || !bytes.Equal(got, reply) {
					t.Fatal(e)
				}
				again, other := relayPair(t)
				defer other.Close()
				if _, e = f.session.ExchangeOwner(again, bundle, []byte("public manifest"), guest); e == nil {
					t.Fatal("owner resubmission accepted")
				}
			} else if e == nil || f.session.Context().Err() == nil {
				t.Fatal("relay ambiguity did not close gate", e)
			}
			select {
			case e := <-received:
				if e != nil {
					t.Fatal(e)
				}
			case <-time.After(time.Second):
				t.Fatal("relay helper hung")
			}
			if _, e = os.Stat(filepath.Join(guest.Name(), "owner-submit")); e != nil {
				t.Fatal("lost consumed relay intent", e)
			}
		})
	}
}
