package bootstrap

// Owner-authorized log history sources (work/storage-front-cold-history-interface.txt). A relay-free guest that
// cold-starts under a long-held lease must read EVERY lease log from the lease's claim to the finalized head: rev 16d
// keeps no claim marker in state, so nothing else proves that no later claim (a same-runner release+reclaim included)
// exists. Public measured RPCs serve recent logs only. The owner can therefore name log-capable sources in the startup
// package whose SHA-256 the owner commits on chain (guestBootstrap), so the host can neither add, drop nor change one.
// A source serves LOGS and block hashes only, and only after it reports the measured quorum's agreed block hash. The
// snapshot, the row and finality stay the measured quorum's alone.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

const MaxHistoryRPCs = 6

// leaseAttemptTimeout bounds one writer-authority attempt (leasegen.go); its completed steps are kept, so the next attempt
// resumes where it ended. A variable for tests.
var leaseAttemptTimeout = 5 * time.Minute

type History struct {
	RPCs []string `json:"rpcs"`
}

// historyField validates the optional member as it appears in the exact package bytes (raw).
func historyField(raw []byte, h *History) error {
	var top map[string]json.RawMessage
	if e := json.Unmarshal(raw, &top); e != nil {
		return errors.New("invalid startup package JSON")
	}
	member, present := top["history"]
	if !present {
		return nil
	}
	if h == nil || noNull(member) != nil {
		return errors.New("owner history must be an object without nulls")
	}
	return h.Validate()
}

func (h *History) Validate() error {
	if h == nil || len(h.RPCs) < 1 || len(h.RPCs) > MaxHistoryRPCs {
		return fmt.Errorf("owner history needs 1 to %d RPCs", MaxHistoryRPCs)
	}
	seen := map[string]bool{}
	for _, raw := range h.RPCs {
		host, ok := historyURL(raw)
		if !ok {
			return errors.New("owner history RPC must be an https URL on port 443 with a host and no credentials or fragment")
		}
		if seen[host] {
			return errors.New("owner history RPC hosts must be distinct")
		}
		seen[host] = true
	}
	return nil
}

// historyURL: an https origin (port 443) with a well-formed host and an optional path and query, printable ASCII,
// <= 512 bytes. -> the canonical host (rpcHost).
func historyURL(raw string) (string, bool) {
	if len(raw) == 0 || len(raw) > 512 {
		return "", false
	}
	for i := 0; i < len(raw); i++ {
		if raw[i] <= 0x20 || raw[i] >= 0x7f {
			return "", false
		}
	}
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.Opaque != "" || u.User != nil || u.Fragment != "" || u.Hostname() == "" || (u.Port() != "" && u.Port() != "443") {
		return "", false
	}
	return rpcHost(u.Hostname())
}

// operatorOf: who runs a source, for counting independent answers. The last two DNS labels (gateway.tenderly.co and
// base.gateway.tenderly.co are one operator); an IP literal is its address. Errs strict: a multi-label public suffix
// (x.co.uk) merges more than it should, never less.
func operatorOf(host string) string {
	if _, e := netip.ParseAddr(host); e == nil {
		return host
	}
	l := strings.Split(host, ".")
	if len(l) <= 2 {
		return host
	}
	return strings.Join(l[len(l)-2:], ".")
}

// historySources: the endpoints of an authorized package's history RPCs (not already a measured peer), each admitted
// to the guest's dial allowlist. Their answers count only once anchored (admitHistory).
func (r *Reader) historySources(h *History) []endpoint {
	if r == nil || h == nil {
		return nil
	}
	measured := map[string]bool{}
	for _, p := range r.peers {
		measured[p.name] = true
	}
	var out []endpoint
	for _, raw := range h.RPCs {
		host, ok := historyURL(raw)
		if !ok || measured[host] {
			continue
		}
		if r.allow != nil {
			r.allow(net.JoinHostPort(host, "443"))
		}
		out = append(out, rpcEndpoint(host, raw, r.client))
	}
	return out
}

// admitHistory: the history sources that, for THIS snapshot, report Base's chain id and the measured quorum's agreed
// block hash at the agreed block number. A source that answers otherwise (another chain, another fork) is out of this
// attempt; one that could not be reached is out too, but its operator is returned as UNREACHED: an outage may end, so
// it never turns a read into history_unavailable on its own (the read retries within the startup window).
func (r *Reader) admitHistory(ctx context.Context, s snapshot, sources []endpoint) ([]endpoint, map[string]bool) {
	tag := fmt.Sprintf("0x%x", s.number)
	var in []endpoint
	unreached := map[string]bool{}
	for _, p := range sources {
		var chain string
		var b block
		if p.call(ctx, "eth_chainId", []any{}, &chain) != nil {
			unreached[operatorOf(p.name)] = true
			continue
		}
		if id, e := quantity(chain); e != nil || id != r.chainID {
			continue
		}
		if e := p.call(ctx, "eth_getBlockByNumber", []any{tag, false}, &b); e != nil {
			unreached[operatorOf(p.name)] = true
			continue
		}
		if strings.ToLower(b.Hash) != s.hash {
			continue
		}
		in = append(in, p)
	}
	return in, unreached
}
