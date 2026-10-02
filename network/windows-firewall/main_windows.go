//go:build windows

// Circuit-specific persistent WFP policy. No shared executable path is allowed:
// private copies of node.exe and enclave-tuna.exe identify exactly one circuit.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/tailscale/wf"
	"golang.org/x/sys/windows"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type Program struct {
	Path    string   `json:"path"`
	Connect []string `json:"connect"`
	Listen  []uint16 `json:"listen"`
}
type Config struct {
	AppContainer bool      `json:"appContainer"`
	Directory    string    `json:"directory"`
	Programs     []Program `json:"programs"`
}
type Manifest struct {
	AppContainerSID string   `json:"appContainerSid,omitempty"`
	Sublayer        string   `json:"sublayer"`
	Rules           []string `json:"rules"`
	Programs        []string `json:"programs"`
	State           string   `json:"state"`
}

func check(e error) {
	if e != nil {
		panic(e)
	}
}
func guid() windows.GUID { g, e := windows.GenerateGUID(); check(e); return g }
func main() {
	if len(os.Args) == 3 && os.Args[1] == "remove" {
		removeCircuit(os.Args[2])
		return
	}
	if len(os.Args) == 3 && os.Args[1] == "sandbox" {
		sandbox(os.Args[2])
		return
	}
	if len(os.Args) != 3 || os.Args[1] != "install" {
		panic("usage: enclave-circuit-firewall.exe install <config.json>")
	}
	b, e := os.ReadFile(os.Args[2])
	check(e)
	var cfg Config
	check(json.Unmarshal(b, &cfg))
	if !filepath.IsAbs(cfg.Directory) || len(cfg.Programs) < 1 || len(cfg.Programs) > 4 {
		panic("private circuit directory required")
	}
	dir := strings.ToLower(filepath.Clean(cfg.Directory))
	if !strings.Contains(dir, `\enclave-circuit-`) {
		panic("directory must be dedicated to one circuit")
	}
	seen := map[string]bool{}
	ids := []string{}
	for _, p := range cfg.Programs {
		name := strings.ToLower(filepath.Clean(p.Path))
		if !filepath.IsAbs(p.Path) || filepath.Dir(name) != dir || seen[name] {
			panic("only private executable copies in the circuit directory are allowed")
		}
		seen[name] = true
		if filepath.Ext(name) != ".exe" || len(p.Connect) > 16 || len(p.Listen) > 16 {
			panic("invalid program policy")
		}
		info, e := os.Lstat(p.Path)
		check(e)
		if !info.Mode().IsRegular() {
			panic("regular executable required")
		}
		id, e := wf.AppID(p.Path)
		check(e)
		ids = append(ids, id)
		for _, address := range p.Connect {
			a, e := netip.ParseAddrPort(address)
			if e != nil || !a.Addr().Is4() || !a.Addr().IsLoopback() || a.Port() == 0 {
				panic("only explicit IPv4 loopback circuit ports may be connected")
			}
		}
		for _, port := range p.Listen {
			if port == 0 {
				panic("explicit listener ports required")
			}
		}
	}
	session, e := wf.New(&wf.Options{Name: "Enclave guarded circuit", Dynamic: false})
	check(e)
	defer session.Close()
	layer := wf.SublayerID(guid())
	manifest := Manifest{Sublayer: layer.String(), State: "installing"}
	var packageSID *windows.SID
	if cfg.AppContainer {
		if !regexp.MustCompile(`^enclave-circuit-[a-f0-9]{32}$`).MatchString(filepath.Base(dir)) {
			panic("exact sandbox directory required")
		}
		packageSID = appProfile("Enclave.Circuit." + strings.TrimPrefix(filepath.Base(dir), "enclave-circuit-"))
		defer windows.FreeSid(packageSID)
		manifest.AppContainerSID = packageSID.String()
	}
	for _, p := range cfg.Programs {
		manifest.Programs = append(manifest.Programs, p.Path)
	}
	manifestFile := filepath.Join(cfg.Directory, "firewall.json")
	f, e := os.OpenFile(manifestFile, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	check(e)
	check(json.NewEncoder(f).Encode(manifest))
	check(f.Sync())
	check(f.Close())
	persist := func() {
		b, e := json.MarshalIndent(manifest, "", "  ")
		check(e)
		f, e := os.OpenFile(manifestFile, os.O_WRONLY|os.O_TRUNC, 0600)
		check(e)
		_, e = f.Write(b)
		check(e)
		check(f.Sync())
		check(f.Close())
	}
	check(session.AddSublayer(&wf.Sublayer{ID: layer, Name: "Enclave circuit " + filepath.Base(cfg.Directory), Persistent: true, Weight: 0xffff}))
	add := func(app int, l wf.LayerID, action wf.Action, weight uint64, matches ...*wf.Match) {
		id := wf.RuleID(guid())
		manifest.Rules = append(manifest.Rules, id.String())
		persist()
		conditions := []*wf.Match{}
		if app >= 0 {
			conditions = append(conditions, &wf.Match{Field: wf.FieldALEAppID, Op: wf.MatchTypeEqual, Value: ids[app]})
		}
		if packageSID != nil && (app < 0 || action == wf.ActionPermit) {
			conditions = append(conditions, &wf.Match{Field: wf.FieldALEPackageID, Op: wf.MatchTypeEqual, Value: packageSID})
		}
		conditions = append(conditions, matches...)
		check(session.AddRule(&wf.Rule{ID: id, Name: "Enclave circuit policy", Layer: l, Sublayer: layer, Weight: weight, Action: action, HardAction: action == wf.ActionBlock, Persistent: true, Conditions: conditions}))
	}
	match := func(field wf.FieldID, value interface{}) *wf.Match {
		return &wf.Match{Field: field, Op: wf.MatchTypeEqual, Value: value}
	}
	// Install every block before permits. The manager starts no worker until
	// this command succeeds. Failures leave a closed policy, including crashes.
	for i := range cfg.Programs {
		for _, l := range []wf.LayerID{wf.LayerALEAuthConnectV4, wf.LayerALEAuthConnectV6, wf.LayerALEAuthRecvAcceptV4, wf.LayerALEAuthRecvAcceptV6} {
			add(i, l, wf.ActionBlock, 1)
		}
	}
	if packageSID != nil {
		for _, l := range []wf.LayerID{wf.LayerALEAuthConnectV4, wf.LayerALEAuthConnectV6, wf.LayerALEAuthRecvAcceptV4, wf.LayerALEAuthRecvAcceptV6} {
			add(-1, l, wf.ActionBlock, 1)
		}
	}
	for i, p := range cfg.Programs {
		for _, address := range p.Connect {
			a := netip.MustParseAddrPort(address)
			add(i, wf.LayerALEAuthConnectV4, wf.ActionPermit, 100, match(wf.FieldIPRemoteAddress, a.Addr()), match(wf.FieldIPRemotePort, a.Port()), match(wf.FieldIPProtocol, wf.IPProtoTCP))
		}
		for _, port := range p.Listen {
			add(i, wf.LayerALEAuthRecvAcceptV4, wf.ActionPermit, 100, match(wf.FieldIPLocalAddress, netip.MustParseAddr("127.0.0.1")), match(wf.FieldIPRemoteAddress, netip.MustParseAddr("127.0.0.1")), match(wf.FieldIPLocalPort, port), match(wf.FieldIPProtocol, wf.IPProtoTCP))
		}
	}
	rules, e := session.Rules()
	check(e)
	found := map[string]bool{}
	for _, r := range rules {
		if r.Sublayer == layer && r.Persistent && !r.Disabled {
			found[r.ID.String()] = true
		}
	}
	for _, id := range manifest.Rules {
		if !found[id] {
			check(errors.New("installed rule verification failed"))
		}
	}
	manifest.State = "active"
	persist()
	fmt.Println(`{"type":"ready","persistent":true}`)
}
