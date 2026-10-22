package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"time"

	"go.sia.tech/core/types"
	"go.sia.tech/indexd/accounts"
	"go.sia.tech/indexd/sharing"
	"go.sia.tech/jape"
)

// maxRequestSize determines the maximum size of an incoming
// HTTP request body.
const maxRequestSize = 10 << 20 // 10 MB

type authedHandler func(jape.Context, types.PublicKey)

type sharedHandler func(jape.Context, sharing.Key)

var (
	// ErrInternalError is returned when a signed URL can not be authenticated
	// because of an unexpected issue.
	ErrInternalError = errors.New("internal error")

	// ErrUnknownAccount is returned when a signed URL can not be authenticated
	// because the account does not exist in the account store.
	ErrUnknownAccount = errors.New("unknown account")
)

const (
	queryParamCredential = "sc"
	queryParamSignature  = "ss"
	queryParamValidUntil = "sv"
	// queryParamFence is the writer fence a mutation runs under (FENCING PATCH)
	queryParamFence = "sf"
	// G-C2 (v4): the operation id and the expected account head
	queryParamOp  = "op"
	queryParamSeq = "sq"
)

// fenceHashDomain separates fenced request hashes from 0.6.0 request hashes (FENCING PATCH).
const fenceHashDomain = "indexd/fence/v3"

func maxBytesMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, maxRequestSize)
		next.ServeHTTP(w, r)
	})
}

// ValidateURLSignature extracts the signed public key from the request
// and verifies the signature and expiration. The caller must check the boolean
// return value before proceeding with the request. The response header is written
// if the signature is invalid, expired, or the request is malformed. The request
// body is limited to 1 MiB
//
// NOTE: This function does not check if the account exists, it only validates
// the signature and expiration. If you need to check for account existence, use
// validateSignedURLAuth instead.
func ValidateURLSignature(r *http.Request, w http.ResponseWriter, hostname string) (types.PublicKey, bool) {
	buf, err := io.ReadAll(r.Body)
	r.Body.Close()
	if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
		http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
		return types.PublicKey{}, false
	} else if err != nil {
		http.Error(w, "failed to read request body", http.StatusUnauthorized)
		return types.PublicKey{}, false
	}
	r.Body = io.NopCloser(bytes.NewReader(buf))

	// validate presence of required parameters
	if !isSignedRequest(r) {
		http.Error(w, fmt.Sprintf("missing required query parameters: %q, %q, %q", queryParamCredential, queryParamSignature, queryParamValidUntil), http.StatusUnauthorized)
		return types.PublicKey{}, false
	}

	// extract query string parameters
	ts, err := parseValidUntil(r)
	if err != nil {
		http.Error(w, fmt.Sprintf("invalid %q parameter: %v", queryParamValidUntil, err), http.StatusUnauthorized)
		return types.PublicKey{}, false
	}
	pk, err := parseCredential(r)
	if err != nil {
		http.Error(w, fmt.Sprintf("invalid %q parameter: %v", queryParamCredential, err), http.StatusUnauthorized)
		return types.PublicKey{}, false
	}
	sig, err := parseSignature(r)
	if err != nil {
		http.Error(w, fmt.Sprintf("invalid %q parameter: %v", queryParamSignature, err), http.StatusUnauthorized)
		return types.PublicKey{}, false
	}
	sf, err := parseFenceParam(r)
	if err != nil {
		http.Error(w, fmt.Sprintf("invalid %q parameter: %v", queryParamFence, err), http.StatusBadRequest)
		return types.PublicKey{}, false
	}
	cas, err := parseCASParams(r, sf != nil)
	if err != nil {
		http.Error(w, fmt.Sprintf("invalid v4 parameters: %v", err), http.StatusBadRequest)
		return types.PublicKey{}, false
	}
	hash := requestHash(r.Method, hostname, r.URL.Path, ts, buf)
	if sf != nil && cas != nil {
		hash = v4RequestHash(r.Method, hostname, r.URL.Path, ts, buf, *sf, cas)
	} else if sf != nil {
		hash = fencedRequestHash(r.Method, hostname, r.URL.Path, ts, buf, *sf)
	}

	// check for expiration and verify the signature
	if ts.Before(time.Now().UTC()) || !pk.VerifyHash(hash, sig) {
		http.Error(w, fmt.Sprintf("invalid signature for %q host %q", r.Method, filepath.Join(hostname, r.URL.Path)), http.StatusUnauthorized)
		return types.PublicKey{}, false
	}
	if cas != nil {
		// the server computes the operation digest from the AUTHENTICATED request; the store compares it under the
		// account lock (G-C2 interface section 3)
		cas.Digest = opDigest(r.Method, hostname, r.URL.Path, buf, *sf, cas)
		*r = *r.WithContext(context.WithValue(r.Context(), casContextKey{}, cas))
	}
	return pk, true
}

