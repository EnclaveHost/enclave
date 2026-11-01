package main

// In-guest app-zone issuance (appzone.go) against the test CA and in-process challenge replicas that check what a real
// replica's push preconditions check (the full chain/judge authority is network/app-zone-challenge.mjs, tested in
// test/app-zone-challenge.test.mjs, and end to end against separate replica processes in appzone_process_test.go).

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"enclave.host/isolation/m2/bootstrap"
)

const (
	repA = "replica-a.example"
	repB = "replica-b.example"
	repC = "replica-c.example"
)

func appLeaseFixture() bootstrap.LeaseBinding {
	var runner [32]byte
	for i := range runner {
		runner[i] = 0xcd
	}
	return bootstrap.LeaseBinding{Runner: runner, Operator: "0x" + strings.Repeat("ab", 20), AppRef: "catalog://0x" + strings.Repeat("66", 32) + "/1",
		Envelope: "bafyfixtureenvelope"}
}

func appGrant(owner string, replicas ...string) bootstrap.NameGrant {
	g := grantFor(owner, nil)
	var urls []string
	for _, r := range replicas {
		urls = append(urls, "https://"+r)
	}
	g.AppZone = &bootstrap.AppZoneACME{Directory: "https://" + caHost + "/dir", Challenges: urls}
	g.Lease = appLeaseFixture()
	return g
}

// replicaSet: in-process replicas. mode per host: "ok", "refuse" (403: what a replica answers for a banned host, a
// delisted app or a stale lease) or "down" (the egress cannot reach it).
type replicaSet struct {
	mu     sync.Mutex
	mode   map[string]string
	txt    map[string]map[string]bool // host -> "name value"
	pushes []appPush
	spki   []byte
	name   string
	lease  appLease
}

func (rs *replicaSet) handler(host string) http.HandlerFunc {
	return func(rw http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 1<<16))
		rs.mu.Lock()
		defer rs.mu.Unlock()
		if rs.mode[host] == "refuse" {
			http.Error(rw, `{"error":"app_challenge_refused","message":"the lease holder is not an active registry host"}`, http.StatusForbidden)
			return
		}
		var p appPush
		if r.URL.Path != appChallengePath || json.Unmarshal(raw, &p) != nil {
			http.Error(rw, "bad push", 400)
			return
		}
		spki, _ := base64.StdEncoding.DecodeString(p.SPKI)
		pub, err := x509.ParsePKIXPublicKey(spki)
		sig, _ := base64.StdEncoding.DecodeString(r.Header.Get("x-attested-sig"))
		digest := sha256.Sum256(append([]byte(appPushSigPrefix), raw...))
		if err != nil || !ecdsa.VerifyASN1(pub.(*ecdsa.PublicKey), digest[:], sig) {
			http.Error(rw, "not signed by the named key", 401)
			return
		}
		var doc struct{ TransportKey, Nonce string }
		json.Unmarshal(p.Attestation, &doc)
		if doc.TransportKey != p.SPKI || doc.Nonce != hex.EncodeToString(appPushNonce(p)) || !bytes.Equal(spki, rs.spki) {
			http.Error(rw, "the attestation does not bind this key and push", 403)
			return
		}
		if p.V != 2 || p.Name != "_acme-challenge."+rs.name || p.Lease != rs.lease || (p.Op == "set") != (r.Method == http.MethodPost) ||
			p.Order.URL == "" || p.Order.Expires <= time.Now().Unix() {
			http.Error(rw, "not this deployment's name, lease or order", 403)
			return
		}
		rs.pushes = append(rs.pushes, p)
		if rs.txt[host] == nil {
			rs.txt[host] = map[string]bool{}
		}
		if p.Op == "set" {
			rs.txt[host][p.Name+" "+p.Value] = true
		} else {
			delete(rs.txt[host], p.Name+" "+p.Value)
		}
		rw.Write([]byte(`{"ok":true}`))
	}
}

// the CA's resolver: any reachable name server answering the TXT is enough (the replicas are the zone's NS set)
func (rs *replicaSet) answers(name, value string) bool {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	for host, m := range rs.txt {
		if rs.mode[host] != "down" && m["_acme-challenge."+name+" "+value] {
			return true
		}
	}
	return false
}

