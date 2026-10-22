package encvol

// Where a volume's objects live: an S3 bucket (with the volume's key prefix), or - test hook only - a local directory
// laid out as rclone's local backend would (local:<path>/<bucket>/<prefix>). The S3 side speaks the plain protocol
// rclone's s3 backend uses for provider "Other": path-style URLs, SigV4 (region "us-east-1" when none is set), anonymous
// requests for a public-read bucket, the session token header, and the modtime in X-Amz-Meta-Mtime in rclone's format.

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	_ "embed"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type object struct {
	Key        string // relative to the volume's prefix, "/"-separated
	Size       int64
	ModTime    time.Time
	HasModTime bool
}

type store interface {
	List(ctx context.Context) ([]object, error)
	Get(ctx context.Context, key string) (io.ReadCloser, time.Time, bool, error)
	Head(ctx context.Context, key string) (time.Time, bool, error)
	// Put sends `size` bytes; body is called once per attempt (and once more to hash, for S3).
	Put(ctx context.Context, key string, body func() (io.Reader, error), size int64, mtime time.Time) error
	Delete(ctx context.Context, key string) error
}

// ---- the modtime format rclone's s3 backend stores (ncw/swift v2.0.2 meta.go, MIT: nsToFloatString/floatStringToNs) ----

func nsToFloatString(ns int64) string {
	if ns < 0 {
		return "-" + nsToFloatString(-ns)
	}
	result := fmt.Sprintf("%010d", ns)
	split := len(result) - 9
	result, decimals := result[:split], result[split:]
	decimals = strings.TrimRight(decimals, "0")
	if decimals != "" {
		result += "."
		result += decimals
	}
	return result
}

func floatStringToNs(s string) (int64, error) {
	const zeros = "000000000"
	if point := strings.IndexRune(s, '.'); point >= 0 {
		tail := s[point+1:]
		if fill := 9 - len(tail); fill < 0 {
			tail = tail[:9]
		} else {
			tail += zeros[:fill]
		}
		s = s[:point] + tail
	} else if len(s) > 0 {
		s += zeros
	}
	return strconv.ParseInt(s, 10, 64)
}

// ---- local (test hook) -------------------------------------------------------------------------------------------------

type localStore struct{ root string }

func (l *localStore) List(ctx context.Context) ([]object, error) {
	var out []object
	err := filepath.WalkDir(l.root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) && p == l.root {
				return filepath.SkipAll
			}
			return err
		}
		if !d.Type().IsRegular() {
			return nil
		}
		fi, err := d.Info()
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(l.root, p)
		out = append(out, object{Key: filepath.ToSlash(rel), Size: fi.Size(), ModTime: fi.ModTime(), HasModTime: true})
		return nil
	})
	return out, err
}

func (l *localStore) Get(ctx context.Context, key string) (io.ReadCloser, time.Time, bool, error) {
	f, err := os.Open(filepath.Join(l.root, filepath.FromSlash(key)))
	if err != nil {
		return nil, time.Time{}, false, err
	}
	fi, _ := f.Stat()
	return f, fi.ModTime(), true, nil
}

func (l *localStore) Head(ctx context.Context, key string) (time.Time, bool, error) {
	fi, err := os.Stat(filepath.Join(l.root, filepath.FromSlash(key)))
	if err != nil {
		return time.Time{}, false, err
	}
	return fi.ModTime(), true, nil
}

func (l *localStore) Put(ctx context.Context, key string, body func() (io.Reader, error), size int64, mtime time.Time) error {
	p := filepath.Join(l.root, filepath.FromSlash(key))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	r, err := body()
	if err != nil {
		return err
	}
	tmp := p + ".encvol-partial"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	n, err := io.Copy(f, r)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil && n != size {
		err = fmt.Errorf("wrote %d bytes, expected %d", n, size)
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Chtimes(tmp, mtime, mtime); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func (l *localStore) Delete(ctx context.Context, key string) error {
	return os.Remove(filepath.Join(l.root, filepath.FromSlash(key)))
}

// ---- S3 ---------------------------------------------------------------------------------------------------------------

//go:embed roots/cacert-2026-09-25.pem
var publicRoots []byte

// PublicRoots is the trust store for owner S3 endpoints: curl's dated Mozilla extract (cacert-2026-09-25.pem, sha256
// a41b5d356aea97a529fe27e0f7316d2f9d946d75927476cf9cf1b90637d00505), compiled into the measured front.
func PublicRoots() (*x509.CertPool, error) {
	p := x509.NewCertPool()
	if !p.AppendCertsFromPEM(publicRoots) {
		return nil, errors.New("the embedded public roots do not parse")
	}
	return p, nil
}

type s3Store struct {
	base    *url.URL // scheme://host[:port]
	bucket  string
	prefix  string // "" or "a/b/"
	region  string
	ak, sk  string
	token   string
	client  *http.Client
	now     func() time.Time
	retries int
}

func newS3Store(sp Spec, c creds, roots *x509.CertPool, plainHTTP bool, timeout time.Duration) (*s3Store, error) {
	u, err := url.Parse(sp.Endpoint)
	if err != nil {
		return nil, err
	}
	tr := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 15 * time.Second}).DialContext,
		TLSHandshakeTimeout: 15 * time.Second, ResponseHeaderTimeout: 60 * time.Second, MaxIdleConnsPerHost: 4}
	if !plainHTTP {
		tr.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	}
	region := sp.Region
	if region == "" {
		region = "us-east-1"
	}
	pre := ""
	if sp.Path != "" {
		pre = sp.Path + "/"
	}
	return &s3Store{base: &url.URL{Scheme: u.Scheme, Host: u.Host}, bucket: sp.Bucket, prefix: pre, region: region,
		ak: c.AccessKeyID, sk: c.SecretAccessKey, token: c.SessionToken,
		client: &http.Client{Transport: tr, Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		now:    time.Now, retries: 3}, nil
}

