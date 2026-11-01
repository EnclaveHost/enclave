//go:build linux && amd64

// Fixed namespace PID1, not an ordinary host command. The measured monitor
// supplies the original contract and held capabilities; no arguments exist.
package main

import (
	"enclave.host/isolation/m3/rpcservice"
	"os"
)

func main() { os.Exit(rpcservice.EnterInherited()) }
