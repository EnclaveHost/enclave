// Package encvol is encrypted volumes (rclone crypt over S3) inside a per-app measured guest: the standard runtime's
// feature (wasm/wasm_manager.py: _parse_enc_volumes, the /encvol tenant plane, _enc_rclone_env/_enc_rclone_sync,
// _audit_enc) moved into the guest, where the key and the plaintext can exist without the host.
//
// What is the SAME as the standard runtime, by construction:
//   - the config: encVolumes entries, every field, every default and every refusal (Parse);
//   - the format: rclone crypt (rclone v1.67.0's own cipher code, vendored unchanged in rclonecrypt) over S3, keyed
//     from the password and salt as rclone keys it, with rclone's S3 modtime metadata, so a volume pushed by
//     scripts/enclave-encvol.sh or pulled by the standard tier opens here, and the reverse; plain ("encrypted": false)
//     volumes sync the bytes verbatim; the sync makes rclone sync's decisions (sync.go);
//   - the tenant plane: GET /encvol/<vid>, POST /encvol/<vid>/{unlock|sync|lock}, the token (X-Enc-Token or Bearer,
//     compared as bytes in constant time), the statuses locked/syncing/unlocked/pushing, the JSON, the codes;
//   - the guest contract: an EMPTY /enc/<name> live preopen from the start, plaintext appearing in it after unlock
//     with no app restart, ENCLAVE_ENC / ENCLAVE_ENC_API / ENCLAVE_ENC_TOKEN in the app's environment;
//   - the caps: --max-transfer on the pull, then a measure-and-kill audit of what the app writes afterwards;
//   - wallet mode, keyId and credsEnvelope: UI metadata the app and the owner's browser handle; this package takes
//     an opaque password like the manager does.
//
// What differs in a direct guest, stated rather than hidden:
//   - an endpoint must be https:// on port 443 with a DNS host: the guest's only way out is the measured egress
//     path (isolation/m2/egress), which carries nothing else. The host re-checks every final address against the
//     private/loopback/link-local/metadata refusals (the standard tier's SSRF guard, enforced one hop later);
//   - each volume is its own tmpfs, sized a little above maxMb, so a runaway write cannot take the guest's memory
//     before the audit sees it; the audit still kills the app at maxMb, as the standard tier does;
//   - the sync engine is native (store.go, sync.go) rather than the 61.6 MB rclone binary, which does not fit a guest
//     sized to its app; it runs in the front and touches the volume only through openat2 beneath the volume
//     (fsx.go), creating files as the app's uid, as rclone running as that uid did.
//
// Secrets: the password, salt and S3 credentials exist in this process's memory for one request; push-back keeps the
// derived cipher and the S3 credentials in memory until lock (or a re-unlock), which zeroes the keys. None of them is
// logged, persisted, or sent anywhere but (the S3 credentials, as SigV4 signatures) the endpoint.
package encvol

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"enclave.host/isolation/m2/encvol/rclonecrypt"
	"enclave.host/isolation/m2/encvol/spec"
)

// The config rules live in encvol/spec (standard library only, shared with the partition monitor); these are its names.
const (
	DefMB           = spec.DefMB
	MaxMB           = spec.MaxMB
	MaxVols         = spec.MaxVols
	GuestRoot       = spec.GuestRoot
	GuestReserveMiB = spec.GuestReserveMiB
	SyncTimeout     = 1800 * time.Second // WASM_ENC_SYNC_TIMEOUT
)

type (
	Spec         = spec.Spec
	ParseOptions = spec.ParseOptions
)

func Parse(config string, o ParseOptions) ([]Spec, error) { return spec.Parse(config, o) }
func ParseLayout(config string) ([]Spec, error)           { return spec.ParseLayout(config) }
func SameLayout(a, b []Spec) bool                         { return spec.SameLayout(a, b) }
func TmpfsMiB(maxMB int) int                              { return spec.TmpfsMiB(maxMB) }

// ---- the running service ------------------------------------------------------------------------------------------