// validateSignedURLAuth validates a signed URL by checking its required query
// parameters, verifying the signature and expiration, and confirming the
// account exists. If any check fails, it writes an HTTP error and returns
// false, otherwise it returns the public key and true.
func validateSignedURLAuth(jc jape.Context, hostname string, store Accounts) (types.PublicKey, bool) {
	req := jc.Request

	pk, ok := ValidateURLSignature(jc.Request, jc.ResponseWriter, hostname)
	if !ok {
		return types.PublicKey{}, false
	}

	// check if the account exists
	known, err := store.HasAccount(req.Context(), pk)
	if err != nil {
		jc.Error(ErrInternalError, http.StatusInternalServerError)
		return types.PublicKey{}, false
	} else if !known {
		jc.Error(ErrUnknownAccount, http.StatusUnauthorized)
		return types.PublicKey{}, false
	}
	return pk, true
}

// validateSharedURLAuth validates a signed URL for the shared-key API. The
// request must be signed with a sharing key's private key; the signer's public
// key must resolve to an existing, unexpired sharing key. On success it returns
// that sharing key.
func validateSharedURLAuth(jc jape.Context, hostname string, store Sharing) (sharing.Key, bool) {
	pk, ok := ValidateURLSignature(jc.Request, jc.ResponseWriter, hostname)
	if !ok {
		return sharing.Key{}, false
	}

	key, err := store.SharingKey(pk)
	if errors.Is(err, sharing.ErrSharingKeyNotFound) {
		jc.Error(sharing.ErrSharingKeyNotFound, http.StatusUnauthorized)
		return sharing.Key{}, false
	} else if err != nil {
		jc.Error(ErrInternalError, http.StatusInternalServerError)
		return sharing.Key{}, false
	}
	return key, true
}

func parseCredential(req *http.Request) (pk types.PublicKey, _ error) {
	n, err := base64.URLEncoding.Decode(pk[:], []byte(req.URL.Query().Get(queryParamCredential)))
	if err != nil {
		return types.PublicKey{}, errors.New("invalid base64 encoding for credential")
	} else if n != len(pk) {
		return types.PublicKey{}, fmt.Errorf("invalid credential length: expected %d bytes", len(pk))
	}
	return
}

func parseSignature(req *http.Request) (sig types.Signature, _ error) {
	n, err := base64.URLEncoding.Decode(sig[:], []byte(req.URL.Query().Get(queryParamSignature)))
	if err != nil {
		return types.Signature{}, errors.New("invalid base64 encoding for signature")
	} else if n != len(sig) {
		return types.Signature{}, fmt.Errorf("invalid signature length: expected %d bytes", len(sig))
	}
	return
}

func parseValidUntil(req *http.Request) (time.Time, error) {
	tsStr := req.URL.Query().Get(queryParamValidUntil)
	ts, err := strconv.ParseInt(tsStr, 10, 64)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid timestamp %q, must be a unix timestamp", queryParamValidUntil)
	}
	return time.Unix(ts, 0), nil
}

func isSignedRequest(req *http.Request) bool {
	return req.URL.Query().Has(queryParamCredential) &&
		req.URL.Query().Has(queryParamSignature) &&
		req.URL.Query().Has(queryParamValidUntil)
}

func requestHash(method string, hostname, path string, validUntil time.Time, body []byte) types.Hash256 {
	h := types.NewHasher()
	h.E.Write([]byte(method))
	h.E.Write([]byte(hostname))
	h.E.Write([]byte(path))
	h.E.WriteUint64(uint64(validUntil.Unix()))
	if body != nil {
		h.E.Write(body)
	}
	return h.Sum()
}

