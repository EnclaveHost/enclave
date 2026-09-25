package contract

// The control protocol a host launcher speaks to a monitor: one JSON object per line; `load` is
// followed by exactly Size bytes (a bundle, or a bare artifact). The host chooses WHAT to load; the
// monitor decides what it is called (AppID of the bytes it received).
//
//	{"cmd":"load","label":"A","size":N,"cpu":100,"mem":256,"probe":false}  + N bytes
//	{"cmd":"list"} | {"cmd":"state"} | {"cmd":"stop","id":N,"boot":B} | {"cmd":"destroy","id":N,"boot":B}
//
// Answers: {"id":N,"boot":B,"label":..,"appSha256":..,"port":..,...} for load, {"error":".."} on refusal.
// B is the monitor's per-boot nonce (32 hex). Ids restart at 1 when the guest reboots, so stop and destroy
// name (boot, id): a missing boot is refused ("bootRequired":true), and another boot's answers
// {"rebooted":true,"boot":<current>}, touching nothing. list and state carry "boot" too.
type Request struct {
	Cmd    string `json:"cmd"`
	Label  string `json:"label,omitempty"`
	Size   int    `json:"size,omitempty"`
	CPU    int    `json:"cpu,omitempty"`
	MemMiB int    `json:"mem,omitempty"`
	ID     int    `json:"id,omitempty"`
	Boot   string `json:"boot,omitempty"`
	Probe  bool   `json:"probe,omitempty"`
}

// Commands every backend must implement, in the order a lease uses them.
var Commands = []string{"load", "list", "state", "stop", "destroy"}

// EffectivePolicy resolves a domain's share: the bundle's manifest wins when the bytes were a bundle;
// otherwise the request's numbers; otherwise the defaults. Identical on every backend, so the same
// bundle gets the same share wherever it runs.
func EffectivePolicy(m *Manifest, req Request) Policy {
	p := Policy{CPUPercent: 100, MemMiB: 256, Vcpus: 1}
	if m != nil {
		if m.Policy.CPUPercent > 0 {
			p.CPUPercent = m.Policy.CPUPercent
		}
		if m.Policy.MemMiB > 0 {
			p.MemMiB = m.Policy.MemMiB
		}
		if m.Policy.Vcpus > 0 {
			p.Vcpus = m.Policy.Vcpus
		}
		return p
	}
	if req.CPU > 0 {
		p.CPUPercent = req.CPU
	}
	if req.MemMiB > 0 {
		p.MemMiB = req.MemMiB
	}
	return p
}