// Options configures a Service. The front fills it for a guest (front/encvol.go); tests fill it for the test host.
type Options struct {
	Root     string                            // the staging root: GuestRoot in a guest, a temp dir in tests
	UID, GID int                               // the volumes' owner (what a pull creates is the app's); -1 = unchanged
	Mount    func(dir string, maxMB int) error // a sized tmpfs per volume in a guest; nil = a plain directory
	Kill     func(reason string)               // the audit's sanction: end the app (the front kills it; init ends the domain)
	Logf     func(string, ...any)              // console lines: volume name and outcome only, never an error text
	Timeout  time.Duration                     // one pull/push; 0 = SyncTimeout
	Parse    ParseOptions                      // test hooks; zero in a guest
	Roots    *x509.CertPool                    // S3 TLS roots; nil = the embedded public roots (PublicRoots)
	// Shared: the volumes are shared by group with the app (a Hyper-V partition's front is not root and cannot chown):
	// what a pull creates is group read-write (files 0660, directories 02770), and the front ends the domain instead
	// of killing the app. Off in an SNP guest, whose root front creates as the app's uid.
	Shared bool
	// Dial is for tests only: reach a fixture (a guest dials the endpoint's name, which /etc/hosts maps to its forwarder)
	Dial func(ctx context.Context, network, addr string) (net.Conn, error)
}

type pub struct {
	Name      string   `json:"name"`
	Status    string   `json:"status"`
	Error     *string  `json:"error"`
	Bytes     int64    `json:"bytes"`
	MaxMb     int      `json:"maxMb"`
	ReadOnly  bool     `json:"readOnly"`
	Endpoint  string   `json:"endpoint"`
	Bucket    string   `json:"bucket"`
	Path      string   `json:"path"`
	Unlock    string   `json:"unlock"`
	KeyID     string   `json:"keyId"`
	Encrypted bool     `json:"encrypted"`
	LastPush  *float64 `json:"lastPush,omitempty"`
}

type volume struct {
	spec Spec
	dir  string
	rm   *remote // the store and cipher kept for push-back after unlock; nil when locked or readOnly
	pub  pub
}

// Service is one deployment's volumes and its tenant plane.
type Service struct {
	vid   string
	token string
	o     Options
	mu    sync.Mutex
	vols  map[string]*volume
	order []string
	dead  bool // the audit killed the app
}

// New stages one EMPTY directory per volume (a sized tmpfs in a guest) and mints the deployment's token. Like the
// manager, a staging failure is a failed launch: an app deployed around a volume never runs without the mount.
func New(vid string, specs []Spec, o Options) (*Service, error) {
	if o.Timeout <= 0 {
		o.Timeout = SyncTimeout
	}
	if o.Logf == nil {
		o.Logf = func(string, ...any) {}
	}
	if o.Kill == nil {
		return nil, errors.New("encvol: no way to end the app (Kill) was given; the caps could not be enforced")
	}
	tok := make([]byte, 24) // 192 bits, as os.urandom(24).hex()
	if _, err := rand.Read(tok); err != nil {
		return nil, err
	}
	s := &Service{vid: vid, token: hex.EncodeToString(tok), o: o, vols: map[string]*volume{}}
	if err := os.MkdirAll(o.Root, 0o755); err != nil {
		return nil, fmt.Errorf("encrypted volume staging failed: %v", err)
	}
	for _, sp := range specs {
		d := filepath.Join(o.Root, sp.Name)
		if err := os.Mkdir(d, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
			return nil, fmt.Errorf("encrypted volume staging failed: %v", err)
		}
		if o.Mount != nil {
			if err := o.Mount(d, sp.MaxMB); err != nil {
				return nil, fmt.Errorf("encrypted volume staging failed: %v", err)
			}
		}
		if o.UID >= 0 {
			if err := os.Chown(d, o.UID, o.GID); err != nil {
				return nil, fmt.Errorf("encrypted volume staging failed: %v", err)
			}
		}
		s.vols[sp.Name] = &volume{spec: sp, dir: d, pub: pub{Name: sp.Name, Status: "locked", MaxMb: sp.MaxMB, ReadOnly: sp.ReadOnly,
			Endpoint: sp.Endpoint, Bucket: sp.Bucket, Path: sp.Path, Unlock: sp.Unlock, KeyID: sp.KeyID, Encrypted: sp.Encrypted}}
		s.order = append(s.order, sp.Name)
	}
	return s, nil
}

// Token is the deployment's bearer for the plane: it goes to the app's environment and nowhere else.
func (s *Service) Token() string { return s.token }

