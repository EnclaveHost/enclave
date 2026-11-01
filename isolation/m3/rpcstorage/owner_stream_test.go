//go:build linux && amd64

package rpcstorage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/bootstrap"
	"enclave.host/isolation/m3/rpcservice"
)

func TestGuestOwnerContinuousTLSAndLoss(t *testing.T) {
	for _, mode := range []string{"prepare", "prepare-tamper", "prepare-stale", "normal", "idle-partial", "downgrade-ack", "idle-loss", "bad-signature", "unsolicited", "monitor-loss", "original-deadline"} {
		t.Run(mode, func(t *testing.T) {
			left := time.Duration(0)
			if mode == "original-deadline" {
				left = 500 * time.Millisecond
			}
			f, e := brokerFixtureStart(t, "valid", left)
			if e != nil {
				t.Fatal(e)
			}
			s := f.session
			root, der, client := testCredentials(t)
			pair, e := tls.LoadX509KeyPair(filepath.Join(root, "server-cert.pem"), filepath.Join(root, "server-key.pem"))
			if e != nil {
				t.Fatal(e)
			}
			ca := x509.NewCertPool()
			pem, _ := os.ReadFile(filepath.Join(root, "ca-cert.pem"))
			ca.AppendCertsFromPEM(pem)
			listener, e := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{pair}, ClientCAs: ca, ClientAuth: tls.RequireAndVerifyClientCert, MinVersion: tls.VersionTLS13, MaxVersion: tls.VersionTLS13})
			if e != nil {
				t.Fatal(e)
			}
			defer listener.Close()
			a, manifest, input, keys := ownerTransportFixtureKeys(t, s, "127.0.0.1", listener.Addr().(*net.TCPAddr).Port, der, client, "enclave-rpc-owner-offer/2")
			seeds := [2][]byte{keys[0].Seed(), keys[1].Seed()}
			defer func() {
				for _, k := range keys {
					clear(k)
				}
				for _, k := range seeds {
					clear(k)
				}
			}()
			binding := bootstrap.RPCExportBinding{Host: "127.0.0.1", Port: 12345, ServerName: "storage.example", ServerCertificateSHA256: strings.Repeat("1", 64), ClientCertificateSHA256: strings.Repeat("2", 64), ContractSHA256: strings.Repeat("3", 64)}
			o, e := NewOwnerIssuer(persistentFixture(t), seeds, [2]string{s.request.L1Volume, s.request.BaseVolume}, binding, time.Now().Add(3*time.Second))
			if e != nil {
				t.Fatal(e)
			}
			proof, e := o.Issue(context.Background(), a, rpcBundle(t), s.request)
			if e != nil {
				t.Fatal(e)
			}
			defer o.proof.Close()
			for _, r := range o.intent.records {
				defer r.Close()
			}
			// The real producer is used over actual TLS. Tests serialize its fixture
			// Authorization with the guest; production has independent owner readers.
			owner, e := o.BeginStartupContinuations(context.Background(), seeds)
			if e != nil {
				t.Fatal(e)
			}
			defer owner.Close()
			done := make(chan error, 1)
			control := make(chan struct{})
			defer close(control)
			go func() {
				conn, e := listener.Accept()
				if e != nil {
					done <- e
					return
				}
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(3 * time.Second))
				if _, e = readOwnerFrame(conn, 12<<20); e != nil {
					done <- e
					return
				}
				schema := "enclave-rpc-owner-bootstrap-accepted/2"
				if mode == "downgrade-ack" {
					schema = "enclave-rpc-owner-bootstrap-accepted/1"
				}
				request, _ := json.Marshal(s.request)
				ack := []byte(fmt.Sprintf(`{"schema":"%s","requestSha256":"%s","certificateSha256":"%s","rootsGranted":false,"rpcReady":false}`, schema, sumHex(request), sumHex(client.Certificate[0])))
				if e = writeOwnerFrame(conn, ack); e != nil {
					done <- e
					return
				}
				if mode == "downgrade-ack" {
					done <- nil
					return
				}
				if _, e = readOwnerFrame(conn, 4<<20); e != nil {
					done <- e
					return
				}
				initial, _ := json.Marshal(map[string]any{"schema": "enclave-rpc-owner-dispatched/2", "proof": proof})
				if e = writeOwnerFrame(conn, initial); e != nil {
					done <- e
					return
				}
				if mode == "idle-partial" {
					conn.Write([]byte{0})
					var one [1]byte
					_, e = conn.Read(one[:])
					if e == nil {
						done <- fmt.Errorf("partial unsolicited byte ignored")
					} else {
						done <- nil
					}
					return
				}
				if mode == "unsolicited" {
					writeOwnerFrame(conn, []byte(`{}`))
					done <- nil
					return
				}
				if mode == "idle-loss" {
					<-control
					done <- nil
					return
				}
				if strings.HasPrefix(mode, "prepare") {
					if mode == "prepare-tamper" {
						// Real startup signature, then an intentionally invalid
						// preparation reply from the authenticated owner socket.
						raw, e := readOwnerFrame(conn, 1024)
						if e != nil {
							done <- e
							return
						}
						var p bootstrap.RPCContinuation
						json.Unmarshal(raw, &p)
						reply, e := owner.IssueStartup(p)
						if e != nil {
							done <- e
							return
						}
						if e = writeOwnerFrame(conn, reply); e != nil {
							done <- e
							return
						}
						raw, e = readOwnerFrame(conn, 1024)
						if e != nil {
							done <- e
							return
						}
						reply, e = owner.PrepareServing(raw)
						if e != nil {
							done <- e
							return
						}
						var bad servingPreparedProof
						json.Unmarshal(reply, &bad)
						bad.Base = bad.L1
						reply, _ = json.Marshal(bad)
						writeOwnerFrame(conn, reply)
						var b [1]byte
						conn.Read(b[:])
						done <- nil
						return
					}
					_ = owner.ServeStartupContinuations(conn, conn)
					done <- nil
					return
				}
				for i := 0; i < 2; i++ {
					raw, e := readOwnerFrame(conn, 1024)
					if e != nil {
						done <- nil
						return
					}
					var p bootstrap.RPCContinuation
					if e = json.Unmarshal(raw, &p); e != nil {
						done <- e
						return
					}
					reply, e := owner.IssueStartup(p)
					if e != nil {
						done <- e
						return
					}
					if mode == "bad-signature" {
						var q bootstrap.RPCContinuationSignatures
						json.Unmarshal(reply, &q)
						q.Base = strings.Repeat("0", 128)
						reply, _ = json.Marshal(q)
					}
					if e = writeOwnerFrame(conn, reply); e != nil {
						done <- e
						return
					}
				}
				<-control
				done <- nil
			}()
			receipts := guestReceipts(t)
			response, e := s.ExchangeAuthenticatedOwner(a, rpcBundle(t), manifest, input, client, receipts)
			if mode == "downgrade-ack" {
				if e == nil {
					t.Fatal("protocol downgrade accepted")
				}
				<-done
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			if !s.HasOwnerContinuations() {
				t.Fatal("signed protocol not retained")
			}
			if mode == "unsolicited" || mode == "idle-partial" {
				select {
				case <-s.ctx.Done():
				case <-time.After(time.Second):
					t.Fatal("unsolicited owner data ignored")
				}
				<-done
				return
			}
			var initial struct {
				Schema string `json:"schema"`
				Proof  []byte `json:"proof"`
			}
			if e = json.Unmarshal(response, &initial); e != nil {
				t.Fatal(e)
			}
			if e = s.AuthenticateRemoteReservation(a, rpcBundle(t), initial.Proof, receipts); e != nil {
				t.Fatal(e)
			}
			h := sha256.Sum256(proof)
			if s.ownerProofSHA != hex.EncodeToString(h[:]) {
				t.Fatal("original signed proof changed")
			}
			if mode == "idle-loss" {
				control <- struct{}{}
				select {
				case <-s.ctx.Done():
				case <-time.After(time.Second):
					t.Fatal("idle EOF not observed")
				}
				<-done
				return
			}
			if mode == "monitor-loss" {
				f.process.Process.Kill()
				select {
				case <-s.ctx.Done():
				case <-time.After(time.Second):
					t.Fatal("monitor loss not observed")
				}
				<-done
				return
			}
			if mode == "original-deadline" {
				select {
				case <-s.ctx.Done():
				case <-time.After(time.Second):
					t.Fatal("original deadline reset")
				}
				<-done
				return
			}
			if strings.HasPrefix(mode, "prepare") {
				s.mu.Lock()
				s.exportBound = true
				s.mu.Unlock() // actual export is not this TLS fixture
				original := s.request
				runDone := make(chan error, 1)
				go func() { runDone <- s.RunOwnerContinuations(a, rpcBundle(t), receipts) }()
				// Publish actual private pipe evidence while the loop is waiting
				// for its ten-second timer. The one-shot signal must wake it now.
				limit := time.Now().Add(time.Second)
				for {
					s.continuationMu.Lock()
					seq := s.continuationSequence
					s.continuationMu.Unlock()
					if seq == 1 {
						break
					}
					if time.Now().After(limit) {
						t.Fatal("first startup not received")
					}
					time.Sleep(time.Millisecond)
				}
				now, _ := rpcservice.MonotonicNow()
				rb := contract.RPCStartBinding{AppID: contract.AppID(rpcBundle(t)), Nonce: [32]byte{9}}
				rt, _ := hex.DecodeString(s.consent.RuntimeID())
				copy(rb.RuntimeID[:], rt)
				dep, _ := hex.DecodeString(strings.TrimPrefix(s.request.Deployment, "0x"))
				copy(rb.Deployment[:], dep)
				if mode == "prepare-stale" {
					now -= contract.RPCLocalReadyFreshnessNS
				}
				observation, _ := (contract.RPCLocalReady{Binding: rb, ObservedMono: now}).Frame()
				reader, writer, e := os.Pipe()
				if e != nil {
					t.Fatal(e)
				}
				defer reader.Close()
				writer.Write(observation)
				writer.Close()
				start := time.Now()
				e = s.ReceiveLocalReady(reader, rpcBundle(t), receipts)
				if mode == "prepare-stale" {
					if e == nil {
						t.Fatal("stale accepted")
					}
				} else if e != nil {
					t.Fatal(e)
				}
				for {
					s.mu.Lock()
					prepared := s.prepared
					s.mu.Unlock()
					if prepared != nil || s.ctx.Err() != nil {
						break
					}
					if time.Since(start) > time.Second {
						t.Fatal("readiness waited for ten-second interval")
					}
					time.Sleep(time.Millisecond)
				}
				s.mu.Lock()
				prepared := s.prepared
				s.mu.Unlock()
				if (prepared != nil) != (mode == "prepare") {
					t.Fatal("unexpected preparation result", s.ctx.Err())
				}
				if prepared != nil {
					if s.request != original || !bytes.Equal(prepared.request.Observation, observation) {
						t.Fatal("attempt/frame changed")
					}
					disk, e := os.ReadFile(filepath.Join(receipts.Name(), "owner-serving-prepare-proof"))
					if e != nil || !bytes.Equal(disk, prepared.raw) {
						t.Fatal("missing exact receipt", e)
					}
				}
				s.Stop()
				<-runDone
				<-done
				return
			}
			for i := 0; i < 2; i++ {
				e = s.continueOwnerOnce(s.ownerStream, a, rpcBundle(t), receipts)
				if mode == "bad-signature" {
					if e == nil {
						t.Fatal("invalid signed reply accepted")
					}
					<-done
					return
				}
				if e != nil {
					t.Fatal(e)
				}
			}
			if s.continuationSequence != 2 {
				t.Fatal("stream sequence lost")
			}
			s.Stop()
			control <- struct{}{}
			<-done
		})
	}
}
