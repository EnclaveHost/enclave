// m3ctl: the host side of an M3 guest's control channel (isolation/m3/PLAN.md). It loads an app into a
// running monitor guest, lists what is loaded, and destroys a domain at lease end.
//
// The host chooses which bytes to send. It cannot choose what the monitor then says the app is: the
// monitor hashes what it received and every report for that domain names that hash.
//
// usage:
//
//	m3ctl -cid N [-port 9000] load <app.wasm> [-label A] [-cpu 100] [-mem 256]
//	m3ctl -cid N [-port 9000] list
//	m3ctl -cid N [-port 9000] state
//	m3ctl -cid N [-port 9000] load <app.wasm> -probe      (the measured adversary, for isolation tests)
//	m3ctl -cid N [-port 9000] stop -id 1                  (graceful: signal the front, let it wind down)
//	m3ctl -cid N [-port 9000] destroy -id 1
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"enclave.host/isolation/m2/vsock"
)

func main() {
	cid := flag.Uint("cid", 0, "the guest's vsock CID")
	port := flag.Uint("port", 9000, "the monitor's control port")
	label := flag.String("label", "", "a name for the domain, for the harness")
	cpu := flag.Int("cpu", 100, "the domain's share of one CPU, in percent")
	mem := flag.Int("mem", 256, "the domain's memory cap, in MiB")
	id := flag.Int("id", 0, "the domain to stop or destroy")
	probe := flag.Bool("probe", false, "run the measured adversary probe as this domain's workload")
	flag.Parse()
	args := flag.Args()
	if *cid == 0 || len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: m3ctl -cid N [-port 9000] load <app.wasm> | list | state | stop -id N | destroy -id N")
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
		die(enc.Encode(map[string]any{"cmd": "load", "label": *label, "size": len(app), "cpu": *cpu,
			"mem": *mem, "probe": *probe}))
		_, err = c.Write(app)
		die(err)
	case "list":
		die(enc.Encode(map[string]any{"cmd": "list"}))
	case "state":
		die(enc.Encode(map[string]any{"cmd": "state"}))
	case "stop":
		die(enc.Encode(map[string]any{"cmd": "stop", "id": *id}))
	case "destroy":
		die(enc.Encode(map[string]any{"cmd": "destroy", "id": *id}))
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
