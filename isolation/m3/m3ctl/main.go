// m3ctl: the host side of an M3 guest's control channel (isolation/m3/PLAN.md). It loads an app into a
// running monitor guest, lists what is loaded, and destroys a domain at lease end.
//
// The host chooses which bytes to send. It cannot choose what the monitor then says the app is: the
// monitor hashes what it received and every report for that domain names that hash.
//
// usage:
//
// EVERY FLAG COMES BEFORE THE SUBCOMMAND. Go's flag package stops parsing at the first non-flag argument,
// so `m3ctl -cid N destroy -id 1` parsed -cid, took `destroy` as the subcommand, and left `-id 1` unparsed -
// which meant -id kept its default of 0 and the command silently destroyed DOMAIN 0 instead of domain 1.
// That was found by the Windows lane against a live guest. A flag after the subcommand is now refused with
// the correct ordering shown, because the failure mode is destroying the wrong tenant's domain quietly.
//
// usage:
//
//	m3ctl -cid N [-port 9000] [-label A] [-cpu 100] [-mem 256] load <app.wasm>
//	m3ctl -cid N [-port 9000] list
//	m3ctl -cid N [-port 9000] state
//	m3ctl -cid N [-port 9000] -probe load <app.wasm>      (the measured adversary, for isolation tests)
//	m3ctl -cid N [-port 9000] -id 1 stop                  (graceful: signal the front, let it wind down)
//	m3ctl -cid N [-port 9000] -id 1 destroy
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/vsock"
)

func main() {
	cid := flag.Uint("cid", 0, "the guest's vsock CID")
	port := flag.Uint("port", 9000, "the monitor's control port")
	label := flag.String("label", "", "a name for the domain, for the harness")
	cpu := flag.Int("cpu", 100, "the domain's share of one CPU, in percent")
	mem := flag.Int("mem", 256, "the domain's memory cap, in MiB")
	id := flag.Int("id", 0, "the domain to stop or destroy")
	boot := flag.String("boot", "", "the boot nonce from the domain's load answer (stop and destroy need it: ids restart at 1 on a reboot)")
	probe := flag.Bool("probe", false, "run the measured adversary probe as this domain's workload")
	bundle := flag.Bool("bundle", false, "wrap the artifact in a contract bundle (label + policy in the manifest) before loading, so its ID covers the manifest")
	flag.Parse()
	args := flag.Args()
	// A flag after the subcommand was never parsed, so it silently took its default. For -id that meant
	// acting on domain 0 - someone else's domain - so this refuses rather than guessing.
	if bad := misplacedFlag(args); bad != "" {
		fmt.Fprintf(os.Stderr, "m3ctl: %s came after the subcommand, where flags are not parsed: it would have been IGNORED and its default used.\n", bad)
		fmt.Fprintf(os.Stderr, "       put every flag before the subcommand: m3ctl -cid N %s %s\n", bad, strings.Join(withoutFlags(args), " "))
		os.Exit(2)
	}
	if *cid == 0 || len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: m3ctl -cid N [-port 9000] [-id N -boot B] [-label A] [-cpu 100] [-mem 256] [-probe] [-bundle] <load <app.wasm> | list | state | stop | destroy>")
		os.Exit(2)
	}

	c, err := vsock.Dial(uint32(*cid), uint32(*port))
	die(err)
	defer c.Close()
	enc, br := json.NewEncoder(c), bufio.NewReader(c)

	switch args[0] {
	case "load":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "load needs an app path")
			os.Exit(2)
		}
		app, err := os.ReadFile(args[1])
		die(err)
		if *bundle {
			app, err = contract.Build(contract.Manifest{ABI: contract.ABI, Label: *label, World: "wasi:http",
				Artifact: contract.Artifact{Kind: "wasm-component"}, Policy: contract.Policy{CPUPercent: *cpu, MemMiB: *mem, Vcpus: 1}}, app)
			die(err)
		}
		die(enc.Encode(map[string]any{"cmd": "load", "label": *label, "size": len(app), "cpu": *cpu,
			"mem": *mem, "probe": *probe}))
		_, err = c.Write(app)
		die(err)
	case "list":
		die(enc.Encode(map[string]any{"cmd": "list"}))
	case "state":
		die(enc.Encode(map[string]any{"cmd": "state"}))
	case "stop":
		die(enc.Encode(map[string]any{"cmd": "stop", "id": *id, "boot": *boot}))
	case "destroy":
		die(enc.Encode(map[string]any{"cmd": "destroy", "id": *id, "boot": *boot}))
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", args[0])
		os.Exit(2)
	}

	line, err := br.ReadBytes('\n')
	die(err)
	os.Stdout.Write(line)
	var answer struct{ Error string }
	if json.Unmarshal(line, &answer) == nil && answer.Error != "" {
		os.Exit(1)
	}
}

func die(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "m3ctl:", err)
		os.Exit(1)
	}
}

// misplacedFlag returns the first leftover argument that looks like a flag, or "". Anything starting with
// "-" among the positionals is one: flag.Parse stopped before it, so it was never applied, and a caller who
// wrote it meant it to take effect.
func misplacedFlag(args []string) string {
	for _, a := range args {
		if len(a) > 1 && strings.HasPrefix(a, "-") {
			return a
		}
	}
	return ""
}

// withoutFlags is what the subcommand part should have been, for the corrected line in the error.
func withoutFlags(args []string) []string {
	var out []string
	skip := false
	for _, a := range args {
		if skip {
			skip = false
			continue
		}
		if len(a) > 1 && strings.HasPrefix(a, "-") {
			// "-id 1": the value that followed it is part of the flag, not a positional
			if !strings.Contains(a, "=") {
				skip = true
			}
			continue
		}
		out = append(out, a)
	}
	return out
}
