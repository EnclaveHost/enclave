package app

// FENCING PATCH (work/indexd-fencing-implementation-interface.txt): writer fence endpoints and the commit-ordered
// sequence listing.

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	proto "go.sia.tech/core/rhp/v4"
	"go.sia.tech/core/types"
	"go.sia.tech/indexd/accounts"
	"go.sia.tech/indexd/api"
	"go.sia.tech/indexd/slabs"
	"go.sia.tech/jape"
)

// writeFenced answers a fence refusal: 409 with the installed fence (null: none), as JSON. It reports whether err
// was one.
func writeFenced(jc jape.Context, err error) bool {
	var fe *accounts.FencedError
	if !errors.As(err, &fe) {
		return false
	}
	writeJSONStatus(jc, http.StatusConflict, FencedResponse{Fence: fe.Current})
	return true
}

func writeJSONStatus(jc jape.Context, status int, v any) {
	buf, err := json.Marshal(v)
	if err != nil {
		http.Error(jc.ResponseWriter, "failed to encode response", http.StatusInternalServerError)
		return
	}
	jc.ResponseWriter.Header().Set(contentTypeHeader, applicationJSON)
	jc.ResponseWriter.WriteHeader(status)
	jc.ResponseWriter.Write(buf)
}

func (a *app) handleGETFence(jc jape.Context, pk types.PublicKey) {
	st, err := a.slabs.AccountFence(jc.Request.Context(), proto.Account(pk))
	if errors.Is(err, accounts.ErrNotFound) {
		jc.Error(err, http.StatusNotFound)
		return
	} else if err != nil {
		jc.Error(err, http.StatusInternalServerError)
		return
	}
	jc.Encode(st)
}

func (a *app) handlePOSTFence(jc jape.Context, pk types.PublicKey) {
	buf, err := io.ReadAll(jc.Request.Body)
	if err != nil {
		http.Error(jc.ResponseWriter, "failed to read request body", http.StatusBadRequest)
		return
	}
	var req struct {
		Fence *string `json:"fence"`
	}
	if err := json.Unmarshal(buf, &req); err != nil || req.Fence == nil {
		http.Error(jc.ResponseWriter, "body must be {\"fence\": \"<64 lowercase hex>\"}", http.StatusBadRequest)
		return
	}
	f, err := accounts.ParseFence(*req.Fence)
	if err != nil {
		jc.Error(err, http.StatusBadRequest)
		return
	}
	receipt, head, err := a.slabs.RaiseFence(jc.Request.Context(), proto.Account(pk), f)
	if writeFenced(jc, err) {
		return
	} else if errors.Is(err, accounts.ErrNotFound) {
		jc.Error(err, http.StatusNotFound)
		return
	} else if errors.Is(err, accounts.ErrNonCanonicalFence) {
		jc.Error(err, http.StatusBadRequest)
		return
	} else if err != nil {
		jc.Error(err, http.StatusInternalServerError)
		return
	}
	jc.Encode(RaiseFenceResponse{Fence: f, Receipt: receipt, Seq: head})
}

func (a *app) handleGETSeqObjects(jc jape.Context, pk types.PublicKey) {
	q := jc.Request.URL.Query()
	after, limit := uint64(0), slabsMaxSeqLimit
	if v, ok := q["after"]; ok {
		n, err := strconv.ParseUint(v[0], 10, 63)
		if err != nil || len(v) != 1 {
			http.Error(jc.ResponseWriter, "after must be one unsigned integer below 2^63", http.StatusBadRequest)
			return
		}
		after = n
	}
	if v, ok := q["limit"]; ok {
		n, err := strconv.Atoi(v[0])
		if err != nil || len(v) != 1 || n < 1 || n > slabsMaxSeqLimit {
			http.Error(jc.ResponseWriter, "limit must be one integer in 1-1000", http.StatusBadRequest)
			return
		}
		limit = n
	}
	listing, err := a.slabs.ListObjectsSeq(jc.Request.Context(), proto.Account(pk), after, limit)
	if errors.Is(err, accounts.ErrSeqNotEnabled) {
		writeJSONStatus(jc, http.StatusConflict, FenceResponse{})
		return
	} else if errors.Is(err, slabs.ErrInvalidSeqListing) {
		jc.Error(err, http.StatusBadRequest)
		return
	} else if errors.Is(err, accounts.ErrNotFound) {
		jc.Error(err, http.StatusNotFound)
		return
	} else if err != nil {
		jc.Error(err, http.StatusInternalServerError)
		return
	}
	encodeResponse(jc, listing)
}

// handleGETCurrentObjects lists the account's current objects in key order (PATCH U1): unlike the object feed, an
// acknowledged pin is listed at once. With blocked=true, blocked objects are listed flagged instead of left out.
func (a *app) handleGETCurrentObjects(jc jape.Context, pk types.PublicKey) {
	_, limit, ok := api.ParseOffsetLimit(jc)
	if !ok {
		return
	}
	var after types.Hash256
	if jc.DecodeForm("after", &after) != nil {
		return
	}
	var includeBlocked bool
	if jc.DecodeForm("blocked", &includeBlocked) != nil {
		return
	}
	objs, err := a.slabs.ListCurrentObjects(jc.Request.Context(), proto.Account(pk), after, limit, includeBlocked)
	if err != nil {
		jc.Error(err, http.StatusInternalServerError)
		return
	}
	encodeResponse(jc, objs)
}

// slabsMaxSeqLimit is the largest page of the sequence listing (persist/postgres.MaxSeqListLimit).
const slabsMaxSeqLimit = 1000
