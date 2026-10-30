package encvol

// Tests for the guest's encrypted volumes against the REAL implementations they must agree with:
//   - Parse against wasm/wasm_manager.py's own _parse_enc_volumes (testdata/parse_ref.py runs it), case by case;
//   - the plane, unlock/sync/lock, the caps and the audit, with the owner's side played by the real pinned rclone
//     (ENCVOL_RCLONE, v1.67.0) on its local backend; the S3 protocol and the format matrix are compat_test.go's,
//     wasmtime and the app front/encvol_e2e_test.go's.
//
//   ENCVOL_RCLONE=/path/to/rclone go test ./encvol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func rcloneBin(t *testing.T) string {
	t.Helper()
	p := os.Getenv("ENCVOL_RCLONE")
	if p == "" {
		t.Skip("ENCVOL_RCLONE (the pinned rclone v1.67.0) is not set")
	}
	return p
}

// ---- Parse vs the standard runtime ------------------------------------------------------------------------------

func TestParseMatchesTheStandardRuntime(t *testing.T) {
	rc := rcloneBin(t)
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("no python3 for the reference")
	}
	vol := func(kv ...any) map[string]any {
		m := map[string]any{"name": "docs", "endpoint": "https://s3.eu-central-1.amazonaws.com", "bucket": "b"}
		for i := 0; i+1 < len(kv); i += 2 {
			if kv[i+1] == nil {
				delete(m, kv[i].(string))
			} else {
				m[kv[i].(string)] = kv[i+1]
			}
		}
		return m
	}
	cfg := func(vols ...any) map[string]any { return map[string]any{"encVolumes": vols} }
	many := []any{}
	for i := 0; i < 9; i++ {
		many = append(many, vol("name", fmt.Sprintf("v%d", i)))
	}
	cases := []struct {
		name       string
		cfg        map[string]any
		narrow     bool // the standard tier accepts; a per-app guest refuses (its egress carries only https:443 DNS names)
		anyRefusal bool // both refuse; the endpoint messages differ by design
	}{
		{"no encVolumes", map[string]any{"other": 1}, false, false},
		{"empty list", cfg(), false, false},
		{"falsy encVolumes", map[string]any{"encVolumes": false}, false, false},
		{"defaults", cfg(vol()), false, false},
		{"every field", cfg(vol("path", "/a/b/", "maxMb", 64, "readOnly", true, "provider", "AWS", "region", "eu-central-1",
			"filenameEncryption", "obfuscate", "directoryNameEncryption", false, "unlock", "wallet", "keyId", "my-key")), false, false},
		{"plain", cfg(vol("encrypted", false)), false, false},
		{"maxMb as a string", cfg(vol("maxMb", "05")), false, false},
		{"maxMb zero takes the default", cfg(vol("maxMb", 0)), false, false},
		{"truthy string encrypted", cfg(vol("encrypted", "false")), false, false},
		{"endpoint trailing slash", cfg(vol("endpoint", "https://s3.example.com/")), false, false},
		{"provider blank", cfg(vol("provider", "  ")), false, false},
		{"two volumes", cfg(vol(), vol("name", "pub", "encrypted", false)), false, false},
		{"bad name", cfg(vol("name", "UPPER")), false, false},
		{"duplicate", cfg(vol(), vol()), false, false},
		{"bad bucket", cfg(vol("bucket", "-x")), false, false},
		{"path with ..", cfg(vol("path", "a/../b")), false, false},
		{"crypt field on plain", cfg(vol("encrypted", false, "filenameEncryption", "off")), false, false},
		{"bad filenameEncryption", cfg(vol("filenameEncryption", "rot13")), false, false},
		{"blank filenameEncryption", cfg(vol("filenameEncryption", " ")), false, false},
		{"maxMb over", cfg(vol("maxMb", 999999)), false, false},
		{"maxMb not a number", cfg(vol("maxMb", "abc")), false, false},
		{"maxMb zero string", cfg(vol("maxMb", "0")), false, false},
		{"bad unlock", cfg(vol("unlock", "retina-scan")), false, false},
		{"blank unlock", cfg(vol("unlock", " ")), false, false},
		{"bad keyId", cfg(vol("keyId", "Key!")), false, false},
		{"nine volumes", map[string]any{"encVolumes": many}, false, false},
		{"not a list", map[string]any{"encVolumes": map[string]any{"a": 1}}, false, false},
		{"entry not an object", cfg("docs"), false, false},
		{"ftp endpoint", cfg(vol("endpoint", "ftp://s3.example.com")), false, false},
		{"private IP literal", cfg(vol("endpoint", "https://10.0.0.1")), false, true},
		{"loopback name", cfg(vol("endpoint", "https://localhost")), false, true},
		{"local: hook without the env", cfg(vol("endpoint", "local:/etc")), false, false},
		{"plain http (standard tier only)", cfg(vol("endpoint", "http://s3.example.com")), true, false},
		{"another port (standard tier only)", cfg(vol("endpoint", "https://s3.example.com:9000")), true, false},
		{"public IP literal (standard tier only)", cfg(vol("endpoint", "https://8.8.8.8")), true, false},
	}
	in, _ := json.Marshal(func() []any {
		var l []any
		for _, c := range cases {
			l = append(l, c.cfg)
		}
		return l
	}())
	cmd := exec.Command("python3", "testdata/parse_ref.py", rc)
	cmd.Stdin = bytes.NewReader(in)
	var errb bytes.Buffer
	cmd.Stderr = &errb
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("the reference parser: %v\n%s", err, errb.String())
	}
	var ref []struct {
		OK  []map[string]any `json:"ok"`
		Err *string          `json:"err"`
	}
	if err := json.Unmarshal(out, &ref); err != nil || len(ref) != len(cases) {
		t.Fatalf("reference output: %v (%d results)", err, len(ref))
	}
	for i, c := range cases {
		b, _ := json.Marshal(c.cfg)
		got, gerr := Parse(string(b), ParseOptions{})
		r := ref[i]
		switch {
		case c.narrow:
			if r.Err != nil || gerr == nil || !strings.Contains(gerr.Error(), "per-app guest") {
				t.Errorf("%s: want standard-tier acceptance and a stated per-app refusal; ref err=%v, got err=%v", c.name, r.Err, gerr)
			}
		case r.Err != nil:
			if gerr == nil {
				t.Errorf("%s: the standard tier refuses (%s) and this accepts", c.name, *r.Err)
			} else if !c.anyRefusal && gerr.Error() != *r.Err {
				t.Errorf("%s: message differs\n  standard: %s\n  guest:    %s", c.name, *r.Err, gerr.Error())
			}
		default:
			if gerr != nil {
				t.Errorf("%s: the standard tier accepts and this refuses: %v", c.name, gerr)
				continue
			}
			var mine []map[string]any
			for _, s := range got {
				mine = append(mine, map[string]any{"name": s.Name, "endpoint": s.Endpoint, "bucket": s.Bucket, "path": s.Path,
					"unlock": s.Unlock, "keyId": s.KeyID, "encrypted": s.Encrypted, "provider": s.Provider, "region": s.Region,
					"filenameEncryption": s.FilenameEncryption, "directoryNameEncryption": s.DirectoryNameEncryption,
					"maxMb": float64(s.MaxMB), "readOnly": s.ReadOnly})
			}
			if len(r.OK) == 0 && len(mine) == 0 {
				continue
			}
			if !reflect.DeepEqual(mine, r.OK) {
				t.Errorf("%s: specs differ\n  standard: %v\n  guest:    %v", c.name, r.OK, mine)
			}
		}
	}
}

