//go:build linux && amd64

package rpcstorage

import (
	"errors"
	"os"
	"strings"

	"enclave.host/isolation/m2/bootstrap"
	"enclave.host/isolation/m3/rpcservice"
)

// AuthorizeBrokerRequest is the broker's authentication step, before acquiring
// or passing any writable descriptor. The Authorization must come from the
// broker's own Reader.Authorize on its actual loaded identity. No public host
// manifest or reply flag can construct it. This function alone does not arm the
// independent guardian, journal an exclusive writer or implement the broker.
func AuthorizeBrokerRequest(a *bootstrap.Authorization, bundle []byte, r Request, signatures []byte, originalClock *os.File) (*bootstrap.RPCStorageConsent, error) {
	if err := r.Validate(); err != nil {
		return nil, err
	}
	origin, err := rpcservice.OriginalEntryOrigin(originalClock)
	if err != nil {
		return nil, err
	}
	if r.Origin != origin {
		return nil, errors.New("storage request reset the original sealed origin")
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return nil, err
	}
	if r.Boot != strings.TrimSpace(string(boot)) {
		return nil, errors.New("storage request belongs to another kernel boot")
	}
	consent, err := a.VerifyRPCStorage(bundle, r, signatures)
	if err != nil {
		return nil, err
	}
	now, err := rpcservice.MonotonicNow()
	if err != nil {
		return nil, err
	}
	if now < r.Origin || now >= r.Deadline {
		return nil, errors.New("storage consent outside original window")
	}
	return consent, nil
}

// BeginBrokerAttempt combines actual owner/storage consent and persistent
// consumption. A returned intent must remain held on all later failures.
// It deliberately does not expose a descriptor-grant operation: that requires
// the independent export guardian and actual storage owner fence, still pending.
func BeginBrokerAttempt(a *bootstrap.Authorization, bundle []byte, r Request, signatures []byte, originalClock, journal *os.File) (*BrokerIntent, error) {
	consent, err := AuthorizeBrokerRequest(a, bundle, r, signatures, originalClock)
	if err != nil {
		return nil, err
	}
	intent, err := ReserveBrokerIntent(consent, r, journal)
	if err != nil {
		return intent, err
	}
	now, err := rpcservice.MonotonicNow()
	if err != nil {
		return intent, err
	}
	if now >= r.Deadline || !consent.Matches(r) {
		return intent, errors.New("authorization lost during persistent reservation; retained")
	}
	return intent, nil
}