func appWorld(t *testing.T, modes map[string]string) (*namesWorld, *front, *replicaSet) {
	w := newNamesWorld(t)
	f := namesFront(t, w)
	rs := &replicaSet{mode: modes, txt: map[string]map[string]bool{}, spki: f.spki, name: f.certs.name}
	l := appLeaseFixture()
	rs.lease = appLease{Runner: "0x" + hex.EncodeToString(l.Runner[:]), Operator: l.Operator, AppRef: l.AppRef, Envelope: l.Envelope}
	w.extraHosts = map[string]http.HandlerFunc{}
	for host, mode := range modes {
		if mode != "down" {
			w.extraHosts[host] = rs.handler(host)
		}
	}
	w.validate = rs.answers
	return w, f, rs
}

func newAppIssuer(t *testing.T, w *namesWorld, f *front, auth nameAuthority) *appZoneIssuer {
	iss, err := newAppZoneIssuer(auth, f.certs, "", nil, ownerHTTP(w.egress, w.pool), func(nonce []byte) ([]byte, error) {
		return json.Marshal(map[string]string{"transportKey": base64.StdEncoding.EncodeToString(f.spki), "nonce": hex.EncodeToString(nonce)})
	}, f.certs.key, f.spki)
	if err != nil || iss == nil {
		t.Fatalf("issuer %v: %v", iss, err)
	}
	return iss
}

func TestAppZoneIssuesThroughReplicasWithoutEnclaveAndKeepsTheKey(t *testing.T) {
	w, f, rs := appWorld(t, map[string]string{repA: "ok", repB: "ok", repC: "down"})
	auth := &fakeAuthority{grant: appGrant("0x"+strings.Repeat("33", 20), repA, repB, repC)}
	iss := newAppIssuer(t, w, f, auth)
	if !iss.pass(context.Background()) {
		t.Fatalf("not issued: %+v", iss.status())
	}
	leaf, err := handshake(t, f, w.pool, "11111111.app.enclave.host")
	if err != nil {
		t.Fatalf("a browser trusting the CA cannot reach the app-zone name: %v", err)
	}
	if got, _ := x509.MarshalPKIXPublicKey(leaf.PublicKey); !bytes.Equal(got, f.spki) || leaf.DNSNames[0] != "11111111.app.enclave.host" {
		t.Fatal("the certificate is not for the attested key and the HOST_DATA name")
	}
	// one replica down: the push still reached the others, each with the lease binding and the order; values cleaned up
	rs.mu.Lock()
	sets := 0
	for _, p := range rs.pushes {
		if p.Op == "set" {
			sets++
		}
	}
	if sets != 2 || len(rs.txt[repA]) != 0 || len(rs.txt[repB]) != 0 {
		t.Fatalf("pushes %d txt %v", sets, rs.txt)
	}
	rs.mu.Unlock()
	st := iss.status()
	last, _ := st["lastPush"].([]replicaOutcome)
	if len(last) != 3 || last[2].Status != 0 || last[0].Status != 200 || last[1].Status != 200 {
		t.Fatalf("per-replica outcomes %+v", last)
	}
	// nothing reached Enclave: only the CA and the selected replicas
	w.mu.Lock()
	for _, o := range w.origins {
		if strings.Contains(o, "enclave.host") || o == dnsAHost || o == dnsBHost {
			t.Fatalf("the guest contacted %s", o)
		}
	}
	w.mu.Unlock()
	b, _ := json.Marshal(st)
	if bytes.Contains(b, []byte("PRIVATE")) || bytes.Contains(b, []byte("BEGIN")) {
		t.Fatal("status leaks key material")
	}
	if iss.pass(context.Background()) {
		t.Fatal("a fresh certificate was re-issued")
	}
}

