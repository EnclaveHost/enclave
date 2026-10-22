package main

// End to end, across processes: the guest's real issuer (appzone.go) against SEPARATE challenge replica processes
// (relay/dns-relay.js APP_CHALLENGE_AUTH=attested-lease, started by test/app-zone-fleet.mjs, each verifying pushes
// with its own chain reads over JSON-RPC and the production judge in lab-unsigned mode), and the test CA validating
// dns-01 by REAL DNS queries to those replicas. Runs when APPZONE_FLEET=1 (test/run-app-zone.sh sets it, inside an
// unshared network namespace, so nothing beyond loopback - no Enclave API, CERTS_API or public CA - is reachable).

import (
	"bufio"
	"bytes"
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"enclave.host/isolation/m2/bootstrap"
)

type fleetInfo struct {
	Replicas []struct {
		API string `json:"api"`
		DNS string `json:"dns"`
		PID int    `json:"pid"`
	} `json:"replicas"`
	Control, Deployment, Owner, Runner, Operator, AppRef, Envelope string
	Legacy                                                         struct{ Name, Value string }
}

func startFleet(t *testing.T) (*fleetInfo, func(string, any) error) {
	cmd := exec.Command("node", "../../../test/app-zone-fleet.mjs", "3")
	cmd.Stderr = os.Stderr
	stdin, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stdin.Close(); cmd.Wait() })
	line, err := bufio.NewReader(out).ReadString('\n')
	var info fleetInfo
	if err != nil || json.Unmarshal([]byte(line), &info) != nil || len(info.Replicas) != 3 {
		t.Fatalf("fleet did not start: %v %q", err, line)
	}
	control := func(path string, body any) error {
		b, _ := json.Marshal(body)
		r, err := http.Post(info.Control+path, "application/json", bytes.NewReader(b))
		if err != nil {
			return err
		}
		defer r.Body.Close()
		if r.StatusCode != 200 {
			x, _ := io.ReadAll(r.Body)
			return fmt.Errorf("control %s: %d %s", path, r.StatusCode, x)
		}
		return nil
	}
	return &info, control
}

func dnsTXT(server, name string) []string {
	r := &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "udp", server)
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	v, _ := r.LookupTXT(ctx, name)
	return v
}

