package main

// guestd-control/1: the authenticated control channel between a node's supervisor and its host-side guestd.
//
// WHO MAY CALL. Exactly one principal: the supervisor PAIRED with this guestd, and the only proof of that is
// possession of the pairing key K - 32 random bytes the host operator generates once (`guestd -gen-key FILE`, a
// new file, mode 0600) and delivers to that node's supervisor. The delivery path (fw_cfg into the node CVM, as the
// metal launcher already passes its configuration) is a production step and is NOT built here.
//
// WHAT K DOES AND DOES NOT PROTECT. The host is outside the trust boundary, and its root controls guestd and every
// guest regardless, so K is not a defence against the host operator. It stops: any OTHER local user or process, any
// VM (per-app guests included) reaching a bridged transport, a recorded request being replayed later or to another
// guestd, and a supervisor mistaking an impostor for its manager (guestd proves possession of K too). Nothing a
// guest's security rests on is taken from this channel: the supervisor verifies each guest's attestation itself.
//
// THE EXCHANGE (all strings UTF-8, "\n"-joined, every hex value lowercase):
//
//	kid         = hex(SHA256("guestd-control/1 kid\n" || K))[:16]                   which key, never the key
//	GET  /control/hello   -> {proto, instance, nonce, kid, nonceTtlSec}          unauthenticated
//	    instance: 16 random bytes, NEW at every start; nonce: 32 random bytes, single use, 30 s
//	POST /control/session <- {instance, nonce, clientNonce, kid, mac}
//	    mac   = HMAC(K, "guestd-control/1 session\n" instance \n nonce \n clientNonce \n kid)
//	    -> {session, idleSec, maxSec, proof}
//	    skey  = HMAC(K, "guestd-control/1 skey\n" instance \n nonce \n clientNonce \n session)
//	    proof = HMAC(skey, "guestd-control/1 proof\n" clientNonce)                guestd holds K too
//	every other request carries
//	    X-Guestd-Session: session   X-Guestd-Seq: n (decimal, >= 1)
//	    X-Guestd-Mac: HMAC(skey, "guestd-control/1 req\n" session \n n \n METHOD \n request-target \n hex(SHA256(body)))
//	and every answer to it carries
//	    X-Guestd-Response-Mac: HMAC(skey, "guestd-control/1 resp\n" session \n n \n status \n hex(SHA256(body)))
//
// REPLAY: a sequence number is accepted once, within a 64-wide window below the highest seen (concurrent requests
// may arrive out of order), and recorded only AFTER its MAC verifies, so a forgery cannot burn a number. CROSS-
// INSTANCE: the instance id is in the handshake MAC and the session key, and sessions live in memory, so nothing
// signed for one guestd - or for this one before a restart - is accepted by another. EXPIRY: a session ends after
// 10 minutes idle or 1 hour in all, and the client re-handshakes; unused nonces lapse after 30 s. Both tables are
// bounded (64 nonces, 8 sessions), so the unauthenticated hello cannot grow memory.
//
// WITHOUT K: guestd stays in its unauthenticated LAB mode - loopback only, as before - and /control/* answers that
// no credentials are configured, so a client that expects this protocol fails closed instead of falling back.

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const controlProto = "guestd-control/1"

type session struct {
	key          []byte
	created, use time.Time
	high         uint64 // highest sequence number accepted
	seen         uint64 // bit i: high-i was accepted
}

type controlAuth struct {
	key      []byte
	kid      string
	instance string
	now      func() time.Time

	NonceTTL, Idle, MaxAge time.Duration
	MaxNonces, MaxSessions int

	mu       sync.Mutex
	nonces   map[string]time.Time
	sessions map[string]*session
}

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func mac(key []byte, parts ...string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(strings.Join(parts, "\n")))
	return m.Sum(nil)
}

func macHex(key []byte, parts ...string) string { return hex.EncodeToString(mac(key, parts...)) }

func keyID(k []byte) string {
	s := sha256.Sum256(append([]byte(controlProto+" kid\n"), k...))
	return hex.EncodeToString(s[:])[:16]
}

func newControlAuth(key []byte, now func() time.Time) *controlAuth {
	return &controlAuth{key: key, kid: keyID(key), instance: randHex(16), now: now,
		NonceTTL: 30 * time.Second, Idle: 10 * time.Minute, MaxAge: time.Hour, MaxNonces: 64, MaxSessions: 8,
		nonces: map[string]time.Time{}, sessions: map[string]*session{}}
}

