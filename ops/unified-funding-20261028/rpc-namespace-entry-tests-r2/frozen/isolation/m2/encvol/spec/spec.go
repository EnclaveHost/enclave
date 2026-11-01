// Package spec is the encVolumes config: wasm/wasm_manager.py's _parse_enc_volumes rules (Parse), the per-app guest's
// endpoint narrowing, and what a volume needs before any secret is known (ParseLayout, TmpfsMiB). Standard library
// only: the Hyper-V partition's measured monitor stages volumes from it without linking the engine or its crypto.
package spec

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// The standard runtime's limits (WASM_ENC_DEF_MB, WASM_ENC_MAX_MB, WASM_ENC_MAX_VOLS); encvol.SyncTimeout is the fourth.
const (
	DefMB     = 1024
	MaxMB     = 4096
	MaxVols   = 8
	GuestRoot = "/enc" // /enc/<name> inside the guest (WASM_ENC_GUEST)
)

var (
	volNameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)        // _VOL_NAME_RE
	bucketRE  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$`) // _ENC_BUCKET_RE
	dnsHostRE = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`)
	fileEnc   = []string{"standard", "off", "obfuscate"} // _ENC_FILENAME_ENC
)

// TmpfsMiB is the size of a volume's own tmpfs in a guest: its cap plus a small headroom, so an overrun is still
// measured (and the app ended, as on the standard tier) while a runaway write cannot take the guest's memory.
// supervisor.js encTmpfsMiB is the same rule.
func TmpfsMiB(maxMB int) int { return maxMB + 1 + maxMB/64 }

// GuestReserveMiB is what a guest keeps for its runtime and app beside its volumes (supervisor.js ENC_GUEST_RESERVE_MIB).
const GuestReserveMiB = 128

// Spec is one validated encVolumes entry: where the ciphertext lives and how it was packed. Nothing in it is secret.
type Spec struct {
	Name                    string
	Endpoint                string
	Bucket                  string
	Path                    string
	Unlock                  string
	KeyID                   string
	Encrypted               bool
	Provider                string
	Region                  string
	FilenameEncryption      string
	DirectoryNameEncryption bool
	MaxMB                   int
	ReadOnly                bool
}

// ParseOptions: test hooks only. A guest never sets either (front/encvol.go passes the zero value).
type ParseOptions struct {
	AllowLocal       bool // "local:/abs/path" endpoints (WASM_ENC_LOCAL_SRC): rclone's local backend, no bucket
	TestLoopbackHTTP bool // http://127.0.0.1:PORT endpoints, for an S3 fixture on the test host's loopback
}

// Parse validates the config's encVolumes exactly as _parse_enc_volumes does, plus the direct guest's endpoint rule.
// No encVolumes (or an empty list) is nil, nil.
func Parse(config string, o ParseOptions) ([]Spec, error) { return parse(config, o, false) }

// ParseLayout is Parse for what a volume needs before any secret is known: every rule on the names, the count, the
// caps, unlock and keyId, but NOT on endpoint, bucket and path, which a measured config may hold as "$SECRET"
// references (the standard runtime parses the secret-substituted config). The Hyper-V partition's monitor stages
// from it; the front then parses the resolved config with Parse and requires the same layout (SameLayout).
func ParseLayout(config string) ([]Spec, error) { return parse(config, ParseOptions{}, true) }

// SameLayout: the resolved config's volumes are exactly the staged ones (names, order, caps).
func SameLayout(a, b []Spec) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Name != b[i].Name || a[i].MaxMB != b[i].MaxMB {
			return false
		}
	}
	return true
}