// ---- the plane, on the real rclone ---------------------------------------------------------------------------------

type rig struct {
	t      *testing.T
	rc     string
	root   string // the guest's /enc stand-in
	remote string // a local-backend "bucket" root
	svc    *Service
	srv    *httptest.Server
	mu     sync.Mutex
	logs   []string
	killed []string
}

const pw, salt = "hunter2 pass", "sodium chloride"

func newRig(t *testing.T, vols ...map[string]any) *rig {
	r := &rig{t: t, rc: rcloneBin(t), root: t.TempDir(), remote: t.TempDir()}
	for _, v := range vols {
		if _, ok := v["endpoint"]; !ok {
			v["endpoint"] = "local:" + r.remote
		}
	}
	b, _ := json.Marshal(map[string]any{"encVolumes": vols})
	specs, err := Parse(string(b), ParseOptions{AllowLocal: true})
	if err != nil {
		t.Fatal(err)
	}
	r.svc, err = New("0xabc", specs, Options{Root: r.root, UID: -1, GID: -1, Timeout: time.Minute,
		Logf: func(f string, a ...any) { r.mu.Lock(); r.logs = append(r.logs, fmt.Sprintf(f, a...)); r.mu.Unlock() },
		Kill: func(reason string) { r.mu.Lock(); r.killed = append(r.killed, reason); r.mu.Unlock() }})
	if err != nil {
		t.Fatal(err)
	}
	r.srv = httptest.NewServer(r.svc)
	t.Cleanup(r.srv.Close)
	return r
}

