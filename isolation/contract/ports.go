package contract

import (
	"fmt"
	"strconv"
	"strings"
)

// ValidatePorts defines the V3 destination allowlist. Sorting and canonical
// decimal spelling keep a destination set from having multiple identities.
// HTTP is already named separately and cannot be exposed a second way.
func ValidatePorts(ports []string, world string, httpPort int) error {
	if len(ports) == 0 {
		return nil
	}
	if world != WorldCLI || len(ports) > 32 {
		return fmt.Errorf("tunnel ports require wasi:cli and at most 32 destinations")
	}
	previous := ""
	for _, p := range ports {
		proto, raw, ok := strings.Cut(p, ":")
		n, err := strconv.Atoi(raw)
		if !ok || (proto != "tcp" && proto != "udp") || err != nil || n < 1 || n > MaxHTTPPort || strconv.Itoa(n) != raw || p <= previous {
			return fmt.Errorf("noncanonical tunnel destination %q", p)
		}
		if proto == "tcp" && n == httpPort {
			return fmt.Errorf("HTTP port cannot also be a TCP tunnel destination")
		}
		previous = p
	}
	return nil
}