var keyFileRE = regexp.MustCompile(`^[0-9a-f]{64}\n?$`)

// loadKey reads a pairing key, refusing a file anyone but its owner could read or write, a symlink, a key that is
// not exactly 32 bytes of hex, and the all-zero key.
func loadKey(path string) ([]byte, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file (a symlink or other entry is refused)", path)
	}
	if fi.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("%s is readable or writable by others (mode %o): it must be 0600 or 0400", path, fi.Mode().Perm())
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok && int(st.Uid) != os.Geteuid() {
		return nil, fmt.Errorf("%s is owned by uid %d, not by the user guestd runs as", path, st.Uid)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if !keyFileRE.Match(raw) {
		return nil, fmt.Errorf("%s must hold exactly 64 lowercase hex digits (32 bytes)", path)
	}
	k, _ := hex.DecodeString(strings.TrimSpace(string(raw)))
	if bytes.Equal(k, make([]byte, 32)) {
		return nil, errors.New("the all-zero key is refused")
	}
	return k, nil
}

// genKey writes a NEW pairing key: it never overwrites one, since replacing a key silently unpairs a supervisor.
func genKey(path string) (string, error) {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", err
	}
	k := randHex(32)
	if _, err := f.WriteString(k + "\n"); err != nil {
		f.Close()
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	raw, _ := hex.DecodeString(k)
	return keyID(raw), nil
}

// sweep drops lapsed nonces and sessions. Also called on every hello and session, so the tables stay bounded
// whether or not the periodic tick runs.
func (a *controlAuth) sweep() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.sweepLocked()
}

func (a *controlAuth) sweepLocked() {
	now := a.now()
	for n, t := range a.nonces {
		if now.Sub(t) > a.NonceTTL {
			delete(a.nonces, n)
		}
	}
	for id, s := range a.sessions {
		if a.expired(s, now) {
			delete(a.sessions, id)
		}
	}
}

func (a *controlAuth) expired(s *session, now time.Time) bool {
	return now.Sub(s.use) > a.Idle || now.Sub(s.created) > a.MaxAge
}

func (a *controlAuth) counts() (int, int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.nonces), len(a.sessions)
}

func (a *controlAuth) hello(w http.ResponseWriter) {
	a.mu.Lock()
	a.sweepLocked()
	for len(a.nonces) >= a.MaxNonces { // evict the oldest: an unauthenticated caller cannot grow the table
		var oldest string
		var ot time.Time
		for n, t := range a.nonces {
			if oldest == "" || t.Before(ot) {
				oldest, ot = n, t
			}
		}
		delete(a.nonces, oldest)
	}
	n := randHex(32)
	a.nonces[n] = a.now()
	a.mu.Unlock()
	writeJSON(w, 200, map[string]any{"proto": controlProto, "instance": a.instance, "nonce": n, "kid": a.kid,
		"nonceTtlSec": a.NonceTTL.Seconds()})
}

var hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (a *controlAuth) openSession(w http.ResponseWriter, r *http.Request) {
	var b struct{ Instance, Nonce, ClientNonce, Kid, Mac string }
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil || !hex64.MatchString(b.ClientNonce) || !hex64.MatchString(b.Mac) {
		writeJSON(w, 400, map[string]any{"error": "a session request is {instance, nonce, clientNonce, kid, mac} with 64-hex nonce and mac"})
		return
	}
	want := mac(a.key, controlProto+" session", b.Instance, b.Nonce, b.ClientNonce, b.Kid)
	got, _ := hex.DecodeString(b.Mac)
	a.mu.Lock()
	defer a.mu.Unlock()
	a.sweepLocked()
	issued, known := a.nonces[b.Nonce]
	switch {
	case b.Instance != a.instance:
		writeJSON(w, 401, map[string]any{"error": "not this guestd instance", "reauth": true})
		return
	case b.Kid != a.kid:
		writeJSON(w, 401, map[string]any{"error": "not this guestd's pairing key"})
		return
	case !known || a.now().Sub(issued) > a.NonceTTL:
		writeJSON(w, 401, map[string]any{"error": "unknown, used or expired nonce", "reauth": true})
		return
	case !hmac.Equal(want, got):
		writeJSON(w, 401, map[string]any{"error": "the session proof does not verify"})
		return
	}
	delete(a.nonces, b.Nonce) // single use, whatever happens next
	for len(a.sessions) >= a.MaxSessions {
		var lru string
		for id, s := range a.sessions {
			if lru == "" || s.use.Before(a.sessions[lru].use) {
				lru = id
			}
		}
		delete(a.sessions, lru)
	}
	sid := randHex(16)
	skey := mac(a.key, controlProto+" skey", a.instance, b.Nonce, b.ClientNonce, sid)
	now := a.now()
	a.sessions[sid] = &session{key: skey, created: now, use: now}
	writeJSON(w, 200, map[string]any{"session": sid, "idleSec": a.Idle.Seconds(), "maxSec": a.MaxAge.Seconds(),
		"proof": macHex(skey, controlProto+" proof", b.ClientNonce)})
}

