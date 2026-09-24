package main

import "testing"

func TestTheLoadNameMustBeAnAppZoneName(t *testing.T) {
	for _, ok := range []string{"4e62e60d.app.enclave.host", "0ddbd824.app.test"} {
		if !certNameOK(ok) {
			t.Errorf("%q refused", ok)
		}
	}
	for _, bad := range []string{"", "4E62E60D.app.enclave.host", "4e62e60d", "4e62e60d.", "4e62e60d..host",
		"4e62e60d.-bad.host", "4e62e60d.app.enclave.host/", "4e62e60d.app enclave.host", "xyz12345.app.enclave.host"} {
		if certNameOK(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
}
