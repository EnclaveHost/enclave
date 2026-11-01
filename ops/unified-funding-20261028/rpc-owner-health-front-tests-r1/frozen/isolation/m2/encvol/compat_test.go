package encvol

// The native engine against the format and protocol it must interoperate with, the REAL pinned rclone v1.67.0
// (ENCVOL_RCLONE): every filename mode, directory-name encryption on and off, with and without a salt, multi-block,
// empty and non-ASCII files, nanosecond modtimes; rclone pushes and the engine pulls, the engine pushes and rclone
// pulls, and every name the engine writes is the one rclone's own `cryptdecode --reverse` computes. Over S3 the far
// side is `rclone serve s3` (a real S3 server on a local directory): SigV4, anonymous access, wrong credentials,
// the endpoint going away, and a fresh service recovering the same ciphertext from an independent endpoint.

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"enclave.host/isolation/m2/encvol/rclonecrypt"
)

type fixture map[string][]byte

func sampleTree() fixture {
	big := make([]byte, 200<<10+17) // four secretbox blocks and a ragged tail
	rand.Read(big)
	exact := bytes.Repeat([]byte{'z'}, 64<<10)
	return fixture{
		"a.txt":                    []byte("alpha secret\n"),
		"dir/sub/b.bin":            big,
		"empty":                    {},
		"exact64k":                 exact,
		"ünï cödé/ファイル.txt":        []byte("unicode secret\n"),
		"dir/with space/c d.txt":   []byte("spaced secret\n"),
		"dir/sub/deeper/z.json":    []byte(`{"k":"secret"}`),
		"name.with.dots.tar.gz.md": []byte("dots secret\n"),
	}
}

// write lays a fixture out with distinct nanosecond modtimes.
func (f fixture) write(t *testing.T, dir string) {
	t.Helper()
	base := time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)
	names := f.names()
	for i, n := range names {
		p := filepath.Join(dir, filepath.FromSlash(n))
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, f[n], 0o644); err != nil {
			t.Fatal(err)
		}
		mt := base.Add(time.Duration(i)*time.Hour + time.Duration(123456789+i))
		os.Chtimes(p, mt, mt)
	}
}

func (f fixture) names() []string {
	var l []string
	for n := range f {
		l = append(l, n)
	}
	sort.Strings(l)
	return l
}

// sameTree: the same regular files with the same bytes and (if mtimes) the same nanosecond modtimes.
func sameTree(t *testing.T, what, a, b string, mtimes bool) {
	t.Helper()
	list := func(root string) map[string]os.FileInfo {
		m := map[string]os.FileInfo{}
		filepath.Walk(root, func(p string, fi os.FileInfo, err error) error {
			if err == nil && fi.Mode().IsRegular() {
				rel, _ := filepath.Rel(root, p)
				m[filepath.ToSlash(rel)] = fi
			}
			return nil
		})
		return m
	}
	la, lb := list(a), list(b)
	if len(la) != len(lb) {
		t.Errorf("%s: %d files vs %d (%v vs %v)", what, len(la), len(lb), keys(la), keys(lb))
	}
	for n, fa := range la {
		fb, ok := lb[n]
		if !ok {
			t.Errorf("%s: %s missing", what, n)
			continue
		}
		ba, _ := os.ReadFile(filepath.Join(a, n))
		bb, _ := os.ReadFile(filepath.Join(b, n))
		if !bytes.Equal(ba, bb) {
			t.Errorf("%s: %s differs", what, n)
		}
		if mtimes && !fa.ModTime().Equal(fb.ModTime()) {
			t.Errorf("%s: %s modtime %v vs %v", what, n, fa.ModTime().UTC(), fb.ModTime().UTC())
		}
	}
}

func keys(m map[string]os.FileInfo) []string {
	var l []string
	for k := range m {
		l = append(l, k)
	}
	sort.Strings(l)
	return l
}

type rcloneSide struct {
	t   *testing.T
	bin string
	env []string
}

