// resolve: print a config with its $NAME / ${NAME} placeholders resolved from a secrets FILE.
//
//	resolve <config.json> <secrets.json>
//
// A harness tool for the per-app guest's config assembly (package appconfig): the secrets come from a file, never an
// argument, so no secret value is ever in an argv. The in-guest delivery client calls appconfig.Resolve directly.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"enclave.host/isolation/m2/appconfig"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: resolve <config.json> <secrets.json>")
		os.Exit(2)
	}
	cfg, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, "resolve:", err)
		os.Exit(1)
	}
	raw, err := os.ReadFile(os.Args[2])
	if err != nil {
		fmt.Fprintln(os.Stderr, "resolve:", err)
		os.Exit(1)
	}
	var secrets map[string]string
	if err := json.Unmarshal(raw, &secrets); err != nil {
		fmt.Fprintln(os.Stderr, "resolve: the secrets file is not a JSON object of NAME: value")
		os.Exit(1)
	}
	out, err := appconfig.Resolve(string(cfg), secrets)
	if err != nil {
		fmt.Fprintln(os.Stderr, "resolve:", err) // names a secret, never its value
		os.Exit(1)
	}
	fmt.Print(out)
}
