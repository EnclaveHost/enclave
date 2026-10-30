package main

// Encrypted volumes in a Shield partition SECRET domain (shield_egress.go + encvol.go): the measured config names a
// volume whose endpoint is a staged secret; when the release arrives, the plane starts after the forwarders and
// BEFORE the listener audit (which must see it), and only then does the runtime's pipe carry the plane's URL, the
// token and the names next to the owner's secrets. Volumes the monitor did not stage, or a resolved config that
// disagrees with what it staged, end the domain with nothing written.

import (
	"encoding/json"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func encShieldWorld(t *testing.T, config, marker string) (*front, *secretSink, *egressWorld, func() map[string]string) {
	f, sink, priv := secretFixture(t)
	w := newEgressWorld(t, config)
	root := t.TempDir()
	os.Mkdir(filepath.Join(root, "docs"), 0o770)
	mk := filepath.Join(t.TempDir(), "enc.volumes")
	os.WriteFile(mk, []byte(marker), 0o444)
	w.eg.enc = &encvolHost{root: root, uid: -1, gid: -1, listen: "127.0.0.1:0", shared: true, kill: func(string) {}}
	w.eg.encMarker = mk
	w.eg.encID = f.secrets.id
	f.secrets.egress = w.eg
	release := func() map[string]string {
		return validRelease(t, f, priv, map[string]string{"R2_ENDPOINT": "https://acct0123.r2.cloudflarestorage.com", "R2_KEY": "synthetic-r2-key"})
	}
	return f, sink, w, release
}

const encShieldConfig = `{"encVolumes":[{"name":"docs","endpoint":"$R2_ENDPOINT","bucket":"notes","path":"v","maxMb":16}],"accessKeyId":"$R2_KEY"}`

func TestShieldEncVolumesPlaneIsAuditedBeforeTheRuntimeGetsItsLaunch(t *testing.T) {
	f, sink, w, release := encShieldWorld(t, encShieldConfig, "docs\n")
	var plane netip.AddrPort
	sink.onWrite = func() {
		if w.eg.encOut == nil {
			t.Error("the runtime got its launch before the plane started")
			return
		}
		plane = w.eg.encOut.addr
		fwd := netip.AddrPortFrom(netip.MustParseAddr("127.64.0.2"), uint16(w.eg.port))
		if len(w.audited) != 2 || w.audited[0] != fwd || w.audited[1] != plane {
			t.Errorf("the audit saw %v, want the forwarder %v and the plane %v", w.audited, fwd, plane)
		}
		hosts, _ := os.ReadFile(w.eg.hosts)
		if !strings.Contains(string(hosts), "acct0123.r2.cloudflarestorage.com") {
			t.Errorf("the volume's resolved endpoint is not in /etc/hosts: %s", hosts)
		}
	}
	if code := postSecret(f, release()); code != 200 || !sink.closed {
		t.Fatalf("status %d closed %v", code, sink.closed)
	}
	var launch map[string]string
	if err := json.Unmarshal(sink.Bytes(), &launch); err != nil {
		t.Fatal(err)
	}
	if launch["ENCLAVE_ENC"] != "docs" || launch["R2_KEY"] != "synthetic-r2-key" ||
		!regexp.MustCompile(`^http://127\.0\.0\.1:\d+/encvol/0x[0-9a-f]{64}$`).MatchString(launch["ENCLAVE_ENC_API"]) ||
		!regexp.MustCompile(`^[0-9a-f]{48}$`).MatchString(launch["ENCLAVE_ENC_TOKEN"]) {
		t.Fatalf("the runtime's launch: %v", keysOfMap(launch))
	}
	// the plane answers the token for this deployment, on the address the audit saw
	req, _ := http.NewRequest("GET", launch["ENCLAVE_ENC_API"], nil)
	req.Header.Set("X-Enc-Token", launch["ENCLAVE_ENC_TOKEN"])
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 || !strings.Contains(launch["ENCLAVE_ENC_API"], plane.String()) {
		t.Fatalf("the plane: %v %v", resp, err)
	}
	var st struct {
		Volumes []struct{ Name, Status, Endpoint string } `json:"volumes"`
	}
	json.NewDecoder(resp.Body).Decode(&st)
	resp.Body.Close()
	if len(st.Volumes) != 1 || st.Volumes[0].Status != "locked" || st.Volumes[0].Endpoint != "https://acct0123.r2.cloudflarestorage.com" {
		t.Fatalf("status: %+v", st)
	}
	for _, l := range w.console() {
		if strings.Contains(l, "acct0123") || strings.Contains(l, "synthetic") || strings.Contains(l, launch["ENCLAVE_ENC_TOKEN"]) || !strings.HasPrefix(l, "DOM ") {
			t.Fatalf("a console line carries config, a secret or the token: %q", l)
		}
	}
}

func TestShieldEncVolumesRefusedUnlessStagedExactly(t *testing.T) {
	for name, c := range map[string]struct{ config, marker string }{
		"a volume the monitor did not stage":    {encShieldConfig, "other\n"},
		"no staging marker content":             {encShieldConfig, ""},
		"a resolved endpoint the guest refuses": {strings.Replace(encShieldConfig, "$R2_ENDPOINT", "http://plain.example.com", 1), "docs\n"},
	} {
		t.Run(name, func(t *testing.T) {
			f, sink, _, release := encShieldWorld(t, c.config, c.marker)
			if code := postSecret(f, release()); code != 503 || sink.Len() != 0 || !sink.closed {
				t.Fatalf("status %d wrote %d closed %v", code, sink.Len(), sink.closed)
			}
		})
	}
	// no engine at all (an image or monitor without staging): refused the same way
	f, sink, w, release := encShieldWorld(t, encShieldConfig, "docs\n")
	w.eg.enc = nil
	if code := postSecret(f, release()); code != 503 || sink.Len() != 0 {
		t.Fatalf("no engine: status %d wrote %d", code, sink.Len())
	}
}

func keysOfMap(m map[string]string) []string {
	var l []string
	for k := range m {
		l = append(l, k)
	}
	return l
}