func parse(config string, o ParseOptions, layout bool) ([]Spec, error) {
	if strings.TrimSpace(config) == "" {
		return nil, nil
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal([]byte(config), &doc); err != nil {
		return nil, nil // not an object: no encVolumes to read (the manager would not reach this either)
	}
	raw, ok := doc["encVolumes"]
	if !ok {
		return nil, nil
	}
	var any_ any
	if err := json.Unmarshal(raw, &any_); err != nil || any_ == nil || isFalsy(any_) {
		return nil, nil
	}
	entries, ok := any_.([]any)
	if !ok || len(entries) > MaxVols {
		return nil, fmt.Errorf("encVolumes must be a list of at most %d entries", MaxVols)
	}
	var specs []Spec
	seen := map[string]bool{}
	for _, e := range entries {
		m, ok := e.(map[string]any)
		if !ok {
			return nil, errors.New("encVolumes entries must be objects")
		}
		name := strings.TrimSpace(strOr(m["name"], ""))
		if !volNameRE.MatchString(name) {
			return nil, fmt.Errorf("encVolumes: bad volume name '%s' (want %s)", name, volNameRE.String())
		}
		if seen[name] {
			return nil, fmt.Errorf("encVolumes: duplicate volume '%s'", name)
		}
		seen[name] = true
		endpoint := strings.TrimRight(strings.TrimSpace(strOr(m["endpoint"], "")), "/")
		if err := checkEndpoint(name, endpoint, o); err != nil && !layout {
			return nil, err
		}
		bucket := strings.Trim(strings.TrimSpace(strOr(m["bucket"], "")), "/")
		if !bucketRE.MatchString(bucket) && !layout {
			return nil, fmt.Errorf("encVolumes '%s': bad bucket name", name)
		}
		path := strings.Trim(strings.TrimSpace(strOr(m["path"], "")), "/")
		if path != "" && !layout {
			for _, seg := range strings.Split(path, "/") {
				if seg == "" || seg == "." || seg == ".." {
					return nil, fmt.Errorf("encVolumes '%s': bad path prefix", name)
				}
			}
		}
		encrypted := boolOr(m["encrypted"], true)
		_, hasFenc := m["filenameEncryption"]
		_, hasDenc := m["directoryNameEncryption"]
		if !encrypted && (hasFenc || hasDenc) {
			return nil, fmt.Errorf("encVolumes '%s': filenameEncryption/directoryNameEncryption apply to the "+
				"crypt layer, which \"encrypted\": false turns off - drop them", name)
		}
		fenc := strings.TrimSpace(strOr(m["filenameEncryption"], "standard")) // str(x or "standard").strip()
		if !contains(fileEnc, fenc) {
			return nil, fmt.Errorf("encVolumes '%s': filenameEncryption must be one of ('standard', 'off', 'obfuscate')", name)
		}
		maxMB := DefMB
		if v, present := m["maxMb"]; present && !isFalsy(v) {
			n, ok := intOf(v)
			if !ok {
				return nil, fmt.Errorf("encVolumes '%s': maxMb must be an integer", name)
			}
			maxMB = n
		}
		if maxMB < 1 || maxMB > MaxMB {
			return nil, fmt.Errorf("encVolumes '%s': maxMb must be 1..%d", name, MaxMB)
		}
		unlock := strings.TrimSpace(strOr(m["unlock"], "password"))
		if unlock != "password" && unlock != "wallet" {
			return nil, fmt.Errorf("encVolumes '%s': unlock must be 'password' or 'wallet'", name)
		}
		keyID := strings.TrimSpace(strOr(m["keyId"], name))
		if !volNameRE.MatchString(keyID) {
			return nil, fmt.Errorf("encVolumes '%s': bad keyId (want %s)", name, volNameRE.String())
		}
		provider := strings.TrimSpace(strOr(m["provider"], "Other")) // str(x or "Other").strip() or "Other"
		if provider == "" {
			provider = "Other"
		}
		specs = append(specs, Spec{Name: name, Endpoint: endpoint, Bucket: bucket, Path: path, Unlock: unlock, KeyID: keyID,
			Encrypted: encrypted, Provider: provider, Region: strings.TrimSpace(strOr(m["region"], "")), FilenameEncryption: fenc,
			DirectoryNameEncryption: boolOr(m["directoryNameEncryption"], true), MaxMB: maxMB, ReadOnly: boolOr(m["readOnly"], false)})
	}
	return specs, nil
}

// checkEndpoint: the manager's rule (http(s) S3 URL, local: only as a test hook) narrowed to what the guest's egress
// carries: https, port 443, a plain DNS name - never an IP literal, userinfo, a path or a query.
func checkEndpoint(name, endpoint string, o ParseOptions) error {
	if strings.HasPrefix(endpoint, "local:") {
		if !o.AllowLocal {
			return fmt.Errorf("encVolumes '%s': local: endpoints are a test hook (WASM_ENC_LOCAL_SRC), not deployable", name)
		}
		if !filepath.IsAbs(strings.TrimPrefix(endpoint, "local:")) {
			return fmt.Errorf("encVolumes '%s': local: endpoints need an absolute path", name)
		}
		return nil
	}
	if !strings.HasPrefix(endpoint, "https://") && !strings.HasPrefix(endpoint, "http://") {
		return fmt.Errorf("encVolumes '%s': endpoint must be an http(s) S3 endpoint URL", name)
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" {
		return fmt.Errorf("encVolumes '%s': endpoint must be an http(s) S3 endpoint URL", name)
	}
	if o.TestLoopbackHTTP && u.Scheme == "http" && u.Hostname() == "127.0.0.1" && u.User == nil && (u.Path == "" || u.Path == "/") {
		return nil
	}
	host := strings.ToLower(u.Hostname())
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || net.ParseIP(strings.Trim(host, "[]")) != nil {
		return fmt.Errorf("encVolumes '%s': endpoint host '%s' is a private/loopback/link-local or literal address (SSRF-blocked); "+
			"a per-app guest reaches S3 only by DNS name through its measured egress", name, host)
	}
	if u.Scheme != "https" || (u.Port() != "" && u.Port() != "443") || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("encVolumes '%s': a per-app guest reaches S3 only over https:// on port 443 with no path "+
			"(its measured egress carries nothing else); got %s", name, redact(endpoint))
	}
	if !dnsHostRE.MatchString(host) || strings.Contains(host, "%") {
		return fmt.Errorf("encVolumes '%s': endpoint host '%s' is not a plain DNS name", name, host)
	}
	return nil
}

// Origin is the https origin a spec's endpoint needs in the guest's egress allowlist ("" for test hooks).
func (s Spec) Origin() string {
	u, err := url.Parse(s.Endpoint)
	if err != nil || u.Scheme != "https" {
		return ""
	}
	return "https://" + strings.ToLower(u.Hostname())
}

func redact(s string) string {
	if u, err := url.Parse(s); err == nil && u.User != nil {
		u.User = nil
		return u.String()
	}
	return s
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

// strOr is str(v or def): the default applies to a FALSY value, before any strip.
func strOr(v any, def string) string {
	if isFalsy(v) {
		return def
	}
	return str(v)
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

// boolOr is bool(e.get(k, def)): an absent key takes def; a present value is Python-truthy.
func boolOr(v any, def bool) bool {
	if v == nil {
		return def
	}
	return !isFalsy(v)
}

// intOf is int(x) for what a JSON maxMb can be: an integral number, or a string of digits.
func intOf(v any) (int, bool) {
	switch x := v.(type) {
	case float64:
		if x != float64(int64(x)) {
			return int(x), true // Python int() truncates a float
		}
		return int(x), true
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(x)) // int("05"), int(" 7 "), int("+3") as Python parses them
		if err != nil {
			return 0, false
		}
		return n, true
	case bool:
		if x {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}