// cryptEnv is scripts/enclave-encvol.sh's environment for a crypt remote "encvol:" over "encsrc:<src>".
func newRclone(t *testing.T, srcEnv []string, src string, crypt bool, mode string, dirEnc bool, password, salt string) *rcloneSide {
	r := &rcloneSide{t: t, bin: rcloneBin(t)}
	r.env = append([]string{"RCLONE_CONFIG=/dev/null", "HOME=" + t.TempDir()}, srcEnv...)
	if crypt {
		denc := "false"
		if dirEnc {
			denc = "true"
		}
		r.env = append(r.env, "RCLONE_CONFIG_ENCVOL_TYPE=crypt", "RCLONE_CONFIG_ENCVOL_REMOTE="+src,
			"RCLONE_CONFIG_ENCVOL_PASSWORD="+r.obscure(password), "RCLONE_CONFIG_ENCVOL_FILENAME_ENCRYPTION="+mode,
			"RCLONE_CONFIG_ENCVOL_DIRECTORY_NAME_ENCRYPTION="+denc)
		if salt != "" {
			r.env = append(r.env, "RCLONE_CONFIG_ENCVOL_PASSWORD2="+r.obscure(salt))
		}
	}
	return r
}

func (r *rcloneSide) obscure(s string) string {
	cmd := exec.Command(r.bin, "obscure", "-")
	cmd.Stdin = strings.NewReader(s)
	cmd.Env = []string{"RCLONE_CONFIG=/dev/null"}
	out, err := cmd.Output()
	if err != nil {
		r.t.Fatal(err)
	}
	return strings.TrimSpace(string(out))
}

func (r *rcloneSide) run(args ...string) string {
	r.t.Helper()
	cmd := exec.Command(r.bin, args...)
	cmd.Env = r.env
	var errb bytes.Buffer
	cmd.Stderr = &errb
	out, err := cmd.Output()
	if err != nil {
		r.t.Fatalf("rclone %v: %v\n%s", args, err, errb.String())
	}
	return string(out)
}

// TestFormatMatrixAgainstRclone: both directions, every crypt variant, on rclone's local backend.
func TestFormatMatrixAgainstRclone(t *testing.T) {
	rcloneBin(t)
	for _, mode := range []string{"standard", "off", "obfuscate"} {
		for _, dirEnc := range []bool{true, false} {
			for _, sl := range []string{"", "sodium chloride"} {
				t.Run(fmt.Sprintf("%s/dirEnc=%v/salt=%v", mode, dirEnc, sl != ""), func(t *testing.T) {
					formatRoundTrip(t, mode, dirEnc, sl)
				})
			}
		}
	}
}

