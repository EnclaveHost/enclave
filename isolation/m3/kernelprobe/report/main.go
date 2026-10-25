// This diagnostic image has no app, owner credential or network listener. Its
// public console output checks two fresh bindings through the guest TPM. A
// verifier must separately authenticate the VBS report and expected boot digest.
package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"

	"enclave.host/isolation/m3/vtpmclient"
)

func run() error {
	c, err := vtpmclient.Open("/dev/tpm0")
	if err != nil {
		return err
	}
	for i := 0; i < 2; i++ {
		binding := make([]byte, 64)
		if _, err := rand.Read(binding); err != nil {
			return err
		}
		report, err := c.Report(binding)
		if err != nil {
			return err
		}
		line, err := json.Marshal(map[string]any{
			"schema": "kvm-box-kernel-probe-report/1", "index": i,
			"binding": hex.EncodeToString(binding), "report": base64.StdEncoding.EncodeToString(report),
			"bindingChecked": true, "hardwareChainVerified": false,
		})
		if err != nil {
			return err
		}
		fmt.Println(string(line))
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "KVMBOX_KERNEL_PROBE TPM_ERROR %v\n", err)
		os.Exit(1)
	}
}