// parseFenceParam returns the request's fence credential: nil when the sf parameter is absent; an error when it
// occurs more than once (even with equal values) or is not exactly 96 lowercase hex characters with a canonical
// fence (FENCING PATCH).
func parseFenceParam(req *http.Request) (*accounts.Credential, error) {
	vals, ok := req.URL.Query()[queryParamFence]
	if !ok {
		return nil, nil
	} else if len(vals) != 1 {
		return nil, fmt.Errorf("must appear exactly once, got %d", len(vals))
	}
	c, err := accounts.ParseCredential(vals[0])
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// requestFence returns the (already validated) fence credential of an authenticated request, with its v4 part
// (G-C2) attached when the request carried one.
func requestFence(req *http.Request) *accounts.Credential {
	c, err := parseFenceParam(req)
	if err != nil || c == nil {
		return nil // nil: no sf (an error is unreachable: the signature check refused it)
	}
	if cas, ok := req.Context().Value(casContextKey{}).(*accounts.CASRequest); ok {
		c.CAS = cas
	}
	return c
}

type casContextKey struct{}

// parseCASParams parses the G-C2 v4 parameters: op (exactly once, 32 lowercase hex) and optional sq (at most once,
// canonical decimal below 2^63). It returns nil when op is absent; sq without op, or op without sf, is an error.
func parseCASParams(req *http.Request, hasFence bool) (*accounts.CASRequest, error) {
	q := req.URL.Query()
	ops, hasOp := q[queryParamOp]
	sqs, hasSq := q[queryParamSeq]
	switch {
	case !hasOp && !hasSq:
		return nil, nil
	case !hasOp:
		return nil, fmt.Errorf("%q requires %q", queryParamSeq, queryParamOp)
	case !hasFence:
		return nil, fmt.Errorf("%q requires %q", queryParamOp, queryParamFence)
	case len(ops) != 1:
		return nil, fmt.Errorf("%q must appear exactly once", queryParamOp)
	case hasSq && len(sqs) != 1:
		return nil, fmt.Errorf("%q must appear at most once", queryParamSeq)
	}
	op, err := accounts.ParseOpID(ops[0])
	if err != nil {
		return nil, err
	}
	cas := &accounts.CASRequest{Op: op}
	if hasSq {
		if cas.Sq, err = accounts.ParseSeq(sqs[0]); err != nil {
			return nil, err
		}
		cas.HasSq = true
	}
	return cas, nil
}

// v4RequestHash is the hash a v4 request is signed over (G-C2 interface section 2):
//
//	WriteString("indexd/fence/v4") WriteString(method) WriteString(host) WriteString(path) WriteUint64(sv)
//	Write(credential 48) WriteUint64(flags) WriteUint64(sq) Write(op 16) WriteBytes(body)
func v4RequestHash(method, hostname, path string, validUntil time.Time, body []byte, sf accounts.Credential, cas *accounts.CASRequest) types.Hash256 {
	h := types.NewHasher()
	h.E.WriteString(accounts.RequestHashDomainV4)
	h.E.WriteString(method)
	h.E.WriteString(hostname)
	h.E.WriteString(path)
	h.E.WriteUint64(uint64(validUntil.Unix()))
	cred := sf.Bytes()
	h.E.Write(cred[:])
	h.E.WriteUint64(cas.Flags())
	h.E.WriteUint64(cas.Sq)
	h.E.Write(cas.Op[:])
	h.E.WriteBytes(body)
	return h.Sum()
}

// opDigest binds the EXACT operation (G-C2 interface section 3): everything the v4 hash covers except the expiry,
// under its own domain. A retry of the identical operation re-signed with a new expiry has the same digest; the same
// op id with any other method, path (object key), body, credential, flags or sq has a different one.
func opDigest(method, hostname, path string, body []byte, sf accounts.Credential, cas *accounts.CASRequest) accounts.OpDigest {
	h := types.NewHasher()
	h.E.WriteString(accounts.OpDigestDomain)
	h.E.WriteString(method)
	h.E.WriteString(hostname)
	h.E.WriteString(path)
	cred := sf.Bytes()
	h.E.Write(cred[:])
	h.E.WriteUint64(cas.Flags())
	h.E.WriteUint64(cas.Sq)
	h.E.Write(cas.Op[:])
	h.E.WriteBytes(body)
	return accounts.OpDigest(h.Sum())
}

// fencedRequestHash is the hash a request carrying the credential sf is signed over (FENCING PATCH, interface
// REVISION R5): the sia types.Encoder stream
//
//	WriteString("indexd/fence/v3") WriteString(method) WriteString(hostname) WriteString(path) WriteUint64(sv)
//	Write(credential, 48 bytes) WriteBytes(body)
//
// Every variable-length field is length-prefixed, and the stream starts with u64le(15), which no 0.6.0 request hash
// input can start with (it starts with the raw method). So a fenced request's signature never verifies for an
// unfenced request, nor for another fenced request. The earlier raw form ("indexd/fence/v2" || credential appended
// after the raw body) let a captured fenced request be replayed as an unfenced one; that replay succeeds wherever
// the account has no fence: after an account delete, prune and re-registration, or a restore from a backup taken
// before the first raise (TestFenceHashV2ReplayAfterFenceLoss).
func fencedRequestHash(method, hostname, path string, validUntil time.Time, body []byte, sf accounts.Credential) types.Hash256 {
	h := types.NewHasher()
	h.E.WriteString(fenceHashDomain)
	h.E.WriteString(method)
	h.E.WriteString(hostname)
	h.E.WriteString(path)
	h.E.WriteUint64(uint64(validUntil.Unix()))
	cred := sf.Bytes()
	h.E.Write(cred[:])
	h.E.WriteBytes(body)
	return h.Sum()
}

func preAuthorizationHash(ephemeralKey types.PublicKey, request RegisterAppRequest) types.Hash256 {
	h := types.NewHasher()
	h.E.WriteString("indexd/preauthorize-app/v1")
	ephemeralKey.EncodeTo(h.E)
	request.AppID.EncodeTo(h.E)
	h.E.WriteString(request.Name)
	h.E.WriteString(request.Description)
	h.E.WriteString(request.LogoURL)
	h.E.WriteString(request.ServiceURL)
	h.E.WriteString(request.CallbackURL)
	request.PreAuthorizedKey.EncodeTo(h.E)
	return h.Sum()
}

func registerAppKeyHash(ephemeralKey types.PublicKey, requestID string) types.Hash256 {
	h := types.NewHasher()
	h.E.Write([]byte("registerAppKey"))
	h.E.Write(ephemeralKey[:])
	h.E.Write([]byte(requestID))
	return h.Sum()
}