// Mounts lists name -> staging dir, in config order.
func (s *Service) Mounts() [][2]string {
	out := make([][2]string, 0, len(s.order))
	for _, n := range s.order {
		out = append(out, [2]string{n, s.vols[n].dir})
	}
	return out
}

// Public is the per-volume view (GET /encvol/<vid>): sizes refreshed lazily, as _enc_public does.
func (s *Service) Public() []pub {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.publicLocked()
}

func (s *Service) publicLocked() []pub {
	out := make([]pub, 0, len(s.order))
	for _, n := range s.order {
		v := s.vols[n]
		if v.pub.Status == "unlocked" || v.pub.Status == "pushing" {
			v.pub.Bytes = dirSize(v.dir)
		}
		out = append(out, v.pub)
	}
	return out
}

// ---- the far side ----------------------------------------------------------------------------------------------------

type creds struct {
	Password, Salt, AccessKeyID, SecretAccessKey, SessionToken string
}

// open is _enc_rclone_env's remote: the store (S3, or local: in tests) and, unless the volume is plain, the crypt
// cipher keyed from the password and salt exactly as rclone keys it.
func (s *Service) open(sp Spec, c creds) (*remote, error) {
	rm := &remote{}
	if strings.HasPrefix(sp.Endpoint, "local:") {
		root := filepath.Join(strings.TrimPrefix(sp.Endpoint, "local:"), sp.Bucket)
		if sp.Path != "" {
			root = filepath.Join(root, filepath.FromSlash(sp.Path))
		}
		rm.st = &localStore{root: root}
	} else {
		roots := s.o.Roots
		if roots == nil {
			r, err := PublicRoots()
			if err != nil {
				return nil, err
			}
			roots = r
		}
		st, err := newS3Store(sp, c, roots, strings.HasPrefix(sp.Endpoint, "http://"), s.o.Timeout)
		if err != nil {
			return nil, err
		}
		if s.o.Dial != nil {
			st.client.Transport.(*http.Transport).DialContext = s.o.Dial
		}
		rm.st = st
	}
	if sp.Encrypted {
		ci, err := rclonecrypt.New(sp.FilenameEncryption, sp.DirectoryNameEncryption, c.Password, c.Salt)
		if err != nil {
			return nil, fmt.Errorf("crypt: %v", err)
		}
		rm.cipher = ci
	}
	return rm, nil
}

func (rm *remote) forget() {
	if rm != nil && rm.cipher != nil {
		rm.cipher.Forget()
	}
	if st, ok := rm.st.(*s3Store); ok {
		st.ak, st.sk, st.token = "", "", ""
		st.client.CloseIdleConnections()
	}
}

const undecryptableMsg = "volume did not decrypt (wrong password/salt, or filenameEncryption doesn't match how it was pushed)"

// run is _enc_rclone_sync: one sync under the timeout; an undecryptable name under crypt is a wrong key, not an
// empty volume.
func (s *Service) run(v *volume, rm *remote, up bool) (bool, string) {
	ctx, cancel := context.WithTimeout(context.Background(), s.o.Timeout)
	defer cancel()
	t := tree{dir: v.dir, uid: s.o.UID, gid: s.o.GID, shared: s.o.Shared}
	var res syncResult
	var err error
	if up {
		res, err = push(ctx, rm, t)
	} else {
		res, err = pull(ctx, rm, t, int64(v.spec.MaxMB)*1024*1024)
	}
	if ctx.Err() == context.DeadlineExceeded {
		return false, fmt.Sprintf("rclone sync timed out after %ds", int(s.o.Timeout.Seconds()))
	}
	if rm.cipher != nil && res.undecryptable > 0 {
		return false, undecryptableMsg
	}
	if err != nil {
		msg := err.Error()
		if len(msg) > 800 {
			msg = msg[len(msg)-800:]
		}
		return false, msg
	}
	return true, ""
}

// wipe drops a volume's plaintext but KEEPS the directory: it is a live preopen (the app holds an fd to it).
func wipe(dir string) {
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		_ = os.RemoveAll(filepath.Join(dir, e.Name()))
	}
}