// push writes `files` into the remote as the owner's client would (scripts/enclave-encvol.sh's environment).
func (r *rig) push(path string, crypt bool, files map[string]string) {
	src := r.t.TempDir()
	for n, c := range files {
		os.MkdirAll(filepath.Join(src, filepath.Dir(n)), 0o755)
		os.WriteFile(filepath.Join(src, n), []byte(c), 0o644)
	}
	env := []string{"RCLONE_CONFIG=/dev/null", "HOME=" + r.t.TempDir(), "RCLONE_CONFIG_ENCSRC_TYPE=local"}
	dst := "encsrc:" + r.remote + "/b/" + path
	if crypt {
		env = append(env, "RCLONE_CONFIG_ENCVOL_TYPE=crypt", "RCLONE_CONFIG_ENCVOL_REMOTE="+dst,
			"RCLONE_CONFIG_ENCVOL_PASSWORD="+r.obscure(pw), "RCLONE_CONFIG_ENCVOL_PASSWORD2="+r.obscure(salt),
			"RCLONE_CONFIG_ENCVOL_FILENAME_ENCRYPTION=standard", "RCLONE_CONFIG_ENCVOL_DIRECTORY_NAME_ENCRYPTION=true")
		dst = "encvol:"
	}
	cmd := exec.Command(r.rc, "sync", src, dst)
	cmd.Env = env
	if out, err := cmd.CombinedOutput(); err != nil {
		r.t.Fatalf("client push: %v %s", err, out)
	}
}

func (r *rig) obscure(s string) string {
	cmd := exec.Command(r.rc, "obscure", "-")
	cmd.Stdin = strings.NewReader(s)
	cmd.Env = []string{"RCLONE_CONFIG=/dev/null"}
	out, err := cmd.Output()
	if err != nil {
		r.t.Fatal(err)
	}
	return strings.TrimSpace(string(out))
}