// uriEncode is SigV4's: unreserved characters stay, everything else %XX; "/" stays only in paths.
func uriEncode(s string, path bool) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' || (path && c == '/') {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func hmacSHA256(key []byte, data string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(data))
	return m.Sum(nil)
}

// do sends one signed request (anonymous without credentials); payloadHash is the hex sha256 of the body.
func (s *s3Store) do(ctx context.Context, method, key string, query url.Values, body func() (io.Reader, error), size int64, payloadHash string, hdr map[string]string) (*http.Response, error) {
	var last error
	for attempt := 0; attempt < s.retries; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Duration(attempt) * time.Second):
			}
		}
		resp, err := s.once(ctx, method, key, query, body, size, payloadHash, hdr)
		if err == nil && resp.StatusCode < 500 {
			return resp, nil
		}
		if err == nil {
			last = s3Error(resp)
		} else {
			last = err
		}
	}
	return nil, last
}

func (s *s3Store) once(ctx context.Context, method, key string, query url.Values, body func() (io.Reader, error), size int64, payloadHash string, hdr map[string]string) (*http.Response, error) {
	path := "/" + s.bucket
	if key != "" {
		path += "/" + s.prefix + key
	} else if method == http.MethodGet && query == nil {
		path += "/"
	}
	canonPath := uriEncode(path, true)
	keys := make([]string, 0, len(query))
	for k := range query {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var qs []string
	for _, k := range keys {
		qs = append(qs, uriEncode(k, false)+"="+uriEncode(query.Get(k), false))
	}
	canonQuery := strings.Join(qs, "&")
	u := s.base.String() + canonPath
	if canonQuery != "" {
		u += "?" + canonQuery
	}
	var rd io.Reader = http.NoBody
	if body != nil {
		r, err := body()
		if err != nil {
			return nil, err
		}
		if size > 0 {
			rd = r // a zero-length object goes as NoBody: Go would send an unknown length (chunked) otherwise
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return nil, err
	}
	if body != nil && size > 0 {
		req.ContentLength = size
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	if s.ak == "" {
		return s.client.Do(req) // anonymous: a public-read bucket
	}
	t := s.now().UTC()
	amzDate := t.Format("20060102T150405Z")
	day := t.Format("20060102")
	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("x-amz-content-sha256", payloadHash)
	if s.token != "" {
		req.Header.Set("x-amz-security-token", s.token)
	}
	signed := map[string]string{"host": req.URL.Host}
	for k := range req.Header {
		lk := strings.ToLower(k)
		if lk == "content-type" || lk == "content-md5" || strings.HasPrefix(lk, "x-amz-") {
			signed[lk] = strings.TrimSpace(req.Header.Get(k))
		}
	}
	names := make([]string, 0, len(signed))
	for k := range signed {
		names = append(names, k)
	}
	sort.Strings(names)
	var ch strings.Builder
	for _, n := range names {
		ch.WriteString(n + ":" + signed[n] + "\n")
	}
	signedHeaders := strings.Join(names, ";")
	canon := strings.Join([]string{method, canonPath, canonQuery, ch.String(), signedHeaders, payloadHash}, "\n")
	scope := day + "/" + s.region + "/s3/aws4_request"
	sum := sha256.Sum256([]byte(canon))
	toSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + hex.EncodeToString(sum[:])
	k := hmacSHA256([]byte("AWS4"+s.sk), day)
	k = hmacSHA256(k, s.region)
	k = hmacSHA256(k, "s3")
	k = hmacSHA256(k, "aws4_request")
	sig := hex.EncodeToString(hmacSHA256(k, toSign))
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+s.ak+"/"+scope+", SignedHeaders="+signedHeaders+", Signature="+sig)
	return s.client.Do(req)
}

const emptySHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

func s3Error(resp *http.Response) error {
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	var e struct {
		Code    string `xml:"Code"`
		Message string `xml:"Message"`
	}
	if xml.Unmarshal(b, &e) == nil && e.Code != "" {
		return fmt.Errorf("S3 %s: %s (HTTP %d)", e.Code, e.Message, resp.StatusCode)
	}
	return fmt.Errorf("S3 answered HTTP %d", resp.StatusCode)
}

func (s *s3Store) List(ctx context.Context) ([]object, error) {
	var out []object
	token := ""
	for page := 0; page < 100000; page++ {
		q := url.Values{"list-type": {"2"}, "max-keys": {"1000"}}
		if s.prefix != "" {
			q.Set("prefix", s.prefix)
		}
		if token != "" {
			q.Set("continuation-token", token)
		}
		resp, err := s.do(ctx, http.MethodGet, "", q, nil, 0, emptySHA256, nil)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != 200 {
			return nil, s3Error(resp)
		}
		var r struct {
			Contents []struct {
				Key          string `xml:"Key"`
				Size         int64  `xml:"Size"`
				LastModified string `xml:"LastModified"`
			} `xml:"Contents"`
			IsTruncated           bool   `xml:"IsTruncated"`
			NextContinuationToken string `xml:"NextContinuationToken"`
		}
		err = xml.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(&r)
		resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("S3 listing: %v", err)
		}
		for _, c := range r.Contents {
			if !strings.HasPrefix(c.Key, s.prefix) || strings.HasSuffix(c.Key, "/") {
				continue // outside the volume, or a directory marker
			}
			lm, _ := time.Parse(time.RFC3339, c.LastModified)
			out = append(out, object{Key: strings.TrimPrefix(c.Key, s.prefix), Size: c.Size, ModTime: lm})
		}
		if !r.IsTruncated || r.NextContinuationToken == "" {
			return out, nil
		}
		token = r.NextContinuationToken
	}
	return nil, errors.New("S3 listing did not end")
}

func metaMtime(h http.Header) (time.Time, bool) {
	if v := h.Get("X-Amz-Meta-Mtime"); v != "" {
		if ns, err := floatStringToNs(v); err == nil {
			return time.Unix(0, ns), true
		}
	}
	return time.Time{}, false
}

func (s *s3Store) Get(ctx context.Context, key string) (io.ReadCloser, time.Time, bool, error) {
	resp, err := s.do(ctx, http.MethodGet, key, nil, nil, 0, emptySHA256, nil)
	if err != nil {
		return nil, time.Time{}, false, err
	}
	if resp.StatusCode != 200 {
		return nil, time.Time{}, false, s3Error(resp)
	}
	t, ok := metaMtime(resp.Header)
	return resp.Body, t, ok, nil
}

func (s *s3Store) Head(ctx context.Context, key string) (time.Time, bool, error) {
	resp, err := s.do(ctx, http.MethodHead, key, nil, nil, 0, emptySHA256, nil)
	if err != nil {
		return time.Time{}, false, err
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		return time.Time{}, false, fmt.Errorf("S3 HEAD answered HTTP %d", resp.StatusCode)
	}
	t, ok := metaMtime(resp.Header)
	return t, ok, nil
}

func (s *s3Store) Put(ctx context.Context, key string, body func() (io.Reader, error), size int64, mtime time.Time) error {
	h := sha256.New()
	r, err := body()
	if err != nil {
		return err
	}
	n, err := io.Copy(h, r)
	if err != nil {
		return err
	}
	if n != size {
		return fmt.Errorf("the local file changed while it was being sent (%d bytes, expected %d)", n, size)
	}
	hdr := map[string]string{"X-Amz-Meta-Mtime": nsToFloatString(mtime.UnixNano()), "Content-Type": "application/octet-stream"}
	resp, err := s.do(ctx, http.MethodPut, key, nil, body, size, hex.EncodeToString(h.Sum(nil)), hdr)
	if err != nil {
		return err
	}
	if resp.StatusCode != 200 {
		return s3Error(resp)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return nil
}

func (s *s3Store) Delete(ctx context.Context, key string) error {
	resp, err := s.do(ctx, http.MethodDelete, key, nil, nil, 0, emptySHA256, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 204 && resp.StatusCode != 200 && resp.StatusCode != 404 {
		return s3Error(resp)
	}
	return nil
}