func (s *Service) unlockWorker(v *volume, c creds) {
	rm, err := s.open(v.spec, c)
	if err != nil {
		s.mu.Lock()
		v.pub.Status, v.pub.Error = "locked", strp(err.Error())
		s.mu.Unlock()
		s.o.Logf("DOM encvol %s unlock failed", v.spec.Name)
		return
	}
	ok, msg := s.run(v, rm, false)
	s.mu.Lock()
	if ok {
		v.pub.Status, v.pub.Error, v.pub.Bytes = "unlocked", nil, dirSize(v.dir)
		if !v.spec.ReadOnly {
			v.rm = rm // kept in memory for /sync push-back; readOnly drops it
		} else {
			rm.forget()
		}
	} else {
		wipe(v.dir) // a partial tree that LOOKS unlocked is worse than an empty one
		v.pub.Status, v.pub.Error = "locked", strp(msg)
		rm.forget()
	}
	s.mu.Unlock()
	s.o.Logf("DOM encvol %s unlock %s", v.spec.Name, okWord(ok))
}

func (s *Service) pushWorker(v *volume, rm *remote) {
	ok, msg := s.run(v, rm, true)
	s.mu.Lock()
	v.pub.Status = "unlocked"
	if ok {
		v.pub.Error = nil
		now := float64(time.Now().UnixNano()) / 1e9
		v.pub.LastPush = &now
	} else {
		v.pub.Error = strp(msg)
	}
	s.mu.Unlock()
	s.o.Logf("DOM encvol %s push %s", v.spec.Name, okWord(ok))
}

// Audit is _audit_enc: every volume that is not locked must hold at most maxMb; otherwise the app is killed.
func (s *Service) Audit() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dead {
		return
	}
	for _, n := range s.order {
		v := s.vols[n]
		if v.pub.Status == "locked" {
			continue
		}
		used := dirSize(v.dir)
		v.pub.Bytes = used
		if used > int64(v.spec.MaxMB)*1024*1024 {
			s.dead = true
			reason := fmt.Sprintf("storage: volume '%s' holds %dMiB, over its %dMiB cap (encVolumes maxMb); app killed.", n, used/(1024*1024), v.spec.MaxMB)
			s.o.Logf("DOM encvol %s over its cap: the app is ended", n)
			go s.o.Kill(reason)
			return
		}
	}
}

// RunAudit audits every `every` until ctx ends (the manager's AUDIT_SECS is 10 s).
func (s *Service) RunAudit(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.Audit()
		}
	}
}

// ---- the tenant plane -------------------------------------------------------------------------------------------------

var routeRE = regexp.MustCompile(`^/encvol/([^/?]+)(?:/(unlock|sync|lock))?$`)

// ServeHTTP is the manager's /encvol handler, for this one deployment.
func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	m := routeRE.FindStringSubmatch(r.URL.Path)
	if m == nil || r.URL.RawQuery != "" {
		writeJSON(w, 404, map[string]any{"error": "not found"})
		return
	}
	if m[1] != s.vid {
		writeJSON(w, 404, map[string]any{"error": "no such deployment or no encrypted volumes"})
		return
	}
	tok := r.Header.Get("X-Enc-Token")
	if tok == "" {
		if b := regexp.MustCompile(`^Bearer\s+(\S+)$`).FindStringSubmatch(r.Header.Get("Authorization")); b != nil {
			tok = b[1]
		}
	}
	// untrusted guest bytes: compare as bytes, in constant time
	if subtle.ConstantTimeCompare([]byte(tok), []byte(s.token)) != 1 {
		writeJSON(w, 401, map[string]any{"error": "volume token required"})
		return
	}
	switch r.Method {
	case http.MethodGet: // the manager answers any GET on the route with the volume list, action or not
		writeJSON(w, 200, map[string]any{"id": s.vid, "volumes": s.Public()})
	case http.MethodPost:
		if m[2] == "" {
			writeJSON(w, 405, map[string]any{"error": "POST /encvol/<vid>/{unlock|sync|lock}"})
			return
		}
		s.post(w, r, m[2])
	default:
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
	}
}

