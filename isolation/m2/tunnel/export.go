// Package tunnel is the guest side of protected app ports (isolation/m4/PROTECTED-PORTS.md): HTTP/1.1 upgrades on
// Prefix{tcp|udp}/{port}, protocol enclave-port/1, to ports the measured image declares on the guest's own loopback.
// The per-app guest front (isolation/m2/front) and the whole-VM front (isolation/m2/vmfront) serve the same code.
package tunnel

// Prefix is the path every tunnel request starts with.
const Prefix = tunnelPrefix

// Tunnels serves tunnel requests for one guest; it is an http.Handler.
type Tunnels = portTunnels

// Load reads the measured ports file (one "tcp:N" or "udp:N" a line; absent means no ports) and refuses a list the
// catalog contract would refuse. httpPort is the app's HTTP port, which is never tunnelled.
func Load(path string, httpPort int) (*Tunnels, error) { return loadPortTunnels(path, httpPort) }