func formatRoundTrip(t *testing.T, mode string, dirEnc bool, sl string) {
	ctx := context.Background()
	bucket := t.TempDir()
	srcRoot := filepath.Join(bucket, "b", "vol")
	rc := newRclone(t, []string{"RCLONE_CONFIG_ENCSRC_TYPE=local"}, "encsrc:"+srcRoot, true, mode, dirEnc, pw, sl)
	owner := t.TempDir()
	fx := sampleTree()
	fx.write(t, owner)
	rc.run("sync", owner, "encvol:")

	ci, err := rclonecrypt.New(mode, dirEnc, pw, sl)
	if err != nil {
		t.Fatal(err)
	}
	rm := &remote{st: &localStore{root: srcRoot}, cipher: ci}
	guest := t.TempDir()
	res, err := pull(ctx, rm, tree{dir: guest, uid: -1, gid: -1}, 0)
	if err != nil || res.undecryptable != 0 {
		t.Fatalf("pull of rclone's push: %v (undecryptable %d)", err, res.undecryptable)
	}
	sameTree(t, "rclone push -> native pull", owner, guest, true)

	// a second pull changes nothing (size+modtime equal: no transfer)
	before := snapshotMtimes(guest)
	if _, err := pull(ctx, rm, tree{dir: guest, uid: -1, gid: -1}, 0); err != nil {
		t.Fatal(err)
	}
	if after := snapshotMtimes(guest); fmt.Sprint(after) != fmt.Sprint(before) {
		t.Errorf("an idempotent pull rewrote files")
	}

	// the app edits, deletes and adds; the native push; rclone pulls the same tree
	os.WriteFile(filepath.Join(guest, "a.txt"), []byte("alpha edited in the guest\n"), 0o644)
	os.Remove(filepath.Join(guest, "empty"))
	os.MkdirAll(filepath.Join(guest, "n", "m"), 0o755)
	os.WriteFile(filepath.Join(guest, "n", "m", "new file.txt"), []byte("new guest secret\n"), 0o644)
	if _, err := push(ctx, rm, tree{dir: guest, uid: -1, gid: -1}); err != nil {
		t.Fatalf("native push: %v", err)
	}
	back := t.TempDir()
	rc.run("sync", "encvol:", back)
	sameTree(t, "native push -> rclone pull", guest, back, true)

	// every object name is the one rclone computes for that path
	for _, plain := range []string{"a.txt", "n/m/new file.txt", "ünï cödé/ファイル.txt"} {
		out := rc.run("cryptdecode", "--reverse", "encvol:", plain)
		parts := strings.Split(strings.TrimSpace(out), "\t")
		want := strings.TrimSpace(parts[len(parts)-1])
		if got := ci.EncryptFileName(plain); got != want {
			t.Errorf("name of %q: native %q, rclone %q", plain, got, want)
		}
		if _, err := os.Stat(filepath.Join(srcRoot, filepath.FromSlash(want))); err != nil {
			t.Errorf("rclone's name for %q is not in the bucket: %v", plain, err)
		}
	}

	// no plaintext byte string and (unless names are "off") no plaintext name in the bucket
	filepath.Walk(srcRoot, func(p string, fi os.FileInfo, err error) error {
		if err != nil || !fi.Mode().IsRegular() {
			return nil
		}
		b, _ := os.ReadFile(p)
		if bytes.Contains(b, []byte("secret")) {
			t.Errorf("plaintext in %s", p)
		}
		if mode != "off" && (strings.Contains(p, "a.txt") || strings.Contains(p, "new file")) {
			t.Errorf("plaintext name in the bucket: %s", p)
		}
		return nil
	})

	// a wrong password: standard names do not decrypt; "off" names carry no key and obfuscated names are reversible
	// without authentication (rclone's own semantics), so there the first block does not authenticate
	bad, _ := rclonecrypt.New(mode, dirEnc, "WRONG", sl)
	res, err = pull(ctx, &remote{st: &localStore{root: srcRoot}, cipher: bad}, tree{dir: t.TempDir(), uid: -1, gid: -1}, 0)
	if mode == "off" || mode == "obfuscate" {
		if err == nil || !strings.Contains(err.Error(), "failed to authenticate decrypted block") {
			t.Errorf("wrong key under %s: %v", mode, err)
		}
	} else if res.undecryptable == 0 {
		t.Errorf("wrong key: every name decrypted (%v)", err)
	}
}

func snapshotMtimes(dir string) map[string]int64 {
	m := map[string]int64{}
	filepath.Walk(dir, func(p string, fi os.FileInfo, err error) error {
		if err == nil && fi.Mode().IsRegular() {
			m[p] = fi.ModTime().UnixNano()
		}
		return nil
	})
	return m
}

func TestModTimeFormatIsSwifts(t *testing.T) {
	for ns, want := range map[int64]string{0: "0", 1e9: "1", 1_500_000_000: "1.5", 123: "0.000000123",
		1772600767_123456789: "1772600767.123456789", 1772600767_100000000: "1772600767.1", -1_500_000_000: "-1.5"} {
		if got := nsToFloatString(ns); got != want {
			t.Errorf("nsToFloatString(%d) = %q, want %q", ns, got, want)
		}
		if ns >= 0 {
			if back, err := floatStringToNs(want); err != nil || back != ns {
				t.Errorf("floatStringToNs(%q) = %d, %v", want, back, err)
			}
		}
	}
	if ns, _ := floatStringToNs("12.3456789019"); ns != 12_345678901 {
		t.Errorf("a long fraction truncates to ns: %d", ns)
	}
}