func (r *rig) call(method, path, tok string, body any) (int, map[string]any) {
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, r.srv.URL+path, rd)
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		r.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func (r *rig) settle(name string) map[string]any {
	for i := 0; i < 300; i++ {
		_, st := r.call("GET", "/encvol/0xabc", r.svc.Token(), nil)
		for _, v := range st["volumes"].([]any) {
			m := v.(map[string]any)
			if m["name"] == name && m["status"] != "syncing" && m["status"] != "pushing" {
				return m
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	r.t.Fatalf("volume %s never settled", name)
	return nil
}

func TestPlaneTokenAndRoutes(t *testing.T) {
	r := newRig(t, map[string]any{"name": "docs", "bucket": "b", "path": "v"})
	tok := r.svc.Token()
	if len(tok) != 48 {
		t.Fatalf("token is %d hex chars, want 48 (192 bits)", len(tok))
	}
	for _, c := range []struct {
		method, path, tok string
		want              int
	}{
		{"GET", "/encvol/0xabc", "", 401},
		{"GET", "/encvol/0xabc", "wrong", 401},
		{"GET", "/encvol/0xabc", "\xff\xfe" + tok, 401},
		{"GET", "/encvol/0xother", tok, 404},
		{"GET", "/encvol/0xabc", tok, 200},
		{"GET", "/encvol/0xabc/unlock", tok, 200}, // the manager answers any GET on the route with the list
		{"POST", "/encvol/0xabc", tok, 405},
		{"POST", "/encvol/0xabc/unlock?x=1", tok, 404},
		{"GET", "/vms", tok, 404},
	} {
		if code, _ := r.call(c.method, c.path, c.tok, nil); code != c.want {
			t.Errorf("%s %s (token %q): %d, want %d", c.method, c.path, c.tok, code, c.want)
		}
	}
	if code, out := r.call("POST", "/encvol/0xabc/unlock", tok, map[string]any{"name": "nope", "password": "x"}); code != 404 ||
		out["error"] != "no encrypted volume 'nope' on this deployment" {
		t.Errorf("unknown volume: %d %v", code, out)
	}
	if code, out := r.call("POST", "/encvol/0xabc/unlock", tok, map[string]any{"name": "docs"}); code != 400 || out["error"] != "password required" {
		t.Errorf("no password: %d %v", code, out)
	}
	_, st := r.call("GET", "/encvol/0xabc", tok, nil)
	b, _ := json.Marshal(st)
	if strings.Contains(string(b), tok) || strings.Contains(strings.ToLower(string(b)), `"token"`) {
		t.Errorf("the public view carries the token: %s", b)
	}
}

func TestUnlockWrongKeyRightKeyPushLock(t *testing.T) {
	r := newRig(t, map[string]any{"name": "docs", "bucket": "b", "path": "v", "maxMb": 64})
	r.push("v", true, map[string]string{"hello.txt": "top secret payload\n", "sub/deep.txt": "nested secret\n"})
	tok := r.svc.Token()
	dir := filepath.Join(r.root, "docs")
	before, _ := os.Stat(dir)

	if code, _ := r.call("POST", "/encvol/0xabc/unlock", tok, map[string]any{"name": "docs", "password": "WRONG", "salt": salt}); code != 202 {
		t.Fatalf("unlock: %d", code)
	}
	v := r.settle("docs")
	if v["status"] != "locked" || !strings.Contains(fmt.Sprint(v["error"]), "did not decrypt") {
		t.Fatalf("a wrong key must leave it locked: %v", v)
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 0 {
		t.Fatalf("a failed unlock left %d entries", len(ents))
	}

	r.call("POST", "/encvol/0xabc/unlock", tok, map[string]any{"name": "docs", "password": pw, "salt": salt})
	v = r.settle("docs")
	if v["status"] != "unlocked" || v["error"] != nil {
		t.Fatalf("unlock: %v", v)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "hello.txt")); string(b) != "top secret payload\n" {
		t.Fatalf("plaintext: %q", b)
	}
	after, _ := os.Stat(dir)
	if !os.SameFile(before, after) {
		t.Fatal("the preopened directory was replaced; it must stay the same inode (a live preopen)")
	}

	// the app edits, then pushes; an independent client pull decrypts the edit
	os.WriteFile(filepath.Join(dir, "written-in-guest.txt"), []byte("app-written data\n"), 0o644)
	if code, _ := r.call("POST", "/encvol/0xabc/sync", tok, map[string]any{"name": "docs"}); code != 202 {
		t.Fatalf("sync: %d", code)
	}
	v = r.settle("docs")
	if v["status"] != "unlocked" || v["error"] != nil || v["lastPush"] == nil {
		t.Fatalf("push: %v", v)
	}
	pulled := t.TempDir()
	cmd := exec.Command(r.rc, "sync", "encvol:", pulled)
	cmd.Env = []string{"RCLONE_CONFIG=/dev/null", "RCLONE_CONFIG_ENCSRC_TYPE=local", "RCLONE_CONFIG_ENCVOL_TYPE=crypt",
		"RCLONE_CONFIG_ENCVOL_REMOTE=encsrc:" + r.remote + "/b/v", "RCLONE_CONFIG_ENCVOL_PASSWORD=" + r.obscure(pw),
		"RCLONE_CONFIG_ENCVOL_PASSWORD2=" + r.obscure(salt), "HOME=" + t.TempDir()}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("independent pull: %v %s", err, out)
	}
	if b, _ := os.ReadFile(filepath.Join(pulled, "written-in-guest.txt")); string(b) != "app-written data\n" {
		t.Fatalf("the pushed edit does not decrypt client-side: %q", b)
	}
	// the bucket holds ciphertext only
	filepath.Walk(filepath.Join(r.remote, "b"), func(p string, fi os.FileInfo, err error) error {
		if err == nil && fi.Mode().IsRegular() {
			if b, _ := os.ReadFile(p); bytes.Contains(b, []byte("secret")) || bytes.Contains(b, []byte("app-written")) {
				t.Errorf("plaintext in the bucket: %s", p)
			}
			if strings.Contains(p, "hello") || strings.Contains(p, "written") {
				t.Errorf("a plaintext name in the bucket: %s", p)
			}
		}
		return nil
	})

	// busy refusals, from the status machine itself
	r.svc.mu.Lock()
	r.svc.vols["docs"].pub.Status = "syncing"
	r.svc.mu.Unlock()
	if code, out := r.call("POST", "/encvol/0xabc/lock", tok, map[string]any{"name": "docs"}); code != 409 || out["error"] != "volume is busy (syncing)" {
		t.Errorf("lock while syncing: %d %v", code, out)
	}
	if code, _ := r.call("POST", "/encvol/0xabc/unlock", tok, map[string]any{"name": "docs", "password": pw}); code != 409 {
		t.Errorf("unlock while syncing: %d", code)
	}
	r.svc.mu.Lock()
	r.svc.vols["docs"].pub.Status = "unlocked"
	r.svc.mu.Unlock()

	if code, out := r.call("POST", "/encvol/0xabc/lock", tok, map[string]any{"name": "docs"}); code != 200 || out["status"] != "locked" {
		t.Fatalf("lock: %d %v", code, out)
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 0 {
		t.Fatalf("lock left %d entries", len(ents))
	}
	if code, out := r.call("POST", "/encvol/0xabc/sync", tok, map[string]any{"name": "docs"}); code != 409 || out["error"] != "volume is locked, not unlocked" {
		t.Errorf("sync when locked: %d %v", code, out)
	}
	for _, l := range r.logs {
		if strings.Contains(l, pw) || strings.Contains(l, salt) || strings.Contains(l, "secret payload") || strings.Contains(l, tok) {
			t.Errorf("a console line carries a secret or plaintext: %q", l)
		}
	}
}

func TestPlainAndReadOnly(t *testing.T) {
	r := newRig(t, map[string]any{"name": "pub", "bucket": "b", "path": "p", "encrypted": false},
		map[string]any{"name": "ro", "bucket": "b", "path": "r", "readOnly": true})
	r.push("p", false, map[string]string{"readme.txt": "plain payload\n"})
	r.push("r", true, map[string]string{"x.txt": "read only\n"})
	tok := r.svc.Token()
	if code, out := r.call("POST", "/encvol/0xabc/unlock", tok, map[string]any{"name": "pub", "password": "oops"}); code != 400 ||
		!strings.Contains(fmt.Sprint(out["error"]), "is plain") {
		t.Errorf("password on a plain volume: %d %v", code, out)
	}
	r.call("POST", "/encvol/0xabc/unlock", tok, map[string]any{"name": "pub"})
	if v := r.settle("pub"); v["status"] != "unlocked" || v["encrypted"] != false {
		t.Fatalf("plain unlock: %v", v)
	}
	if b, _ := os.ReadFile(filepath.Join(r.root, "pub", "readme.txt")); string(b) != "plain payload\n" {
		t.Fatalf("plain bytes: %q", b)
	}
	os.WriteFile(filepath.Join(r.root, "pub", "from-guest.txt"), []byte("plain push-back\n"), 0o644)
	r.call("POST", "/encvol/0xabc/sync", tok, map[string]any{"name": "pub"})
	r.settle("pub")
	if b, _ := os.ReadFile(filepath.Join(r.remote, "b", "p", "from-guest.txt")); string(b) != "plain push-back\n" {
		t.Fatalf("a plain push lands verbatim: %q", b)
	}
	r.call("POST", "/encvol/0xabc/unlock", tok, map[string]any{"name": "ro", "password": pw, "salt": salt})
	if v := r.settle("ro"); v["status"] != "unlocked" {
		t.Fatalf("read-only unlock: %v", v)
	}
	if code, out := r.call("POST", "/encvol/0xabc/sync", tok, map[string]any{"name": "ro"}); code != 403 ||
		out["error"] != "read-only volume: no credentials retained for push" {
		t.Errorf("push on a read-only volume: %d %v", code, out)
	}
}

func TestCapsOnPullAndAfterUnlock(t *testing.T) {
	r := newRig(t, map[string]any{"name": "small", "bucket": "b", "path": "s", "maxMb": 1})
	big := strings.Repeat("x", 3<<20)
	r.push("s", true, map[string]string{"big.bin": big})
	tok := r.svc.Token()
	r.call("POST", "/encvol/0xabc/unlock", tok, map[string]any{"name": "small", "password": pw, "salt": salt})
	if v := r.settle("small"); v["status"] != "locked" || v["error"] == nil {
		t.Fatalf("a pull over maxMb must fail (--max-transfer): %v", v)
	}
	if ents, _ := os.ReadDir(filepath.Join(r.root, "small")); len(ents) != 0 {
		t.Fatalf("a capped pull left %d entries", len(ents))
	}
	// a volume that unlocks within its cap, then grows past it: the audit ends the app
	r2 := newRig(t, map[string]any{"name": "grow", "bucket": "b", "path": "g", "maxMb": 1})
	r2.push("g", true, map[string]string{"seed.txt": "seed\n"})
	r2.call("POST", "/encvol/0xabc/unlock", r2.svc.Token(), map[string]any{"name": "grow", "password": pw, "salt": salt})
	if v := r2.settle("grow"); v["status"] != "unlocked" {
		t.Fatalf("unlock: %v", v)
	}
	r2.svc.Audit()
	if len(r2.killed) != 0 {
		t.Fatalf("killed within the cap: %v", r2.killed)
	}
	os.WriteFile(filepath.Join(r2.root, "grow", "runaway.bin"), []byte(strings.Repeat("y", 2<<20)), 0o644)
	r2.svc.Audit()
	time.Sleep(100 * time.Millisecond)
	r2.mu.Lock()
	defer r2.mu.Unlock()
	if len(r2.killed) != 1 || !strings.Contains(r2.killed[0], "over its 1MiB cap (encVolumes maxMb); app killed.") {
		t.Fatalf("the audit must end the app once: %v", r2.killed)
	}
}
