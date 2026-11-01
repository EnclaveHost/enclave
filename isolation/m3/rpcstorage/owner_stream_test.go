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
	"syscall"
	"testing"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/bootstrap"
	"enclave.host/isolation/m3/rpcservice"
)

func TestGuestOwnerContinuousTLSAndLoss(t *testing.T) {
	for _, mode := range []string{"commit", "commit-renew", "commit-original-deadline", "commit-second-guard-loss", "commit-guard-receipt-conflict", "commit-owner-tamper", "commit-changed-response", "commit-lost-reply", "commit-stale", "prepare", "prepare-guard-loss", "prepare-tamper", "prepare-stale", "normal", "idle-partial", "downgrade-ack", "idle-loss", "bad-signature", "unsolicited", "monitor-loss", "original-deadline"} {
		t.Run(mode, func(t *testing.T) {
			left := time.Duration(0)
			if mode == "original-deadline" || mode == "commit-original-deadline" {
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
				if strings.HasPrefix(mode, "prepare") || strings.HasPrefix(mode, "commit") {
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
					if mode == "commit-owner-tamper" || mode == "commit-changed-response" || mode == "commit-lost-reply" || mode == "commit-stale" {
						for phase := 0; phase < 3; phase++ {
							raw, e := readOwnerFrame(conn, 1024)
							if e != nil {
								done <- e
								return
							}
							var reply []byte
							switch phase {
							case 0:
								var p bootstrap.RPCContinuation
								json.Unmarshal(raw, &p)
								reply, e = owner.IssueStartup(p)
							case 1:
								reply, e = owner.PrepareServing(raw)
							case 2:
								if mode == "commit-changed-response" {
									var changed servingCommitRequest
									json.Unmarshal(raw, &changed)
									changed.Permit.NotAfter--
									raw, _ = json.Marshal(changed)
								}
								reply, e = owner.IssueServing(raw)
								if mode == "commit-owner-tamper" {
									var bad bootstrap.RPCContinuationSignatures
									json.Unmarshal(reply, &bad)
									bad.Base = bad.L1
									reply, _ = json.Marshal(bad)
								}
								if mode == "commit-stale" {
									time.Sleep(3100 * time.Millisecond)
								}
							}
							if e != nil {
								done <- e
								return
							}
							if phase == 2 && mode == "commit-lost-reply" {
								var one [1]byte
								conn.Read(one[:])
								done <- nil
								return
							}
							if e = writeOwnerFrame(conn, reply); e != nil {
								done <- nil
								return
							}
						}
						var one [1]byte
						conn.Read(one[:])
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
			if strings.HasPrefix(mode, "prepare") || strings.HasPrefix(mode, "commit") {
				s.mu.Lock()
				s.exportBound = true
				s.mu.Unlock() // actual export is not this TLS fixture
				// Two private channels, actual broker client, bounded test-only
				// guardian responders. Native receiver is qualified separately.
				var guardFiles [2]*os.File
				guardAcks := make(chan []byte, 8)
				for i := range guardFiles {
					pair, e := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_SEQPACKET|syscall.SOCK_CLOEXEC, 0)
					if e != nil {
						t.Fatal(e)
					}
					guardFiles[i] = os.NewFile(uintptr(pair[0]), "fixture-guard")
					defer guardFiles[i].Close()
					peer := pair[1]
					if mode == "prepare-guard-loss" && i == 1 {
						syscall.Close(peer)
						continue
					}
					guardIndex := i
					go func() {
						defer syscall.Close(peer)
						for op := 0; op < 3; op++ {
							b := make([]byte, 89)
							n, _, e := syscall.Recvfrom(peer, b, 0)
							if e != nil || n != 88 {
								return
							}
							if b[8] == 2 && mode == "commit-second-guard-loss" && guardIndex == 1 {
								return
							}
							guardAcks <- append([]byte(nil), b[:n]...)
							b[8] |= 0x80
							if syscall.Sendmsg(peer, b[:n], nil, nil, syscall.MSG_NOSIGNAL) != nil {
								return
							}
						}
						<-s.Context().Done()
					}()
				}
				if e := s.BindServingGuards(guardFiles[0], guardFiles[1]); e != nil {
					t.Fatal(e)
				}
				if mode == "commit-guard-receipt-conflict" {
					if e := os.WriteFile(filepath.Join(receipts.Name(), "owner-serving-0000000000000002-guardians"), []byte("held"), 0400); e != nil {
						t.Fatal(e)
					}
				}
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
					committed := len(s.servingProof) > 0
					s.mu.Unlock()
					if (prepared != nil && !strings.HasPrefix(mode, "commit")) || (committed && strings.HasPrefix(mode, "commit")) || s.ctx.Err() != nil {
						break
					}
					if time.Since(start) > 4*time.Second {
						t.Fatal("readiness/commit waited for ten-second interval")
					}
					time.Sleep(time.Millisecond)
				}
				s.mu.Lock()
				prepared := s.prepared
				s.mu.Unlock()
				if strings.HasPrefix(mode, "commit") {
					s.mu.Lock()
					committed := append([]byte(nil), s.servingProof...)
					gseq := s.servingSequence
					s.mu.Unlock()
					expected := mode == "commit" || mode == "commit-renew" || mode == "commit-original-deadline"
					if (len(committed) > 0) != expected || (expected && gseq != 1) {
						t.Fatal("partial transaction published success", mode, s.ctx.Err())
					}
					if expected {
						disk, e := os.ReadFile(filepath.Join(receipts.Name(), "owner-serving-0000000000000002-proof"))
						if e != nil || !bytes.Equal(disk, committed) {
							t.Fatal("owner proof not durable", e)
						}
						for i := 0; i < 4; i++ {
							select {
							case frame := <-guardAcks:
								if (i < 2 && frame[8] != 1) || (i >= 2 && frame[8] != 2) {
									t.Fatal("unexpected guard order")
								}
							case <-time.After(time.Second):
								t.Fatal("missing guardian acknowledgement")
							}
						}
						if mode == "commit-renew" {
							time.Sleep(time.Until(time.Now().Truncate(time.Second).Add(time.Second)) + 5*time.Millisecond)
							if e = s.continueServingOwnerOnce(s.ownerStream, a, rpcBundle(t), receipts); e != nil {
								t.Fatal("same stream renewal", e)
							}
							s.mu.Lock()
							gseq = s.servingSequence
							s.mu.Unlock()
							if gseq != 2 {
								t.Fatal("renewal sequence lost")
							}
							for i := 0; i < 2; i++ {
								frame := <-guardAcks
								if frame[8] != 3 {
									t.Fatal("renewal not sent to both original guardians")
								}
							}
						}
					} else {
						if s.ctx.Err() == nil {
							t.Fatal("failed commit did not lose whole session")
						}
						if _, e = os.Stat(filepath.Join(receipts.Name(), "owner-serving-0000000000000002-submit")); e != nil {
							t.Fatal("ambiguous intent disappeared", e)
						}
						if mode == "commit-second-guard-loss" || mode == "commit-guard-receipt-conflict" {
							if _, e = os.Stat(filepath.Join(receipts.Name(), "owner-serving-0000000000000002-proof")); e != nil {
								t.Fatal("partial commit proof disappeared", e)
							}
						}
					}
					if mode == "commit-original-deadline" {
						select {
						case <-s.ctx.Done():
						case <-time.After(time.Second):
							t.Fatal("component commit bypassed original broker deadline")
						}
					}
					if s.request != original {
						t.Fatal("startup clock reset")
					}
					s.Stop()
					<-runDone
					<-done
					return
				}
				if (prepared != nil) != (mode == "prepare") {
					t.Fatal("unexpected preparation result", s.ctx.Err())
				}
				if prepared != nil {
					ack0, ack1 := <-guardAcks, <-guardAcks
					proofSum := sha256.Sum256(prepared.raw)
					if !bytes.Equal(ack0, ack1) || ack0[8] != 1 || !bytes.Equal(ack0[56:], proofSum[:]) {
						t.Fatal("guards did not prepare same exact owner proof")
					}
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