// TestTreeStaysBeneathTheVolume: what the app plants (symlinks out of the volume) never makes the root-run engine
// read or write outside it.
func TestTreeStaysBeneathTheVolume(t *testing.T) {
	ctx := context.Background()
	outside := t.TempDir()
	os.WriteFile(filepath.Join(outside, "host-secret"), []byte("OUTSIDE BYTES"), 0o600)
	vol := t.TempDir()
	os.WriteFile(filepath.Join(vol, "ok.txt"), []byte("fine"), 0o644)
	os.Symlink(filepath.Join(outside, "host-secret"), filepath.Join(vol, "leak"))
	os.Symlink(outside, filepath.Join(vol, "sd"))
	bucket := t.TempDir()
	rm := &remote{st: &localStore{root: bucket}}
	if _, err := push(ctx, rm, tree{dir: vol, uid: -1, gid: -1}); err != nil {
		t.Fatalf("push: %v", err)
	}
	filepath.Walk(bucket, func(p string, fi os.FileInfo, err error) error {
		if err == nil && fi.Mode().IsRegular() {
			if b, _ := os.ReadFile(p); bytes.Contains(b, []byte("OUTSIDE")) {
				t.Errorf("a symlink's target was pushed: %s", p)
			}
		}
		return nil
	})
	// a remote file under the symlinked directory's name: the pull refuses to write through it
	os.MkdirAll(filepath.Join(bucket, "sd"), 0o755)
	os.WriteFile(filepath.Join(bucket, "sd", "planted"), []byte("x"), 0o644)
	_, err := pull(ctx, rm, tree{dir: vol, uid: -1, gid: -1}, 0)
	if err == nil {
		t.Errorf("a pull through an app-planted symlink succeeded")
	}
	if _, e := os.Stat(filepath.Join(outside, "planted")); e == nil {
		t.Fatalf("the pull wrote outside the volume")
	}
	if b, _ := os.ReadFile(filepath.Join(outside, "host-secret")); string(b) != "OUTSIDE BYTES" {
		t.Fatalf("outside file changed")
	}
}

// ---- S3: rclone serve s3 ----------------------------------------------------------------------------------------------

type s3srv struct {
	cmd  *exec.Cmd
	addr string
	dir  string
}

func freePort(t *testing.T) string {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	a := l.Addr().String()
	l.Close()
	return a
}