func (s *Service) post(w http.ResponseWriter, r *http.Request, action string) {
	body := map[string]any{}
	b, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err == nil && len(bytes.TrimSpace(b)) > 0 {
		if json.Unmarshal(b, &body) != nil || body == nil {
			body = map[string]any{}
		}
	}
	name := strings.TrimSpace(str(body["name"]))
	s.mu.Lock()
	v := s.vols[name]
	s.mu.Unlock()
	if v == nil {
		writeJSON(w, 404, map[string]any{"error": fmt.Sprintf("no encrypted volume '%s' on this deployment", name)})
		return
	}
	switch action {
	case "unlock":
		password, _ := body["password"].(string)
		if v.spec.Encrypted {
			if password == "" {
				writeJSON(w, 400, map[string]any{"error": "password required"})
				return
			}
		} else if !isFalsy(body["password"]) || !isFalsy(body["salt"]) {
			writeJSON(w, 400, map[string]any{"error": fmt.Sprintf("volume '%s' is plain (\"encrypted\": false): it takes S3 credentials only, no password/salt", name)})
			return
		}
		c := creds{Password: password, Salt: str(body["salt"]), AccessKeyID: str(body["accessKeyId"]),
			SecretAccessKey: str(body["secretAccessKey"]), SessionToken: str(body["sessionToken"])}
		s.mu.Lock()
		if v.pub.Status == "syncing" || v.pub.Status == "pushing" {
			st := v.pub.Status
			s.mu.Unlock()
			writeJSON(w, 409, map[string]any{"error": fmt.Sprintf("volume is busy (%s)", st)})
			return
		}
		v.pub.Status, v.pub.Error = "syncing", nil
		if v.rm != nil {
			v.rm.forget()
			v.rm = nil
		}
		s.mu.Unlock()
		go s.unlockWorker(v, c)
		writeJSON(w, 202, map[string]any{"name": name, "status": "syncing"})
	case "sync":
		s.mu.Lock()
		if v.pub.Status != "unlocked" {
			st := v.pub.Status
			s.mu.Unlock()
			writeJSON(w, 409, map[string]any{"error": fmt.Sprintf("volume is %s, not unlocked", st)})
			return
		}
		if v.spec.ReadOnly || v.rm == nil {
			s.mu.Unlock()
			writeJSON(w, 403, map[string]any{"error": "read-only volume: no credentials retained for push"})
			return
		}
		v.pub.Status = "pushing"
		s.mu.Unlock()
		go s.pushWorker(v, v.rm)
		writeJSON(w, 202, map[string]any{"name": name, "status": "pushing"})
	default: // lock: wipe the plaintext, drop retained credentials
		s.mu.Lock()
		if v.pub.Status == "syncing" || v.pub.Status == "pushing" {
			st := v.pub.Status
			s.mu.Unlock()
			writeJSON(w, 409, map[string]any{"error": fmt.Sprintf("volume is busy (%s)", st)})
			return
		}
		wipe(v.dir)
		if v.rm != nil {
			v.rm.forget()
			v.rm = nil
		}
		v.pub.Status, v.pub.Error, v.pub.Bytes = "locked", nil, 0
		s.mu.Unlock()
		writeJSON(w, 200, map[string]any{"name": name, "status": "locked"})
	}
}

// ---- helpers ---------------------------------------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, code int, v any) {
	b, _ := json.Marshal(v)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	w.Write(b)
}

// dirSize is _dir_size: bytes of regular files under dir, symlinks not followed.
func dirSize(dir string) int64 {
	var total int64
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.Type().IsRegular() {
			if fi, e := d.Info(); e == nil {
				total += fi.Size()
			}
		}
		return nil
	})
	return total
}

func str(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		if x == float64(int64(x)) {
			return fmt.Sprintf("%d", int64(x))
		}
		return fmt.Sprintf("%v", x)
	case bool:
		if x {
			return "True"
		}
		return "False"
	default:
		b, _ := json.Marshal(x)
		return string(b)
	}
}

func strp(s string) *string { return &s }
func okWord(ok bool) string {
	if ok {
		return "ok"
	}
	return "failed"
}

// isFalsy mirrors Python truthiness for JSON values (the manager's `x or default`).
func isFalsy(v any) bool {
	switch x := v.(type) {
	case nil:
		return true
	case bool:
		return !x
	case float64:
		return x == 0
	case string:
		return x == ""
	case []any:
		return len(x) == 0
	case map[string]any:
		return len(x) == 0
	}
	return false
}