func TestAppZoneReplicaRefusalStopsBeforeTheCAValidates(t *testing.T) {
	w, f, _ := appWorld(t, map[string]string{repA: "ok", repB: "refuse"})
	auth := &fakeAuthority{grant: appGrant("0x"+strings.Repeat("33", 20), repA, repB)}
	iss := newAppIssuer(t, w, f, auth)
	if iss.pass(context.Background()) {
		t.Fatal("issued although a replica refused (banned host / delisted app / stale lease)")
	}
	w.mu.Lock()
	hits := w.chalHits
	w.mu.Unlock()
	if hits != 0 {
		t.Fatal("the guest asked the CA to validate after a refusal")
	}
	st := iss.status()
	if e, _ := st["lastError"].(string); !strings.Contains(e, "refused") || st["nextAttempt"] == nil {
		t.Fatalf("refusal must be stated and backed off: %+v", st)
	}
	if f.certs.current() != nil {
		t.Fatal("a certificate was installed")
	}
}

func TestAppZoneAllReplicasDownIsAnErrorNotAFallback(t *testing.T) {
	w, f, _ := appWorld(t, map[string]string{repA: "down", repB: "down"})
	iss := newAppIssuer(t, w, f, &fakeAuthority{grant: appGrant("0x"+strings.Repeat("33", 20), repA, repB)})
	if iss.pass(context.Background()) {
		t.Fatal("issued with no replica")
	}
	if e, _ := iss.status()["lastError"].(string); !strings.Contains(e, "no challenge replica accepted") {
		t.Fatalf("error %q", e)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, o := range w.origins {
		if strings.Contains(o, "enclave.host") {
			t.Fatalf("fell back to %s", o)
		}
	}
}

func TestAppZoneCertifiesOnlyTheHostDataName(t *testing.T) {
	w := newNamesWorld(t)
	f := namesFront(t, w)
	g := appGrant("0x"+strings.Repeat("33", 20), repA)
	g.Deployment[0] = 0x22 // the authorization names another deployment than this domain's HOST_DATA label
	if iss, err := newAppZoneIssuer(&fakeAuthority{grant: g}, f.certs, "", nil, nil, nil, f.certs.key, f.spki); err == nil || iss != nil {
		t.Fatal("an issuer started for a name that is not this domain's own")
	}
	none := grantFor("0x"+strings.Repeat("33", 20), nil)
	if iss, err := newAppZoneIssuer(&fakeAuthority{grant: none}, f.certs, "", nil, nil, nil, f.certs.key, f.spki); err != nil || iss != nil {
		t.Fatal("a package without appZone must keep the existing paths (no issuer)")
	}
	f.certs.name = ""
	if _, err := newAppZoneIssuer(&fakeAuthority{grant: appGrant("0x"+strings.Repeat("33", 20), repA)}, f.certs, "", nil, nil, nil, f.certs.key, f.spki); err == nil {
		t.Fatal("a domain without a HOST_DATA name must not certify anything")
	}
}

func TestAppZoneRevocationAndLeaseChangeStopIssuance(t *testing.T) {
	w, f, _ := appWorld(t, map[string]string{repA: "ok"})
	auth := &fakeAuthority{grant: appGrant("0x"+strings.Repeat("33", 20), repA)}
	iss := newAppIssuer(t, w, f, auth)
	// a lease change while the CA signs: the certificate is not installed
	w.onFinalize = func() {
		auth.mu.Lock()
		auth.grant.Lease.Envelope = "changed"
		auth.mu.Unlock()
	}
	if iss.pass(context.Background()) || f.certs.current() != nil {
		t.Fatal("installed after the lease changed during issuance")
	}
	w.onFinalize = nil
	auth.mu.Lock()
	auth.err = bootstrap.ErrRevoked
	auth.mu.Unlock()
	iss.st.nextAttempt = time.Time{}
	if iss.pass(context.Background()) {
		t.Fatal("issued after revocation")
	}
	if iss.status()["revoked"] == nil {
		t.Fatal("revocation not stated")
	}
}

// Negative control: test/run-app-zone.sh negative sets INJECT_FAILURE and requires this package's run to fail.
func TestAppZoneInjectedFailure(t *testing.T) {
	if os.Getenv("INJECT_FAILURE") != "" {
		t.Fatal("injected failure (negative control)")
	}
}
