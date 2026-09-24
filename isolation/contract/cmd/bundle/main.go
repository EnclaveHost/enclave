// bundle: build or inspect a contract bundle on any host.
//
//	bundle build -label A [-world wasi:http] [-kind wasm-component] [-cpu 100] [-mem 256] [-vcpus 1] <artifact> <out.bundle>
//	bundle id <file>          the app ID of a bundle or a bare artifact (sha256 of all its bytes)
//	bundle show <bundle>      the manifest and artifact hash
package main

import (
	"encoding/hex"
	"flag"
	"fmt"
	"os"

	"enclave.host/isolation/contract"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: bundle build|id|show ...")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "build":
		fs := flag.NewFlagSet("build", flag.ExitOnError)
		label := fs.String("label", "", "label")
		world := fs.String("world", "wasi:http", "world")
		httpPort := fs.Int("http", 0, "wasi:cli only: the port the app serves HTTP on")
		kind := fs.String("kind", "wasm-component", "artifact kind")
		cpu := fs.Int("cpu", 100, "cpu percent")
		mem := fs.Int("mem", 256, "memory MiB")
		vcpus := fs.Int("vcpus", 1, "vcpus")
		fs.Parse(os.Args[2:])
		if fs.NArg() != 2 {
			fmt.Fprintln(os.Stderr, "build needs <artifact> <out>")
			os.Exit(2)
		}
		art, err := os.ReadFile(fs.Arg(0))
		die(err)
		b, err := contract.Build(contract.Manifest{ABI: contract.ABI, Label: *label, World: *world, HTTP: *httpPort,
			Artifact: contract.Artifact{Kind: *kind}, Policy: contract.Policy{CPUPercent: *cpu, MemMiB: *mem, Vcpus: *vcpus}}, art)
		die(err)
		die(os.WriteFile(fs.Arg(1), b, 0o644))
		id := contract.AppID(b)
		fmt.Printf("%s %d bytes app_id=%s\n", fs.Arg(1), len(b), hex.EncodeToString(id[:]))
	case "id":
		b, err := os.ReadFile(os.Args[2])
		die(err)
		id := contract.AppID(b)
		fmt.Println(hex.EncodeToString(id[:]))
	case "show":
		b, err := os.ReadFile(os.Args[2])
		die(err)
		m, art, err := contract.Parse(b)
		die(err)
		id := contract.AppID(b)
		fmt.Printf("app_id=%s artifact=%d bytes sha256=%s\nmanifest=%+v\n", hex.EncodeToString(id[:]), len(art), m.Artifact.Sha256, m)
	// extract: write the artifact out, for a backend that has to hand the bytes to a runtime. Additive; the
	// bundle format, the AppID and the ABI are untouched. isolation/m4 uses it to build one measured guest
	// per app: the bundle's own bytes go into the image (so the AppID's preimage is measured) and the
	// artifact is what wasmtime runs.
	// mode: how a domain runs this bundle, from its own manifest: "serve" (the runtime serves a wasi:http component)
	// or "run <port>" (a wasi:cli command that serves HTTP on <port>). isolation/m4/assemble-app-image.sh writes it
	// into the measured image for the domain's init.
	case "mode":
		b, err := os.ReadFile(os.Args[2])
		die(err)
		m, _, err := contract.Parse(b)
		die(err)
		if m.World == contract.WorldCLI {
			fmt.Printf("run %d\n", m.HTTP)
		} else {
			fmt.Println("serve")
		}
	case "extract":
		if len(os.Args) < 4 {
			fmt.Fprintln(os.Stderr, "usage: bundle extract BUNDLE OUT")
			os.Exit(2)
		}
		b, err := os.ReadFile(os.Args[2])
		die(err)
		_, art, err := contract.Parse(b)
		die(err)
		die(os.WriteFile(os.Args[3], art, 0o644))
	default:
		fmt.Fprintln(os.Stderr, "unknown command")
		os.Exit(2)
	}
}

func die(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "bundle:", err)
		os.Exit(1)
	}
}