func TestAppZoneAgainstSeparateReplicaProcesses(t *testing.T) {
	if os.Getenv("APPZONE_FLEET") != "1" {
		t.Skip("run by test/run-app-zone.sh (APPZONE_FLEET=1) inside an isolated network namespace")
	}
	info, control := startFleet(t)
	t.Logf("fleet: replica processes %d %d %d, deployment %s", info.Replicas[0].PID, info.Replicas[1].PID, info.Replicas[2].PID, info.Deployment)
	defer func() {
		// the replicas' own logs (each accept/refusal, with the chain block it read) are kept as evidence
		r, err := http.Post(info.Control+"/logs", "application/json", nil)
		if err == nil {
			b, _ := io.ReadAll(r.Body)
			r.Body.Close()
			if path := os.Getenv("APPZONE_EVIDENCE"); path != "" {
				os.WriteFile(path, b, 0o644)
			}
		}
	}()
	hosts := []string{"rep-0.example", "rep-1.example", "rep-2.example"}
	live := []bool{true, true, true}
	var mu sync.Mutex
	answered := map[int]int{}

	world := func() (*namesWorld, *front) {
		w := newNamesWorld(t)
		c := newCertState(t, info.Deployment[2:10]+".app.enclave.host")
		w.spki = c.spki
		f := &front{spki: c.spki, appSha: bytes.Repeat([]byte{0x44}, 32), certs: c}
		w.extraHosts = map[string]http.HandlerFunc{}
		for i, h := range hosts {
			u, _ := url.Parse(info.Replicas[i].API)
			w.extraHosts[h] = httputil.NewSingleHostReverseProxy(u).ServeHTTP
		}
		// the CA's resolver asks one live name server (the first), and every live one is checked for the value
		w.validate = func(name, value string) bool {
			ok := false
			for i, r := range info.Replicas {
				mu.Lock()
				up := live[i]
				mu.Unlock()
				if !up {
					continue
				}
				// a CA retries a lookup briefly; a forwarded push lands at a peer a moment after the guest's push returns
				for try := 0; try < 20; try++ {
					hit := false
					for _, v := range dnsTXT(r.DNS, "_acme-challenge."+name) {
						if v == value {
							hit = true
						}
					}
					if hit {
						mu.Lock()
						answered[i]++
						mu.Unlock()
						ok = true
						break
					}
					time.Sleep(100 * time.Millisecond)
				}
			}
			return ok
		}
		return w, f
	}
	grant := func(replicas ...string) *fakeAuthority {
		var dep, runner [32]byte
		d, _ := hex.DecodeString(info.Deployment[2:])
		r, _ := hex.DecodeString(info.Runner[2:])
		copy(dep[:], d)
		copy(runner[:], r)
		var urls []string
		for _, h := range replicas {
			urls = append(urls, "https://"+h)
		}
		return &fakeAuthority{grant: bootstrap.NameGrant{Deployment: dep, Owner: info.Owner, Until: time.Now().Add(time.Hour),
			AppZone: &bootstrap.AppZoneACME{Directory: "https://" + caHost + "/dir", Challenges: urls},
			Lease:   bootstrap.LeaseBinding{Runner: runner, Operator: info.Operator, AppRef: info.AppRef, Envelope: info.Envelope}}}
	}
	issuer := func(w *namesWorld, f *front, auth *fakeAuthority) *appZoneIssuer {
		iss, err := newAppZoneIssuer(auth, f.certs, "", nil, ownerHTTP(w.egress, w.pool), func(nonce []byte) ([]byte, error) {
			b, _ := json.Marshal(map[string]string{"spki": base64.StdEncoding.EncodeToString(f.spki), "nonce": hex.EncodeToString(nonce), "hostData": info.Deployment})
			r, err := http.Post(info.Control+"/attest", "application/json", bytes.NewReader(b))
			if err != nil {
				return nil, err
			}
			defer r.Body.Close()
			return io.ReadAll(r.Body)
		}, f.certs.key, f.spki)
		if err != nil || iss == nil {
			t.Fatalf("issuer: %v", err)
		}
		return iss
	}
	noEnclave := func(w *namesWorld) {
		w.mu.Lock()
		defer w.mu.Unlock()
		for _, o := range w.origins {
			if strings.Contains(o, "enclave.host") {
				t.Fatalf("the guest contacted %s", o)
			}
		}
	}

	// 1. all three replicas: issued; every replica answered the CA's lookup; the key is the guest's
	w, f := world()
	iss := issuer(w, f, grant(hosts...))
	if !iss.pass(context.Background()) {
		t.Fatalf("not issued: %+v", iss.status())
	}
	leaf, err := handshake(t, f, w.pool, f.certs.name)
	if err != nil {
		t.Fatalf("the app-zone name is not browser-trusted: %v", err)
	}
	if got, _ := x509.MarshalPKIXPublicKey(leaf.PublicKey); !bytes.Equal(got, f.spki) {
		t.Fatal("the certificate is not for the guest's attested key")
	}
	mu.Lock()
	if answered[0] == 0 || answered[1] == 0 || answered[2] == 0 {
		t.Fatalf("not every replica answered the challenge: %v", answered)
	}
	t.Logf("1. issued %s, issuer %q, serial %s; DNS answers per replica %v; outcomes %+v", leaf.DNSNames[0], leaf.Issuer.CommonName,
		leaf.SerialNumber.Text(16), answered, iss.status()["lastPush"])
	mu.Unlock()
	noEnclave(w)

	// 2. one replica process down: a new guest key issues through the remaining two
	if err := control("/kill", map[string]int{"i": 1}); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	live[1] = false
	mu.Unlock()
	w, f = world()
	iss = issuer(w, f, grant(hosts...))
	if !iss.pass(context.Background()) {
		t.Fatalf("not issued with one replica down: %+v", iss.status())
	}
	if last, _ := iss.status()["lastPush"].([]replicaOutcome); len(last) != 3 || last[1].Status == 200 || last[0].Status != 200 || last[2].Status != 200 {
		t.Fatalf("outcomes %+v", last)
	} else {
		t.Logf("2. replica 1 killed; issued %s through the others; outcomes %+v", f.certs.current().DNSNames[0], last)
	}

	// 3. replication: the guest pushes only to replica 0; replica 2 answers too, after verifying the forwarded push itself
	mu.Lock()
	answered = map[int]int{}
	mu.Unlock()
	w, f = world()
	iss = issuer(w, f, grant(hosts[0]))
	if !iss.pass(context.Background()) {
		t.Fatalf("not issued through one replica: %+v", iss.status())
	}
	mu.Lock()
	if answered[2] == 0 {
		t.Fatalf("the forwarded push was not answered by the peer replica: %v", answered)
	}
	t.Logf("3. pushed to replica 0 only; DNS answers per replica %v (replica 2 via verified forwarding)", answered)
	mu.Unlock()

	// 4. platform moderation and stale leases stop issuance at the replicas, before the CA validates
	for _, c := range []struct{ op, undo, why string }{
		{"ban-host", "unban-host", "registry host"}, {"delist", "relist", "catalog policy"}, {"relet", "restore", "stale"}} {
		if err := control("/chain", map[string]string{"op": c.op}); err != nil {
			t.Fatal(err)
		}
		w, f = world()
		iss = issuer(w, f, grant(hosts...))
		if iss.pass(context.Background()) || f.certs.current() != nil {
			t.Fatalf("%s: a certificate was issued", c.op)
		}
		w.mu.Lock()
		hits := w.chalHits
		w.mu.Unlock()
		if e, _ := iss.status()["lastError"].(string); hits != 0 || !strings.Contains(e, "refused") || !strings.Contains(e, c.why) {
			t.Fatalf("%s: chal hits %d, error %q", c.op, hits, e)
		}
		t.Logf("4. %s: refused before CA validation: %s", c.op, iss.status()["lastError"])
		if err := control("/chain", map[string]string{"op": c.undo}); err != nil {
			t.Fatal(err)
		}
	}

	// 5. transition: the previous challenge source's value (relay flow) is still answered by a replica
	if v := dnsTXT(info.Replicas[0].DNS, info.Legacy.Name); len(v) != 1 || v[0] != info.Legacy.Value {
		t.Fatalf("the upstream (relay-flow) TXT value is not merged: %v", v)
	} else {
		t.Logf("5. upstream (relay-flow) value still answered: %v", v)
	}
	noEnclave(w)
}
