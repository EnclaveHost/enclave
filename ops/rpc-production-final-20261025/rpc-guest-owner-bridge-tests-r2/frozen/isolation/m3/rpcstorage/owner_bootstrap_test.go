//go:build linux && amd64

package rpcstorage

import (
	"bytes"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
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
)

func ownerTransportFixture(t *testing.T, session *BrokerSession, host string, port int, server []byte, client tls.Certificate) (*bootstrap.Authorization, []byte, OwnerBootstrapInput) {
	t.Helper()
	rt := contract.RuntimeIdentity{Name: "wasmtime", Version: "49.0.3", Execution: contract.ExecJIT, TargetISA: contract.ISAx86_64, HostISA: contract.ISAx86_64, CPUFeatures: "baseline", WX: contract.WXEnforced, Cache: contract.CacheNone}
	rid, _ := contract.RuntimeID(rt)
	auth, _, keys := exportAuthorizationKeys(t, session.request, nil, hex.EncodeToString(rid[:]))
	raw, e := os.ReadFile("../../m2/bootstrap/testdata/vectors.json")
	if e != nil {
		t.Fatal(e)
	}
	var v struct{ Manifest string }
	json.Unmarshal(raw, &v)
	var m bootstrap.Manifest
	json.Unmarshal([]byte(v.Manifest), &m)
	m.AppID = session.request.AppID
	m.Deployment = session.request.Deployment
	m.RuntimeID = hex.EncodeToString(rid[:])
	m.RPCStorage = &bootstrap.RPCStorage{Schema: "enclave-rpc-storage-authorities/1", L1: bootstrap.RPCStorageAuthority{VolumeID: session.request.L1Volume, PublicKey: hex.EncodeToString(keys[0].Public().(ed25519.PublicKey))}, Base: bootstrap.RPCStorageAuthority{VolumeID: session.request.BaseVolume, PublicKey: hex.EncodeToString(keys[1].Public().(ed25519.PublicKey))}}
	manifest, _ := json.Marshal(m)
	request, _ := json.Marshal(session.request)
	offer := bootstrap.RPCBootstrapOffer{Attempt: strings.Repeat("1", 32), Challenge: strings.Repeat("7", 64), ClientCertificateSHA256: sumHex(client.Certificate[0]), CredentialBlob: base64.StdEncoding.EncodeToString([]byte("synthetic")), Host: host, HostNonce: base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32)), ManifestSHA256: sumHex(manifest), Port: uint16(port), RequestSHA256: sumHex(request), Runtime: hex.EncodeToString(rid[:]), Schema: "enclave-rpc-owner-offer/1", Secret: base64.StdEncoding.EncodeToString([]byte("synthetic")), ServerCertificateSHA256: sumHex(server), ServerName: "export.control.test"}
	proof := bootstrap.RPCBootstrapOfferProof{Offer: offer}
	for role, dst := range []*string{&proof.L1, &proof.Base} {
		payload, e := bootstrap.RPCBootstrapOfferPayload(offer, byte(role))
		if e != nil {
			t.Fatal(e)
		}
		*dst = hex.EncodeToString(ed25519.Sign(keys[role], payload))
	}
	offerRaw, _ := json.Marshal(proof)
	certificate, e := x509.ParseCertificate(client.Certificate[0])
	if e != nil {
		t.Fatal(e)
	}
	spki, _ := x509.MarshalPKIXPublicKey(certificate.PublicKey)
	evidence, _ := json.Marshal(map[string]any{"purpose": contract.RPCBootstrapPurpose, "request": session.request, "requestSha256": sumHex(request), "runtime": rt, "transportKey": spki, "certificate": client.Certificate[0], "rootsGranted": false, "rpcReady": false, "challenge": offer.Challenge, "vbsVmReport": []byte("explicit-synthetic-report")})
	return auth, manifest, OwnerBootstrapInput{Evidence: evidence, HostEvidence: json.RawMessage(`{"synthetic":true}`), Offer: offerRaw, ServerDER: server}
}
func TestGuestOwnerTLSExchangeAndBindingFailures(t *testing.T) {
	for _, mode := range []string{"normal", "bad-signature", "wrong-pin", "wrong-ack", "incomplete-ack", "monitor-loss", "deadline"} {
		t.Run(mode, func(t *testing.T) {
			left := time.Duration(0)
			if mode == "deadline" {
				left = 450 * time.Millisecond
			}
			f, e := brokerFixtureStart(t, "valid", left)
			if e != nil {
				t.Fatal(e)
			}
			root, serverDER, client := testCredentials(t)
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
			auth, manifest, input := ownerTransportFixture(t, f.session, "127.0.0.1", listener.Addr().(*net.TCPAddr).Port, serverDER, client)
			if mode == "bad-signature" {
				var p bootstrap.RPCBootstrapOfferProof
				json.Unmarshal(input.Offer, &p)
				p.Base = strings.Repeat("0", 128)
				input.Offer, _ = json.Marshal(p)
			}
			if mode == "wrong-pin" {
				input.ServerDER = append([]byte(nil), serverDER...)
				input.ServerDER[10] ^= 1
			}
			serverDone := make(chan error, 1)
			if mode != "bad-signature" && mode != "wrong-pin" {
				go func() {
					conn, e := listener.Accept()
					if e != nil {
						serverDone <- e
						return
					}
					defer conn.Close()
					conn.SetDeadline(time.Now().Add(2 * time.Second))
					raw, e := readOwnerFrame(conn, 12<<20)
					if e != nil {
						serverDone <- e
						return
					}
					if !bytes.Contains(raw, []byte("enclave-rpc-owner-bootstrap-evidence/1")) {
						serverDone <- fmt.Errorf("evidence framing")
						return
					}
					if mode == "monitor-loss" {
						f.process.Process.Kill()
						var one [1]byte
						_, e = conn.Read(one[:])
						if e == nil {
							e = fmt.Errorf("monitor loss left transport open")
						}
						serverDone <- nil
						return
					}
					if mode == "deadline" {
						var one [1]byte
						_, e = conn.Read(one[:])
						if e == nil {
							serverDone <- fmt.Errorf("deadline left connection open")
						} else {
							serverDone <- nil
						}
						return
					}
					req, _ := json.Marshal(f.session.request)
					requestSHA := sumHex(req)
					if mode == "wrong-ack" {
						requestSHA = strings.Repeat("0", 64)
					}
					ack := []byte(fmt.Sprintf(`{"schema":"enclave-rpc-owner-bootstrap-accepted/1","requestSha256":"%s","certificateSha256":"%s","rootsGranted":false,"rpcReady":false}`, requestSHA, sumHex(client.Certificate[0])))
					if mode == "incomplete-ack" {
						ack = bytes.Replace(ack, []byte(`,"rootsGranted":false`), nil, 1)
					}
					if e = writeOwnerFrame(conn, ack); e != nil {
						serverDone <- e
						return
					}
					if mode == "wrong-ack" || mode == "incomplete-ack" {
						serverDone <- nil
						return
					}
					raw, e = readOwnerFrame(conn, 4<<20)
					if e == nil && !bytes.Contains(raw, []byte(`"manifest"`)) {
						e = fmt.Errorf("request frame missing")
					}
					if e == nil {
						e = writeOwnerFrame(conn, []byte(`{"transport":"synthetic-owner"}`))
					}
					serverDone <- e
				}()
			}
			receipts := guestReceipts(t)
			start := time.Now()
			response, e := f.session.ExchangeAuthenticatedOwner(auth, rpcBundle(t), manifest, input, client, receipts)
			if mode == "normal" {
				if e != nil || string(response) != `{"transport":"synthetic-owner"}` {
					t.Fatal(string(response), e)
				}
				if f.session.reserved || f.session.intent != nil {
					t.Fatal("transport created authority")
				}
				if _, e = f.session.ExchangeAuthenticatedOwner(auth, rpcBundle(t), manifest, input, client, receipts); e == nil {
					t.Fatal("replayed owner connection")
				}
			}
			if mode != "normal" && e == nil {
				t.Fatal("accepted", mode)
			}
			if mode == "bad-signature" || mode == "wrong-pin" {
				if _, e = os.Stat(filepath.Join(receipts.Name(), "owner-bootstrap-submit")); !os.IsNotExist(e) {
					t.Fatal("dial intent before authority", e)
				}
			} else {
				select {
				case e := <-serverDone:
					if e != nil {
						t.Fatal(e)
					}
				case <-time.After(time.Second):
					t.Fatal("fixture transport did not settle")
				}
			}
			if mode == "monitor-loss" && time.Since(start) > time.Second {
				t.Fatal("monitor loss not observed")
			}
			if mode == "deadline" {
				now, _ := f.session.clock.Stat()
				_ = now
				if time.Since(start) > time.Second {
					t.Fatal("original deadline extended")
				}
			}
		})
	}
}
