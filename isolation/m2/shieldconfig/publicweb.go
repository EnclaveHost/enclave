package shieldconfig

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"syscall"
)

// Public web egress for a Shield SECRET domain (m2/egress web.go). The monitor writes PublicWebMarker, root's and
// read-only, when the domain's MEASURED config says "egress": "public-web"; domexec then lets the front bind the DNS
// port, and secretrun gives the runtime PublicWebEgressEnv. The front derives the same mode from the same measured
// config and refuses to start egress if the marker disagrees.
const (
	PublicWebMarker = "/egress.public-web"
	// PublicWebEgressEnv is the SOCKS5 front the runtime dials (egress.PublicSOCKSAddress). The user/password pair is
	// framing for clients that only speak RFC 1929, not authentication: only this domain can reach its loopback.
	PublicWebEgressEnv = "ENCLAVE_EGRESS=socks5://guest:public-web@127.0.0.2:1080"
	// PublicWebResolv is the domain's /etc/resolv.conf: the front's DNS stub (egress.PublicDNSAddress), over TCP.
	PublicWebResolv = "nameserver 127.0.0.2\noptions use-vc timeout:10 attempts:2\n"
)

// PublicWebMode: the MEASURED (unresolved) config's top-level "egress" is exactly "public-web". The monitor, the front
// and secretrun all decide from these same bytes, so a secret can never switch the mode.
func PublicWebMode(measuredConfig string) bool {
	if strings.TrimSpace(measuredConfig) == "" {
		return false
	}
	var doc map[string]json.RawMessage
	if json.Unmarshal([]byte(measuredConfig), &doc) != nil {
		return false
	}
	var mode string
	return json.Unmarshal(doc["egress"], &mode) == nil && mode == "public-web"
}

// PublicWebMarked says whether the marker exists. Absent is false; present must be a regular file of `owner`'s that
// nobody may write, and anything else is an error (the caller fails closed).
func PublicWebMarked(path string, owner int) (bool, error) {
	st, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !st.Mode().IsRegular() || !ok || int(sys.Uid) != owner || st.Mode().Perm()&0o222 != 0 {
		return false, errors.New("the public web marker is not a read-only file of the monitor's")
	}
	return true, nil
}
