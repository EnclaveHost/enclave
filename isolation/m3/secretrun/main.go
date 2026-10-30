// secretrun waits for the front's authenticated release over an inherited pipe.
// It is measured platform code, quiet, unprivileged, and under the app seccomp filter.
package main

import (
	"enclave.host/isolation/m2/appconfig"
	"enclave.host/isolation/m2/shieldconfig"
	"encoding/json"
	"io"
	"os"
	"sort"
	"strings"
	"syscall"
)

func main() {
	if run() != nil {
		os.Exit(125)
	}
}
func run() error {
	p := os.NewFile(7, "secret-pipe")
	b, e := io.ReadAll(io.LimitReader(p, 65537))
	p.Close()
	if e != nil {
		return e
	}
	if len(b) > 65536 {
		return syscall.E2BIG
	}
	var all map[string]string
	if e = json.Unmarshal(b, &all); e != nil {
		return e
	}
	// The front's pipe carries the owner's secrets AND the front's own release facts (storage writer fencing: the two
	// reserved ENCLAVE_ names, appconfig.SplitFacts). Each set is validated by its own rule: an owner secret still may never
	// use the ENCLAVE_ prefix, and a fact must be one of the two names with a strictly formed value.
	// The encrypted volumes' plane (m2/front encvol.go): three reserved names the front adds after it started the plane,
	// taken out BEFORE the owner's secrets and the facts are judged (an owner secret may never be an ENCLAVE_ name).
	enc, e := takeEnc(all, encMarker, encRoot)
	if e != nil {
		return e
	}
	env, facts := appconfig.SplitFacts(all)
	if e = shieldconfig.Validate(env); e != nil {
		return e
	}
	if e = appconfig.ValidateFacts(facts); e != nil {
		return e
	}
	cfg, e := os.ReadFile("/app.config")
	if e != nil {
		return e
	}
	resolved, e := appconfig.ResolveWithFacts(string(cfg), env, facts)
	if e != nil {
		return e
	}
	if len(resolved) > appconfig.EnvMaxBytes {
		return syscall.E2BIG
	}
	args := append([]string(nil), os.Args[1:]...)
	if len(args) < 2 || args[0] != "/plat/rt/ld-linux-x86-64.so.2" || args[len(args)-1] != "/app.wasm" {
		return syscall.EINVAL
	}
	// A public-web domain (the monitor's root-owned marker, from the measured config) reaches the internet through
	// the front's SOCKS front: the runtime is told where, as ENCLAVE_EGRESS (ENCLAVE_ names are never a secret's).
	publicWeb, e := shieldconfig.PublicWebMarked(shieldconfig.PublicWebMarker, 0)
	if e != nil {
		return e
	}
	native := []string{"HOME=/tmp", "PATH=/plat", "ENCLAVE_CONFIG=" + resolved}
	models, e := modelEnviron(modelMarker, os.LookupEnv)
	if e != nil {
		return e
	}
	native = append(native, models...)
	names := make([]string, 0, len(env))
	for k := range env {
		names = append(names, k)
	}
	sort.Strings(names)
	artifact := args[len(args)-1]
	args = args[:len(args)-1]
	for _, k := range names {
		native = append(native, k+"="+env[k])
		args = append(args, "--env", k)
	}
	// the facts are also in the app's environment (sia-s3 resolves a "$NAME" config value from its own environment)
	for _, k := range []string{appconfig.FactInstanceIsolation, appconfig.FactWriterAuthority} {
		if v, ok := facts[k]; ok {
			native = append(native, k+"="+v)
			args = append(args, "--env", k)
		}
	}
	if publicWeb {
		native = append(native, shieldconfig.PublicWebEgressEnv)
		args = append(args, "--env", "ENCLAVE_EGRESS")
	}
	// live preopens of the staged volumes, and where to unlock them; values ride the environment, never argv
	for _, n := range enc.names {
		args = append(args, "--dir", encRoot+"/"+n+"::/enc/"+n)
	}
	if len(enc.names) > 0 {
		native = append(native, "ENCLAVE_ENC="+strings.Join(enc.names, ","), "ENCLAVE_ENC_API="+enc.api, "ENCLAVE_ENC_TOKEN="+enc.token)
		args = append(args, "--env", "ENCLAVE_ENC", "--env", "ENCLAVE_ENC_API", "--env", "ENCLAVE_ENC_TOKEN")
	}
	args = append(args, artifact)
	for i := range b {
		b[i] = 0
	}
	return syscall.Exec(args[0], args, native)
}