// accept records sequence number n if it is new and inside the window. Caller holds a.mu.
func (s *session) accept(n uint64) bool {
	if n == 0 {
		return false
	}
	if n > s.high {
		if shift := n - s.high; shift >= 64 {
			s.seen = 0
		} else {
			s.seen <<= shift
		}
		s.seen |= 1
		s.high = n
		return true
	}
	d := s.high - n
	if d >= 64 || s.seen&(1<<d) != 0 {
		return false
	}
	s.seen |= 1 << d
	return true
}

// authenticate checks one request and returns the session key and sequence number to sign the answer with.
func (a *controlAuth) authenticate(r *http.Request, body []byte) ([]byte, string, int, error) {
	sid := r.Header.Get("X-Guestd-Session")
	seqS := r.Header.Get("X-Guestd-Seq")
	macS := r.Header.Get("X-Guestd-Mac")
	seq, err := strconv.ParseUint(seqS, 10, 64)
	if sid == "" || err != nil || strconv.FormatUint(seq, 10) != seqS || !hex64.MatchString(macS) {
		return nil, "", 401, errors.New("this guestd requires an authenticated session (guestd-control/1)")
	}
	bh := sha256.Sum256(body)
	a.mu.Lock()
	defer a.mu.Unlock()
	s, ok := a.sessions[sid]
	now := a.now()
	if !ok || a.expired(s, now) {
		delete(a.sessions, sid)
		return nil, "", 401, errReauth
	}
	want := mac(s.key, controlProto+" req", sid, seqS, r.Method, r.RequestURI, hex.EncodeToString(bh[:]))
	got, _ := hex.DecodeString(macS)
	if !hmac.Equal(want, got) {
		return nil, "", 401, errors.New("the request MAC does not verify")
	}
	if !s.accept(seq) {
		return nil, "", 401, errors.New("replayed, or older than the replay window")
	}
	s.use = now
	return s.key, seqS, 0, nil
}

var errReauth = errors.New("session expired or unknown: handshake again")

// recorder holds an answer until it is signed.
type recorder struct {
	h    http.Header
	code int
	body bytes.Buffer
}

func (rc *recorder) Header() http.Header         { return rc.h }
func (rc *recorder) WriteHeader(c int)           { rc.code = c }
func (rc *recorder) Write(b []byte) (int, error) { return rc.body.Write(b) }

// serve authenticates a request, runs the handler, and signs its answer.
func (a *controlAuth) serve(w http.ResponseWriter, r *http.Request, next func(http.ResponseWriter, *http.Request)) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "body: " + err.Error()})
		return
	}
	skey, seq, code, err := a.authenticate(r, body)
	if err != nil {
		writeJSON(w, code, map[string]any{"error": err.Error(), "reauth": errors.Is(err, errReauth)})
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	rc := &recorder{h: http.Header{}, code: 200}
	next(rc, r)
	rh := sha256.Sum256(rc.body.Bytes())
	for k, v := range rc.h {
		w.Header()[k] = v
	}
	w.Header().Set("X-Guestd-Response-Mac", macHex(skey, controlProto+" resp", r.Header.Get("X-Guestd-Session"), seq,
		strconv.Itoa(rc.code), hex.EncodeToString(rh[:])))
	w.WriteHeader(rc.code)
	_, _ = w.Write(rc.body.Bytes())
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