// serveS3 runs `rclone serve s3` on dir (top-level directories are buckets); auth "" = anonymous.
func serveS3(t *testing.T, dir, auth string) *s3srv {
	s := &s3srv{addr: freePort(t), dir: dir}
	args := []string{"serve", "s3", dir, "--addr", s.addr, "--log-level", "ERROR"}
	if auth != "" {
		args = append(args, "--auth-key", auth)
	}
	s.cmd = exec.Command(rcloneBin(t), args...)
	s.cmd.Env = []string{"RCLONE_CONFIG=/dev/null", "HOME=" + t.TempDir()}
	var errb bytes.Buffer
	s.cmd.Stderr = &errb
	if err := s.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.stop)
	for i := 0; i < 200; i++ {
		if c, err := net.Dial("tcp", s.addr); err == nil {
			c.Close()
			return s
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("rclone serve s3 did not start: %s", errb.String())
	return nil
}

func (s *s3srv) stop() {
	if s.cmd.Process != nil {
		s.cmd.Process.Kill()
		s.cmd.Wait()
	}
}

func s3Env(addr, ak, sk string) []string {
	e := []string{"RCLONE_CONFIG_ENCSRC_TYPE=s3", "RCLONE_CONFIG_ENCSRC_PROVIDER=Other", "RCLONE_CONFIG_ENCSRC_ENDPOINT=http://" + addr}
	if ak != "" {
		return append(e, "RCLONE_CONFIG_ENCSRC_ACCESS_KEY_ID="+ak, "RCLONE_CONFIG_ENCSRC_SECRET_ACCESS_KEY="+sk)
	}
	return append(e, "RCLONE_CONFIG_ENCSRC_ENV_AUTH=false")
}

const testAK, testSK = "AKIAFIXTUREONLY0001", "fixture-secret-key-not-real-0001"

func s3Service(t *testing.T, addr string, extra map[string]any) (*rig, map[string]any) {
	vol := map[string]any{"name": "docs", "endpoint": "http://" + addr, "bucket": "bkt", "path": "vol/p", "maxMb": 64}
	for k, v := range extra {
		vol[k] = v
	}
	r := &rig{t: t, root: t.TempDir()}
	b, _ := json.Marshal(map[string]any{"encVolumes": []any{vol}})
	specs, err := Parse(string(b), ParseOptions{TestLoopbackHTTP: true})
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
	return r, vol
}

func TestS3AgainstRcloneServe(t *testing.T) {
	rcloneBin(t)
	data := t.TempDir()
	os.MkdirAll(filepath.Join(data, "bkt"), 0o755)
	srv := serveS3(t, data, testAK+","+testSK)
	owner := t.TempDir()
	fx := sampleTree()
	fx.write(t, owner)
	rc := newRclone(t, s3Env(srv.addr, testAK, testSK), "encsrc:bkt/vol/p", true, "standard", true, pw, salt)
	rc.run("sync", owner, "encvol:")

	r, _ := s3Service(t, srv.addr, nil)
	tok := r.svc.Token()
	unlock := func(body map[string]any) map[string]any {
		body["name"] = "docs"
		if code, out := r.call("POST", "/encvol/0xabc/unlock", tok, body); code != 202 {
			t.Fatalf("unlock: %d %v", code, out)
		}
		return r.settle("docs")
	}
	// wrong S3 secret: SigV4 refused, nothing pulled
	if v := unlock(map[string]any{"password": pw, "salt": salt, "accessKeyId": testAK, "secretAccessKey": "wrong"}); v["status"] != "locked" || v["error"] == nil {
		t.Fatalf("a wrong S3 secret unlocked: %v", v)
	}
	// wrong volume password over S3: the runtime's wrong-key message
	if v := unlock(map[string]any{"password": "WRONG", "salt": salt, "accessKeyId": testAK, "secretAccessKey": testSK}); v["status"] != "locked" ||
		v["error"] != undecryptableMsg {
		t.Fatalf("a wrong key over S3: %v", v)
	}
	if v := unlock(map[string]any{"password": pw, "salt": salt, "accessKeyId": testAK, "secretAccessKey": testSK}); v["status"] != "unlocked" {
		t.Fatalf("unlock over S3: %v", v)
	}
	guest := filepath.Join(r.root, "docs")
	sameTree(t, "rclone s3 push -> native s3 pull", owner, guest, true)

	os.WriteFile(filepath.Join(guest, "a.txt"), []byte("edited over s3\n"), 0o644)
	os.WriteFile(filepath.Join(guest, "fresh.txt"), []byte("fresh over s3\n"), 0o644)
	os.Remove(filepath.Join(guest, "exact64k"))
	r.call("POST", "/encvol/0xabc/sync", tok, map[string]any{"name": "docs"})
	if v := r.settle("docs"); v["error"] != nil || v["lastPush"] == nil {
		t.Fatalf("push over S3: %v", v)
	}
	back := t.TempDir()
	rc.run("sync", "encvol:", back)
	sameTree(t, "native s3 push -> rclone s3 pull", guest, back, true)
	// rclone reads the modtime the engine stored (its own X-Amz-Meta-Mtime), to the nanosecond
	lsl := rc.run("lsl", "encvol:fresh.txt")
	fi, _ := os.Stat(filepath.Join(guest, "fresh.txt"))
	if !strings.Contains(lsl, fi.ModTime().Format("2006-01-02 15:04:05.000000000")) {
		t.Errorf("rclone sees another modtime: %q vs %v", lsl, fi.ModTime())
	}

	// an independent endpoint: the owner replicates the bucket's CIPHERTEXT to another S3 service with their own
	// rclone (objects and their mtime metadata, byte for byte), while the first endpoint is still up
	mirror := t.TempDir()
	os.MkdirAll(filepath.Join(mirror, "bkt"), 0o755)
	srv2 := serveS3(t, mirror, "AKIAOTHERFIXTURE002,other-fixture-secret-2")
	repl := &rcloneSide{t: t, bin: rcloneBin(t), env: append([]string{"RCLONE_CONFIG=/dev/null", "HOME=" + t.TempDir(),
		"RCLONE_CONFIG_REPLICA_TYPE=s3", "RCLONE_CONFIG_REPLICA_PROVIDER=Other", "RCLONE_CONFIG_REPLICA_ENDPOINT=http://" + srv2.addr,
		"RCLONE_CONFIG_REPLICA_ACCESS_KEY_ID=AKIAOTHERFIXTURE002", "RCLONE_CONFIG_REPLICA_SECRET_ACCESS_KEY=other-fixture-secret-2"},
		s3Env(srv.addr, testAK, testSK)...)}
	repl.run("sync", "encsrc:bkt", "replica:bkt")
	if a, b := fileTreeBytes(filepath.Join(data, "bkt")), fileTreeBytes(filepath.Join(mirror, "bkt")); fmt.Sprint(a) != fmt.Sprint(b) || len(a) == 0 {
		t.Fatalf("the replica is not the identical ciphertext (%d vs %d objects)", len(a), len(b))
	}

	// the endpoint goes away: a push fails and keeps the plaintext; an unlock fails and leaves nothing
	srv.stop()
	r.call("POST", "/encvol/0xabc/sync", tok, map[string]any{"name": "docs"})
	if v := r.settle("docs"); v["status"] != "unlocked" || v["error"] == nil {
		t.Fatalf("a push to a dead endpoint: %v", v)
	}
	if b, _ := os.ReadFile(filepath.Join(guest, "fresh.txt")); string(b) != "fresh over s3\n" {
		t.Fatal("a failed push lost the plaintext")
	}
	r2, _ := s3Service(t, srv.addr, nil)
	r2.call("POST", "/encvol/0xabc/unlock", r2.svc.Token(), map[string]any{"name": "docs", "password": pw, "salt": salt, "accessKeyId": testAK, "secretAccessKey": testSK})
	if v := r2.settle("docs"); v["status"] != "locked" || v["error"] == nil {
		t.Fatalf("an unlock from a dead endpoint: %v", v)
	}

	// the independent endpoint serving the identical ciphertext: a fresh service recovers the same plaintext
	r3, _ := s3Service(t, srv2.addr, nil)
	r3.call("POST", "/encvol/0xabc/unlock", r3.svc.Token(), map[string]any{"name": "docs", "password": pw, "salt": salt,
		"accessKeyId": "AKIAOTHERFIXTURE002", "secretAccessKey": "other-fixture-secret-2"})
	if v := r3.settle("docs"); v["status"] != "unlocked" {
		t.Fatalf("recovery from the independent endpoint: %v", v)
	}
	sameTree(t, "recovered on a fresh service", back, filepath.Join(r3.root, "docs"), true)

	for _, rr := range []*rig{r, r2, r3} {
		for _, l := range rr.logs {
			if strings.Contains(l, pw) || strings.Contains(l, salt) || strings.Contains(l, testSK) || strings.Contains(l, "secret") {
				t.Errorf("a console line carries a secret: %q", l)
			}
		}
	}
}

func TestS3AnonymousPlainVolume(t *testing.T) {
	rcloneBin(t)
	data := t.TempDir()
	os.MkdirAll(filepath.Join(data, "bkt"), 0o755)
	srv := serveS3(t, data, "")
	owner := t.TempDir()
	fixture{"pub/readme.txt": []byte("public plain bytes\n")}.write(t, owner)
	rc := newRclone(t, s3Env(srv.addr, "", ""), "encsrc:bkt/vol/p", false, "", false, "", "")
	rc.run("sync", owner, "encsrc:bkt/vol/p")
	r, _ := s3Service(t, srv.addr, map[string]any{"encrypted": false, "readOnly": true})
	r.call("POST", "/encvol/0xabc/unlock", r.svc.Token(), map[string]any{"name": "docs"})
	if v := r.settle("docs"); v["status"] != "unlocked" {
		t.Fatalf("anonymous plain unlock: %v", v)
	}
	sameTree(t, "anonymous plain", owner, filepath.Join(r.root, "docs"), true)
	if b, _ := os.ReadFile(filepath.Join(data, "bkt", "vol", "p", "pub", "readme.txt")); string(b) != "public plain bytes\n" {
		t.Fatalf("a plain volume is stored verbatim: %q", b)
	}
}

// fileTreeBytes: relative path -> sha256 of every regular file (the exact ciphertext a bucket holds).
func fileTreeBytes(dir string) map[string]string {
	m := map[string]string{}
	filepath.Walk(dir, func(p string, fi os.FileInfo, err error) error {
		if err == nil && fi.Mode().IsRegular() {
			rel, _ := filepath.Rel(dir, p)
			b, _ := os.ReadFile(p)
			m[filepath.ToSlash(rel)] = fmt.Sprintf("%x", sha256.Sum256(b))
		}
		return nil
	})
	return m
}
